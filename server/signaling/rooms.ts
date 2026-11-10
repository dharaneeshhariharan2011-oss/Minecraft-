import {
  canAssignRole,
  canChat,
  canEditBlocks,
  canJoin,
  canModerate,
  isRole,
  type Role,
} from '../../shared/protocols/roles.js';
import { generateJoinCode } from '../../shared/protocols/joinCode.js';
import { computeProof, createNonce, createSessionToken, verifyProof } from '../../shared/protocols/session.js';
import type { GameMessage, RosterEntry, ServerMessage, RtcPayload } from '../../shared/protocols/messages.js';
import { sanitizeName } from '../../shared/protocols/messages.js';

/** Anything that can receive server messages: a WebSocket in production, a fake in tests. */
export interface Sink {
  readonly id: string;
  send(msg: ServerMessage): void;
  close(reason?: string): void;
}

export class RoomError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RoomError';
  }
}

export interface PlayerRecord {
  playerId: string;
  accountId: string;
  name: string;
  role: Role;
  sessionToken: string;
  sink: Sink | null;
  /** When the player lost their connection; they are removed after the grace period. */
  disconnectedAt: number | null;
}

export interface Room {
  code: string;
  hostId: string;
  createdAt: number;
  players: Map<string, PlayerRecord>;
  /** Persisted roles per account, so a returning operator keeps their rank. */
  roles: Map<string, Role>;
  banned: Set<string>;
}

export interface RoomManagerOptions {
  /** How long a disconnected player may resume before being removed. */
  graceMs?: number;
  maxPlayers?: number;
  now?: () => number;
  random?: () => number;
  /** Injected for tests so reconnect windows can be simulated without real waiting. */
  schedule?: (fn: () => void, ms: number) => { cancel(): void };
}

interface Challenge {
  code: string;
  playerId: string;
  nonce: string;
  sinkId: string;
}

export interface JoinResult {
  code: string;
  playerId: string;
  sessionToken: string;
  role: Role;
  hostId: string;
  roster: RosterEntry[];
}

const DEFAULT_MAX_PLAYERS = 10;

