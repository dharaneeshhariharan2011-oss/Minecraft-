import { isRole, type Role } from './roles.js';
import { isValidJoinCode } from './joinCode.js';

/** Bump when the wire format changes incompatibly. */
export const PROTOCOL_VERSION = 1;

export const MAX_NAME_LENGTH = 16;
export const MAX_CHAT_LENGTH = 200;
export const MAX_PAYLOAD_BYTES = 256 * 1024;

export interface RosterEntry {
  playerId: string;
  name: string;
  role: Role;
}

/** Game-state messages carried over WebRTC data channels or the WebSocket relay. */
export type GameMessage =
  | { t: 'pos'; dim: string; x: number; y: number; z: number; yaw: number; pitch: number; anim?: string }
  | { t: 'blockEdit'; dim: string; x: number; y: number; z: number; id: number; state: number }
  | { t: 'blockUpdate'; dim: string; x: number; y: number; z: number; id: number; state: number; by: string }
  | { t: 'worldSync'; seed: number; dim: string; edits: BlockEdit[] }
  | { t: 'chat'; name: string; text: string }
  | { t: 'anim'; name: string }
  | { t: 'mobs'; dim: string; list: MobSnapshot[] }
  | { t: 'hurt'; target: string; amount: number }
  | { t: 'players'; list: PlayerSnapshot[] };

/** Host-broadcast positions of every player in the session (the host includes itself). */
export interface PlayerSnapshot {
  id: string;
  name: string;
  role: string;
  dim: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

/** Host-simulated mob state broadcast to clients for rendering. */
export interface MobSnapshot {
  id: string;
  type: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
}

export interface BlockEdit {
  dim: string;
  x: number;
  y: number;
  z: number;
  id: number;
  state: number;
}

export type RtcPayload =
  | { kind: 'offer' | 'answer'; sdp: string }
  | { kind: 'ice'; candidate: unknown };

export type ClientMessage =
  | { type: 'host'; name: string; protocol: number; accountId: string }
  | { type: 'join'; code: string; name: string; protocol: number; accountId: string }
  | { type: 'resume'; code: string; playerId: string }
  | { type: 'proof'; proof: string }
  | { type: 'rtc'; to: string; payload: RtcPayload }
  | { type: 'relay'; to: string; payload: GameMessage }
  | { type: 'admin'; action: 'kick' | 'ban' | 'unban' | 'setRole'; target: string; role?: Role }
  | { type: 'chat'; text: string }
  | { type: 'ping'; t: number }
  | { type: 'leave' };

export type ServerMessage =
  | { type: 'hosted'; code: string; playerId: string; sessionToken: string; role: Role; roster: RosterEntry[] }
  | { type: 'joined'; code: string; playerId: string; sessionToken: string; role: Role; hostId: string; roster: RosterEntry[] }
  | { type: 'challenge'; nonce: string }
  | { type: 'resumed'; code: string; playerId: string; role: Role; hostId: string; roster: RosterEntry[] }
  | { type: 'error'; code: string; message: string }
  | { type: 'roster'; roster: RosterEntry[]; hostId: string }
  | { type: 'rtc'; from: string; payload: RtcPayload }
  | { type: 'relay'; from: string; payload: GameMessage }
  | { type: 'chat'; from: string; name: string; text: string }
  | { type: 'removed'; reason: 'kicked' | 'banned' | 'closed' }
  | { type: 'pong'; t: number };

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(o: Obj, key: string, max = 256): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length > max) throw new ProtocolError(`invalid ${key}`);
  return v;
}

function num(o: Obj, key: string, min = -Infinity, max = Infinity): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new ProtocolError(`invalid ${key}`);
  }
  return v;
}

function int(o: Obj, key: string, min = -Infinity, max = Infinity): number {
  const v = num(o, key, min, max);
  if (!Number.isInteger(v)) throw new ProtocolError(`invalid ${key}`);
  return v;
}

