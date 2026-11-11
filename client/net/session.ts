import { PROTOCOL_VERSION, parseServerMessage, type ClientMessage, type GameMessage, type RosterEntry, type RtcPayload, type ServerMessage } from '../../shared/protocols/messages.js';
import { computeProof } from '../../shared/protocols/session.js';
import type { Role } from '../../shared/protocols/roles.js';

/** What the browser remembers so a reload or network drop can resume the seat. */
export interface StoredSession {
  code: string;
  playerId: string;
  sessionToken: string;
  accountId: string;
  name: string;
}

export interface SessionInfo {
  code: string;
  playerId: string;
  role: Role;
  hostId: string;
  roster: RosterEntry[];
}

export type LinkStatus = 'offline' | 'connecting' | 'online' | 'reconnecting' | 'ended';

export interface SessionListener {
  status(status: LinkStatus, detail?: string): void;
  roster(info: SessionInfo): void;
  rtc(from: string, payload: RtcPayload): void;
  game(from: string, payload: GameMessage): void;
  chat(from: string, name: string, text: string): void;
  removed(reason: 'kicked' | 'banned' | 'closed'): void;
  error(code: string, message: string): void;
}

const STORAGE_KEY = 'mcbh.session';
const ACCOUNT_KEY = 'mcbh.account';
const MAX_RECONNECT_MS = 8000;

/** Stable per-browser account identifier (used for bans and remembered roles). */
export function accountId(): string {
  let id = localStorage.getItem(ACCOUNT_KEY);
  if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(ACCOUNT_KEY, id);
  }
  return id;
}

export function loadStoredSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