/**
 * Authoritative room state for the signaling server: join codes, roles, bans, the session-token
 * handshake and message routing. Socket-independent so it can be tested directly.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly sinkToPlayer = new Map<string, { code: string; playerId: string }>();
  private readonly challenges = new Map<string, Challenge>();
  private readonly graceMs: number;
  private readonly maxPlayers: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly schedule: (fn: () => void, ms: number) => { cancel(): void };

  constructor(options: RoomManagerOptions = {}) {
    this.graceMs = options.graceMs ?? 60_000;
    this.maxPlayers = options.maxPlayers ?? DEFAULT_MAX_PLAYERS;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.schedule =
      options.schedule ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        return { cancel: () => clearTimeout(t) };
      });
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  /** Creates a room and makes the sink its host. Returns the join code. */
  createRoom(sink: Sink, name: string, accountId: string): JoinResult {
    this.detach(sink);
    let code = generateJoinCode(this.random);
    let attempts = 0;
    while (this.rooms.has(code)) {
      if (++attempts > 100) throw new RoomError('room_full', 'no join codes available');
      code = generateJoinCode(this.random);
    }
    const playerId = createId(this.random);
    const host: PlayerRecord = {
      playerId,
      accountId,
      name: sanitizeName(name),
      role: 'host',
      sessionToken: createSessionToken(),
      sink,
      disconnectedAt: null,
    };
    const room: Room = {
      code,
      hostId: playerId,
      createdAt: this.now(),
      players: new Map([[playerId, host]]),
      roles: new Map([[accountId, 'host']]),
      banned: new Set(),
    };
    this.rooms.set(code, room);
    this.sinkToPlayer.set(sink.id, { code, playerId });
    sink.send({
      type: 'hosted',
      code,
      playerId,
      sessionToken: host.sessionToken,
      role: 'host',
      roster: this.rosterOf(room),
    });
    return this.joinResultFor(room, host);
  }

  /** Admits a player with a join code. Throws RoomError when the room is missing, banned or full. */
  joinRoom(sink: Sink, code: string, name: string, accountId: string): JoinResult {
    this.detach(sink);
    const room = this.rooms.get(code);
    if (!room) throw new RoomError('room_not_found', 'no session with that code');
    if (room.banned.has(accountId)) throw new RoomError('banned', 'you are banned from this session');
    const remembered = room.roles.get(accountId) ?? 'member';
    if (!canJoin(remembered)) throw new RoomError('banned', 'you are banned from this session');
    // One seat per account: a connected duplicate is refused, a stale (disconnected) seat is replaced.
    for (const existing of room.players.values()) {
      if (existing.accountId !== accountId) continue;
      if (existing.sink !== null) throw new RoomError('already_connected', 'this account is already in the session');
      room.players.delete(existing.playerId);
      this.challenges.forEach((c, k) => {
        if (c.playerId === existing.playerId) this.challenges.delete(k);
      });
    }
    const online = [...room.players.values()].filter((p) => p.sink !== null || p.disconnectedAt !== null).length;
    if (online >= this.maxPlayers) throw new RoomError('room_full', 'this session is full');

    const playerId = createId(this.random);
    const player: PlayerRecord = {
      playerId,
      accountId,
      name: sanitizeName(name),
      role: remembered,
      sessionToken: createSessionToken(),
      sink,
      disconnectedAt: null,
    };
    room.players.set(playerId, player);
    room.roles.set(accountId, remembered);
    this.sinkToPlayer.set(sink.id, { code, playerId });
    const result = this.joinResultFor(room, player);
    sink.send({ type: 'joined', code, playerId, sessionToken: player.sessionToken, role: player.role, hostId: room.hostId, roster: result.roster });
    this.broadcastRoster(room, playerId);
    return result;
  }

  /** Step 1 of a resume: issues a fresh challenge nonce for a known player. */
  beginResume(sink: Sink, code: string, playerId: string): { nonce: string } {
    const room = this.rooms.get(code);
    const player = room?.players.get(playerId);
    if (!room || !player) throw new RoomError('unknown_player', 'session no longer exists');
    const nonce = createNonce();
    this.challenges.set(sink.id, { code, playerId, nonce, sinkId: sink.id });
    sink.send({ type: 'challenge', nonce });
    return { nonce };
  }

  /** Step 2 of a resume: verifies the HMAC proof computed from the session token. */
  async completeResume(sink: Sink, proof: string): Promise<JoinResult> {
    const challenge = this.challenges.get(sink.id);
    this.challenges.delete(sink.id);
    if (!challenge) throw new RoomError('no_challenge', 'resume was not started');
    const room = this.rooms.get(challenge.code);
    const player = room?.players.get(challenge.playerId);
    if (!room || !player) throw new RoomError('unknown_player', 'session no longer exists');
    const ok = await verifyProof(player.sessionToken, challenge.nonce, player.playerId, challenge.code, proof);
    if (!ok) throw new RoomError('bad_proof', 'session proof was rejected');
    if (room.banned.has(player.accountId)) throw new RoomError('banned', 'you are banned from this session');

    // Taking over an existing connection: the previous socket is told it was superseded.
    const previous = player.sink;
    if (previous && previous.id !== sink.id) {
      this.sinkToPlayer.delete(previous.id);
      previous.close('superseded');
    }
    this.detach(sink);
    player.sink = sink;
    player.disconnectedAt = null;
    this.sinkToPlayer.set(sink.id, { code: room.code, playerId: player.playerId });
    const result = this.joinResultFor(room, player);
    sink.send({
      type: 'resumed',
      code: room.code,
      playerId: player.playerId,
      role: player.role,
      hostId: room.hostId,
      roster: result.roster,
    });
    this.broadcastRoster(room, player.playerId);
    return result;
  }

  /** Called when a socket closes. Players get a grace period; the host closing ends the room. */
  disconnect(sink: Sink): void {
    this.challenges.delete(sink.id);
    const entry = this.sinkToPlayer.get(sink.id);
    if (!entry) return;
    this.sinkToPlayer.delete(sink.id);
    const room = this.rooms.get(entry.code);
    const player = room?.players.get(entry.playerId);
    if (!room || !player || player.sink?.id !== sink.id) return;
    player.sink = null;
    player.disconnectedAt = this.now();
    this.broadcastRoster(room, room.hostId);
    this.schedule(() => this.expire(room.code, player.playerId, player.disconnectedAt), this.graceMs);
  }

  private expire(code: string, playerId: string, since: number | null): void {
    const room = this.rooms.get(code);
    const player = room?.players.get(playerId);
    if (!room || !player || player.sink !== null || player.disconnectedAt !== since) return;
    if (playerId === room.hostId) {
      this.closeRoom(room, 'closed');
    } else {
      room.players.delete(playerId);
      this.broadcastRoster(room, room.hostId);
    }
  }

  /** Removes a sink from any room without grace (explicit leave or rejoin elsewhere). */
  leave(sink: Sink): void {
    const entry = this.sinkToPlayer.get(sink.id);
    if (!entry) return;
    this.sinkToPlayer.delete(sink.id);
    const room = this.rooms.get(entry.code);
    if (!room) return;
    if (entry.playerId === room.hostId) {
      this.closeRoom(room, 'closed');
      return;
    }
    room.players.delete(entry.playerId);
    this.broadcastRoster(room, room.hostId);
  }

  private detach(sink: Sink): void {
    if (this.sinkToPlayer.has(sink.id)) this.leave(sink);
  }

  private closeRoom(room: Room, reason: 'closed' | 'kicked' | 'banned'): void {
    for (const p of room.players.values()) {
      if (p.sink) {
        p.sink.send({ type: 'removed', reason });
        this.sinkToPlayer.delete(p.sink.id);
        p.sink.close('room closed');
      }
    }
    this.rooms.delete(room.code);
  }

  private playerOf(sink: Sink): { room: Room; player: PlayerRecord } {
    const entry = this.sinkToPlayer.get(sink.id);
    const room = entry ? this.rooms.get(entry.code) : undefined;
    const player = room && entry ? room.players.get(entry.playerId) : undefined;
    if (!room || !player) throw new RoomError('not_in_room', 'join a session first');
    return { room, player };
  }

  /** Routes an rtc signalling message (SDP/ICE) to another member of the same room. */
  routeRtc(sink: Sink, to: string, payload: RtcPayload): void {
    const { room, player } = this.playerOf(sink);
    const target = room.players.get(to);
    if (!target || !target.sink) throw new RoomError('unknown_player', 'that player is not connected');
    target.sink.send({ type: 'rtc', from: player.playerId, payload });
  }

  /** Routes a game message over the WebSocket fallback, enforcing permissions on the server too. */
  routeRelay(sink: Sink, to: string, payload: GameMessage): void {
    const { room, player } = this.playerOf(sink);
    let targets: PlayerRecord[];
    switch (payload.t) {
      case 'blockEdit': {
        if (!canEditBlocks(player.role)) throw new RoomError('forbidden', 'visitors cannot change blocks');
        // Block edits are always authoritative on the host.
        const host = room.players.get(room.hostId);
        if (!host?.sink) throw new RoomError('unknown_player', 'the host is not connected');
        targets = [host];
        break;
      }
      case 'blockUpdate':
      case 'worldSync': {
        if (player.playerId !== room.hostId) throw new RoomError('forbidden', 'only the host sends world state');
        targets = to === 'all' ? [...room.players.values()].filter((p) => p.playerId !== player.playerId) : [room.players.get(to)].filter((p): p is PlayerRecord => !!p);
        break;
      }
      case 'mobs':
      case 'hurt':
      case 'players': {
        // Mob and player-list simulation runs on the host only, so nobody else may inject state or damage.
        if (player.playerId !== room.hostId) throw new RoomError('forbidden', 'only the host simulates mobs');
        targets = to === 'all' ? [...room.players.values()].filter((p) => p.playerId !== player.playerId) : [room.players.get(to)].filter((p): p is PlayerRecord => !!p);
        break;
      }
      case 'pos':
      case 'anim': {
        // Presence updates are allowed for every role that may join, including visitors.
        if (!canChat(player.role)) throw new RoomError('forbidden', 'you are not allowed to send game state');
        targets = to === 'all' ? [...room.players.values()].filter((p) => p.playerId !== player.playerId) : [room.players.get(to)].filter((p): p is PlayerRecord => !!p);
        break;
      }
      default:
        throw new RoomError('bad_request', 'unsupported relay payload');
    }
    for (const t of targets) {
      if (t.sink) t.sink.send({ type: 'relay', from: player.playerId, payload });
    }
  }

  /** Broadcasts a chat line from a player (banned players cannot be connected to chat at all). */
  chat(sink: Sink, text: string): void {
    const { room, player } = this.playerOf(sink);
    if (!canChat(player.role)) throw new RoomError('forbidden', 'chat is disabled for you');
    for (const p of room.players.values()) {
      if (p.sink) p.sink.send({ type: 'chat', from: player.playerId, name: player.name, text });
    }
  }

  /** Host and operator moderation: kick, ban, unban, and role changes. */
  admin(sink: Sink, action: 'kick' | 'ban' | 'unban' | 'setRole', targetId: string, role?: Role): void {
    const { room, player: actor } = this.playerOf(sink);
    if (action === 'unban') {
      // Only the host and operators may lift a ban. Bans are keyed by account identifier.
      if (actor.role !== 'host' && actor.role !== 'operator') throw new RoomError('forbidden', 'you cannot unban players');
      room.banned.delete(targetId);
      if (room.roles.get(targetId) === 'banned') room.roles.set(targetId, 'member');
      return;
    }
    const target = room.players.get(targetId);
    if (!target) throw new RoomError('unknown_player', 'no such player');
    if (!canModerate(actor.role, target.role)) throw new RoomError('forbidden', 'you cannot moderate that player');

    switch (action) {
      case 'setRole': {
        if (!role || !isRole(role)) throw new RoomError('bad_request', 'invalid role');
        if (!canAssignRole(actor.role, role)) throw new RoomError('forbidden', 'you cannot grant that role');
        if (role === 'banned') {
          this.ban(room, target);
          return;
        }
        target.role = role;
        room.roles.set(target.accountId, role);
        this.broadcastRoster(room, room.hostId);
        break;
      }
      case 'kick': {
        room.players.delete(target.playerId);
        if (target.sink) {
          target.sink.send({ type: 'removed', reason: 'kicked' });
          this.sinkToPlayer.delete(target.sink.id);
          target.sink.close('kicked');
        }
        this.broadcastRoster(room, room.hostId);
        break;
      }
      case 'ban':
        this.ban(room, target);
        break;
    }
  }

  private ban(room: Room, target: PlayerRecord): void {
    room.banned.add(target.accountId);
    room.roles.set(target.accountId, 'banned');
    room.players.delete(target.playerId);
    if (target.sink) {
      target.sink.send({ type: 'removed', reason: 'banned' });
      this.sinkToPlayer.delete(target.sink.id);
      target.sink.close('banned');
    }
    this.broadcastRoster(room, room.hostId);
  }

  /** Current roster for a room. Disconnected players are reported as present until they expire. */
  rosterOf(room: Room): RosterEntry[] {
    return [...room.players.values()].map((p) => ({ playerId: p.playerId, name: p.name, role: p.role }));
  }

  private joinResultFor(room: Room, player: PlayerRecord): JoinResult {
    return {
      code: room.code,
      playerId: player.playerId,
      sessionToken: player.sessionToken,
      role: player.role,
      hostId: room.hostId,
      roster: this.rosterOf(room),
    };
  }

  private broadcastRoster(room: Room, _exceptId: string): void {
    const roster = this.rosterOf(room);
    for (const p of room.players.values()) {
      if (p.sink) p.sink.send({ type: 'roster', roster, hostId: room.hostId });
    }
  }

  /** Looks up a player's session proof (test helper: the proof a legitimate client would compute). */
  proofFor(code: string, playerId: string, nonce: string): Promise<string> {
    const room = this.rooms.get(code);
    const player = room?.players.get(playerId);
    if (!player) throw new RoomError('unknown_player', 'no such player');
    return computeProof(player.sessionToken, nonce, playerId, code);
  }
}

function createId(random: () => number): string {
  let out = '';
  for (let i = 0; i < 16; i++) out += Math.floor(random() * 16).toString(16);
  return out;
}