export function sanitizeName(raw: string): string {
  // Keep printable characters only, trim, and cap the length.
  const cleaned = raw.replace(/[^\p{L}\p{N}_ .-]/gu, '').trim().slice(0, MAX_NAME_LENGTH);
  return cleaned.length > 0 ? cleaned : 'Player';
}

/** Stable per-browser identity used to remember bans and roles across reconnects. */
function accountId(o: Obj): string {
  const v = str(o, 'accountId', 64);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(v)) throw new ProtocolError('invalid accountId');
  return v;
}

/** Validates a game payload received over a WebRTC data channel. */
export function parseGameMessage(raw: unknown): GameMessage {
  return parseGame(raw);
}

function parseGame(v: unknown): GameMessage {
  if (!isObj(v)) throw new ProtocolError('invalid game payload');
  switch (v.t) {
    case 'pos':
      return {
        t: 'pos',
        dim: str(v, 'dim', 32),
        x: num(v, 'x'),
        y: num(v, 'y'),
        z: num(v, 'z'),
        yaw: num(v, 'yaw'),
        pitch: num(v, 'pitch', -90, 90),
        ...(v.anim !== undefined ? { anim: str(v, 'anim', 32) } : {}),
      };
    case 'blockEdit':
    case 'blockUpdate': {
      const base = {
        dim: str(v, 'dim', 32),
        x: int(v, 'x'),
        y: int(v, 'y', 0, 255),
        z: int(v, 'z'),
        id: int(v, 'id', 0, 65535),
        state: int(v, 'state', 0, 255),
      };
      if (v.t === 'blockEdit') return { t: 'blockEdit', ...base };
      return { t: 'blockUpdate', ...base, by: str(v, 'by', 64) };
    }
    case 'worldSync': {
      if (!Array.isArray(v.edits) || v.edits.length > 50_000) throw new ProtocolError('invalid edits');
      const edits = v.edits.map((e) => parseGame({ ...(isObj(e) ? e : {}), t: 'blockEdit' }));
      return {
        t: 'worldSync',
        seed: int(v, 'seed', 0, 0xffffffff),
        dim: str(v, 'dim', 32),
        edits: edits.filter((e): e is Extract<GameMessage, { t: 'blockEdit' }> => e.t === 'blockEdit'),
      };
    }
    case 'chat':
      return { t: 'chat', name: sanitizeName(str(v, 'name', 64)), text: str(v, 'text', MAX_CHAT_LENGTH) };
    case 'anim':
      return { t: 'anim', name: str(v, 'name', 32) };
    case 'mobs': {
      if (!Array.isArray(v.list) || v.list.length > 256) throw new ProtocolError('invalid mobs');
      const list = v.list.map((m): MobSnapshot => {
        if (!isObj(m)) throw new ProtocolError('invalid mob');
        return {
          id: str(m, 'id', 64),
          type: str(m, 'type', 64),
          x: num(m, 'x'),
          y: num(m, 'y'),
          z: num(m, 'z'),
          yaw: num(m, 'yaw'),
          hp: num(m, 'hp', 0, 1024),
        };
      });
      return { t: 'mobs', dim: str(v, 'dim', 32), list };
    }
    case 'hurt':
      return { t: 'hurt', target: str(v, 'target', 64), amount: num(v, 'amount', 0, 1000) };
    case 'players': {
      if (!Array.isArray(v.list) || v.list.length > 16) throw new ProtocolError('invalid players');
      const list = v.list.map((p): PlayerSnapshot => {
        if (!isObj(p)) throw new ProtocolError('invalid player');
        return {
          id: str(p, 'id', 64),
          name: str(p, 'name', 32),
          role: str(p, 'role', 16),
          dim: str(p, 'dim', 32),
          x: num(p, 'x'),
          y: num(p, 'y'),
          z: num(p, 'z'),
          yaw: num(p, 'yaw'),
          pitch: num(p, 'pitch', -90, 90),
        };
      });
      return { t: 'players', list };
    }
    default:
      throw new ProtocolError('unknown game message');
  }
}