export function clearStoredSession(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

/** URL of the signaling socket. Always relative so the browser never reaches for localhost. */
export function signalingUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

/**
 * One signaling connection plus session bookkeeping. It joins or hosts a session, forwards
 * WebRTC signalling and relay traffic, and resumes the seat with the session-token proof after a drop.
 */
export class NetSession {
  private ws: WebSocket | null = null;
  private info: SessionInfo | null = null;
  private stored: StoredSession | null = null;
  private pending: { resolve: (m: ServerMessage) => void; reject: (e: Error) => void } | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private closedByUser = false;

  constructor(
    private readonly url: string,
    private readonly listener: SessionListener,
  ) {}

  get session(): SessionInfo | null {
    return this.info;
  }

  /** Creates a new session and returns its join code. */
  async host(name: string, account: string): Promise<SessionInfo> {
    await this.open();
    const reply = await this.request({ type: 'host', name, protocol: PROTOCOL_VERSION, accountId: account }, ['hosted']);
    if (reply.type !== 'hosted') throw new Error('unexpected reply');
    this.adopt(reply.code, reply.playerId, reply.sessionToken, account, name, reply.role, reply.roster, reply.playerId);
    return this.info!;
  }

  /** Joins an existing session with a six-digit code. */
  async join(code: string, name: string, account: string): Promise<SessionInfo> {
    await this.open();
    const reply = await this.request({ type: 'join', code, name, protocol: PROTOCOL_VERSION, accountId: account }, ['joined']);
    if (reply.type !== 'joined') throw new Error('unexpected reply');
    this.adopt(reply.code, reply.playerId, reply.sessionToken, account, name, reply.role, reply.roster, reply.hostId);
    return this.info!;
  }

  /** Resumes a stored seat after a page reload. Resolves to the session info, or rejects. */
  async resumeStored(stored: StoredSession): Promise<SessionInfo> {
    this.stored = stored;
    await this.open();
    return this.performResume();
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Sends a game payload to one peer over the server relay (fallback path). */
  relay(to: string, payload: GameMessage): void {
    this.send({ type: 'relay', to, payload });
  }

  rtc(to: string, payload: RtcPayload): void {
    this.send({ type: 'rtc', to, payload });
  }

  chat(text: string): void {
    this.send({ type: 'chat', text: text.slice(0, 200) });
  }

  admin(action: 'kick' | 'ban' | 'unban' | 'setRole', target: string, role?: Role): void {
    this.send({ type: 'admin', action, target, ...(role ? { role } : {}) });
  }

  /** Leaves the session cleanly and forgets the stored seat. */
  leave(): void {
    this.closedByUser = true;
    this.send({ type: 'leave' });
    this.clearRetry();
    this.ws?.close(1000, 'left');
    this.ws = null;
    this.info = null;
    clearStoredSession();
    this.listener.status('offline');
  }

  // ---------------------------------------------------------------- internals

  private adopt(code: string, playerId: string, sessionToken: string, account: string, name: string, role: Role, roster: RosterEntry[], hostId: string): void {
    this.info = { code, playerId, role, hostId, roster };
    this.stored = { code, playerId, sessionToken, accountId: account, name };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(this.stored));
    // Roster first, so listeners that render the join code see it when the status arrives.
    this.listener.roster(this.info);
    this.listener.status('online');
  }

  private open(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    this.closedByUser = false;
    this.listener.status('connecting');
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('signaling server did not respond'));
      }, 8000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('could not reach the signaling server'));
      };
      ws.onmessage = (ev) => this.onMessage(String(ev.data));
      ws.onclose = () => this.onClose(ws);
    });
  }

  /** Sends one request and waits for one of the expected replies, or an error. */
  private request(msg: ClientMessage, expect: ServerMessage['type'][]): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      this.pending = {
        resolve: (m) => {
          if (expect.includes(m.type)) resolve(m);
          else reject(new Error('unexpected reply from server'));
        },
        reject,
      };
      this.send(msg);
      setTimeout(() => {
        if (this.pending) {
          this.pending = null;
          reject(new Error('the server did not reply'));
        }
      }, 8000);
    });
  }

  private performResume(): Promise<SessionInfo> {
    const stored = this.stored!;
    return new Promise((resolve, reject) => {
      const onReply = async (m: ServerMessage) => {
        if (m.type === 'challenge') {
          const proof = await computeProof(stored.sessionToken, m.nonce, stored.playerId, stored.code);
          this.send({ type: 'proof', proof });
          return;
        }
        if (m.type === 'resumed') {
          this.info = { code: m.code, playerId: m.playerId, role: m.role, hostId: m.hostId, roster: m.roster };
          this.attempt = 0;
          this.listener.roster(this.info);
          this.listener.status('online');
          resolve(this.info);
          return;
        }
        reject(new Error(m.type === 'error' ? m.message : 'resume failed'));
      };
      this.pending = {
        resolve: (m) => void onReply(m),
        reject,
      };
      this.send({ type: 'resume', code: stored.code, playerId: stored.playerId });
    });
  }

  private onMessage(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = parseServerMessage(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'hosted':
      case 'joined':
      case 'resumed':
      case 'challenge': {
        const p = this.pending;
        if (p && (msg.type !== 'challenge' || this.stored)) {
          if (msg.type !== 'challenge') this.pending = null;
          p.resolve(msg);
        }
        return;
      }
      case 'error': {
        const p = this.pending;
        this.pending = null;
        if (p) p.reject(new Error(msg.message));
        this.listener.error(msg.code, msg.message);
        if (msg.code === 'unknown_player' || msg.code === 'bad_proof') {
          this.info = null;
          clearStoredSession();
          this.listener.status('ended', msg.message);
        }
        return;
      }
      case 'roster': {
        if (this.info) {
          this.info = { ...this.info, roster: msg.roster, hostId: msg.hostId };
          this.listener.roster(this.info);
        }
        return;
      }
      case 'rtc':
        this.listener.rtc(msg.from, msg.payload);
        return;
      case 'relay':
        this.listener.game(msg.from, msg.payload);
        return;
      case 'chat':
        this.listener.chat(msg.from, msg.name, msg.text);
        return;
      case 'removed':
        this.info = null;
        clearStoredSession();
        this.listener.removed(msg.reason);
        return;
      case 'pong':
        return;
    }
  }

  private onClose(ws: WebSocket): void {
    if (ws !== this.ws) return;
    this.ws = null;
    if (this.closedByUser || !this.info || !this.stored) {
      if (!this.info) this.listener.status('offline');
      return;
    }
    // Keep the seat: retry with backoff and resume with the session token.
    this.listener.status('reconnecting', 'connection lost, reconnecting');
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    this.clearRetry();
    const delay = Math.min(MAX_RECONNECT_MS, 500 * 2 ** this.attempt);
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open()
        .then(() => this.performResume())
        .catch(() => {
          if (this.stored && this.info) this.scheduleRetry();
        });
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