function parseRtc(v: unknown): RtcPayload {
  if (!isObj(v)) throw new ProtocolError('invalid rtc payload');
  if (v.kind === 'offer' || v.kind === 'answer') {
    return { kind: v.kind, sdp: str(v, 'sdp', 16_384) };
  }
  if (v.kind === 'ice') {
    if (v.candidate === undefined || v.candidate === null) throw new ProtocolError('invalid candidate');
    return { kind: 'ice', candidate: v.candidate };
  }
  throw new ProtocolError('invalid rtc kind');
}

/** Parses and validates a message sent by a client. Throws ProtocolError on anything unexpected. */
export function parseClientMessage(raw: string | Buffer): ClientMessage {
  const text = raw.toString();
  if (text.length > MAX_PAYLOAD_BYTES) throw new ProtocolError('message too large');
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new ProtocolError('malformed JSON');
  }
  if (!isObj(v) || typeof v.type !== 'string') throw new ProtocolError('missing type');
  switch (v.type) {
    case 'host':
      return {
        type: 'host',
        name: sanitizeName(str(v, 'name', 64)),
        protocol: int(v, 'protocol', 0, 1000),
        accountId: accountId(v),
      };
    case 'join': {
      if (!isValidJoinCode(v.code)) throw new ProtocolError('invalid join code');
      return {
        type: 'join',
        code: v.code,
        name: sanitizeName(str(v, 'name', 64)),
        protocol: int(v, 'protocol', 0, 1000),
        accountId: accountId(v),
      };
    }
    case 'resume': {
      if (!isValidJoinCode(v.code)) throw new ProtocolError('invalid join code');
      return { type: 'resume', code: v.code, playerId: str(v, 'playerId', 64) };
    }
    case 'proof':
      return { type: 'proof', proof: str(v, 'proof', 128) };
    case 'rtc':
      return { type: 'rtc', to: str(v, 'to', 64), payload: parseRtc(v.payload) };
    case 'relay':
      return { type: 'relay', to: str(v, 'to', 64), payload: parseGame(v.payload) };
    case 'admin': {
      const action = v.action;
      if (action !== 'kick' && action !== 'ban' && action !== 'unban' && action !== 'setRole') {
        throw new ProtocolError('invalid admin action');
      }
      const role = v.role === undefined ? undefined : v.role;
      if (action === 'setRole' && !isRole(role)) throw new ProtocolError('invalid role');
      return {
        type: 'admin',
        action,
        target: str(v, 'target', 64),
        ...(action === 'setRole' ? { role: role as Role } : {}),
      };
    }
    case 'chat':
      return { type: 'chat', text: str(v, 'text', MAX_CHAT_LENGTH) };
    case 'ping':
      return { type: 'ping', t: num(v, 't') };
    case 'leave':
      return { type: 'leave' };
    default:
      throw new ProtocolError(`unknown message type ${v.type}`);
  }
}

/** Parses a server → client message (used by the browser client and tests). */
export function parseServerMessage(raw: string): ServerMessage {
  if (raw.length > MAX_PAYLOAD_BYTES) throw new ProtocolError('message too large');
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new ProtocolError('malformed JSON');
  }
  if (!isObj(v) || typeof v.type !== 'string') throw new ProtocolError('missing type');
  // Trust structure from our own server but reject obviously invalid envelopes.
  switch (v.type) {
    case 'challenge':
      return { type: 'challenge', nonce: str(v, 'nonce', 128) };
    case 'error':
      return { type: 'error', code: str(v, 'code', 64), message: str(v, 'message', 512) };
    case 'relay':
      return { type: 'relay', from: str(v, 'from', 64), payload: parseGame(v.payload) };
    case 'rtc':
      return { type: 'rtc', from: str(v, 'from', 64), payload: parseRtc(v.payload) };
    case 'pong':
      return { type: 'pong', t: num(v, 't') };
    case 'chat':
      return { type: 'chat', from: str(v, 'from', 64), name: str(v, 'name', 64), text: str(v, 'text', MAX_CHAT_LENGTH) };
    default:
      return v as unknown as ServerMessage;
  }
}
