import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createSignalingServer, type SignalingServer } from '../../server/signaling/server.js';
import { RoomManager } from '../../server/signaling/rooms.js';
import { parseServerMessage } from '../../shared/protocols/messages.js';
import type { ClientMessage, ServerMessage } from '../../shared/protocols/messages.js';
import { computeProof } from '../../shared/protocols/session.js';

/** Thin test client over a real WebSocket with an inbox so tests can await specific messages. */
class TestClient {
  readonly inbox: ServerMessage[] = [];
  private waiters: Array<{ match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
  private ws!: WebSocket;
  closed: Promise<number>;
  accountId: string;

  constructor(
    private readonly url: string,
    accountId: string,
  ) {
    this.accountId = accountId;
    this.closed = Promise.resolve(0);
  }

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.url);
    this.closed = new Promise((resolve) => this.ws.once('close', (code) => resolve(code)));
    this.ws.on('message', (raw) => {
      const msg = parseServerMessage(raw.toString());
      this.inbox.push(msg);
      for (const w of [...this.waiters]) {
        if (w.match(msg)) {
          this.waiters = this.waiters.filter((x) => x !== w);
          w.resolve(msg);
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  send(msg: ClientMessage | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  wait<T extends ServerMessage['type']>(type: T, timeout = 3000): Promise<Extract<ServerMessage, { type: T }>> {
    return this.waitFor((m) => m.type === type, timeout) as Promise<Extract<ServerMessage, { type: T }>>;
  }

  waitFor(match: (m: ServerMessage) => boolean, timeout = 3000): Promise<ServerMessage> {
    const existing = this.inbox.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for message')), timeout);
      this.waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
      });
    });
  }

  /** Waits for an error message with a specific code. */
  waitError(code: string): Promise<Extract<ServerMessage, { type: 'error' }>> {
    return this.waitFor((m) => m.type === 'error' && m.code === code) as Promise<Extract<ServerMessage, { type: 'error' }>>;
  }

  close(): void {
    this.ws.close();
  }
}

const ACCOUNT_A = 'account-aaaa-1111';
const ACCOUNT_B = 'account-bbbb-2222';
const ACCOUNT_C = 'account-cccc-3333';

let server: SignalingServer;
const clients: TestClient[] = [];

async function newClient(accountId: string): Promise<TestClient> {
  const c = new TestClient(server.url(), accountId);
  await c.connect();
  clients.push(c);
  return c;
}

async function host(name = 'Alex'): Promise<{ client: TestClient; code: string; playerId: string; sessionToken: string }> {
  const client = await newClient(ACCOUNT_A);
  client.send({ type: 'host', name, protocol: 1, accountId: ACCOUNT_A });
  const hosted = await client.wait('hosted');
  return { client, code: hosted.code, playerId: hosted.playerId, sessionToken: hosted.sessionToken };
}

beforeEach(async () => {
  server = await createSignalingServer({ port: 0, host: '127.0.0.1', heartbeatMs: 60_000 });
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await server.close();
});

describe('signalling server: hosting and joining', () => {
  it('hosting returns a six-digit join code and host role', async () => {
    const { code, client } = await host();
    expect(code).toMatch(/^\d{6}$/);
    expect(server.rooms.getRoom(code)).toBeDefined();
    client.close();
  });

  it('a friend joins with the code and everyone sees the roster', async () => {
    const h = await host('Alex');
    const friend = await newClient(ACCOUNT_B);
    friend.send({ type: 'join', code: h.code, name: 'Sam', protocol: 1, accountId: ACCOUNT_B });
    const joined = await friend.wait('joined');
    expect(joined.role).toBe('member');
    expect(joined.roster.map((r) => r.name).sort()).toEqual(['Alex', 'Sam']);
    expect(joined.hostId).toBe(h.playerId);
    const roster = await h.client.waitFor((m) => m.type === 'roster' && m.roster.length === 2);
    expect(roster.type).toBe('roster');
  });

  it('rejects an unknown join code', async () => {
    const c = await newClient(ACCOUNT_B);
    c.send({ type: 'join', code: '000000', name: 'Nobody', protocol: 1, accountId: ACCOUNT_B });
    const err = await c.waitError('room_not_found');
    expect(err.code).toBe('room_not_found');
  });

  it('rejects malformed join codes before touching room state', async () => {
    const c = await newClient(ACCOUNT_B);
    c.send({ type: 'join', code: '12ab56', name: 'x', protocol: 1, accountId: ACCOUNT_B });
    const err = await c.waitError('bad_request');
    expect(err.message).toMatch(/join code/);
  });

  it('enforces the room capacity', async () => {
    const rooms = new RoomManager({ maxPlayers: 2 });
    await server.close();
    server = await createSignalingServer({ port: 0, host: '127.0.0.1', rooms, heartbeatMs: 60_000 });
    const h = await host('Host');
    const a = await newClient(ACCOUNT_B);
    a.send({ type: 'join', code: h.code, name: 'A', protocol: 1, accountId: ACCOUNT_B });
    await a.wait('joined');
    const b = await newClient(ACCOUNT_C);
    b.send({ type: 'join', code: h.code, name: 'B', protocol: 1, accountId: ACCOUNT_C });
    const err = await b.waitError('room_full');
    expect(err.code).toBe('room_full');
  });
});

describe('signalling server: session token handshake', () => {
  it('resumes a session with a valid proof and rejects a bad proof', async () => {
    const h = await host('Alex');
    const friend = await newClient(ACCOUNT_B);
    friend.send({ type: 'join', code: h.code, name: 'Sam', protocol: 1, accountId: ACCOUNT_B });
    const joined = await friend.wait('joined');
    friend.close();
    await new Promise((r) => setTimeout(r, 50));

    // Attempt 1: a proof computed with the wrong token must be rejected.
    const attacker = await newClient(ACCOUNT_B);
    attacker.send({ type: 'resume', code: h.code, playerId: joined.playerId });
    const challenge1 = await attacker.wait('challenge');
    const forged = await computeProof('f'.repeat(64), challenge1.nonce, joined.playerId, h.code);
    attacker.send({ type: 'proof', proof: forged });
    await attacker.waitError('bad_proof');

    // Attempt 2: the genuine client gets a fresh nonce and answers with the real token.
    attacker.send({ type: 'resume', code: h.code, playerId: joined.playerId });
    const challenge2 = await attacker.waitFor((m) => m.type === 'challenge' && m.nonce !== challenge1.nonce);
    expect(challenge2.type).toBe('challenge');
    if (challenge2.type !== 'challenge') throw new Error('unreachable');
    attacker.send({ type: 'proof', proof: await computeProof(joined.sessionToken, challenge2.nonce, joined.playerId, h.code) });
    const resumed = await attacker.wait('resumed');
    expect(resumed.playerId).toBe(joined.playerId);
  });

  it('a proof replayed from an earlier challenge is refused', async () => {
    const h = await host('Alex');
    const friend = await newClient(ACCOUNT_B);
    friend.send({ type: 'join', code: h.code, name: 'Sam', protocol: 1, accountId: ACCOUNT_B });
    const joined = await friend.wait('joined');
    friend.close();
    await new Promise((r) => setTimeout(r, 50));
    const c = await newClient(ACCOUNT_B);
    c.send({ type: 'resume', code: h.code, playerId: joined.playerId });
    const old = await c.wait('challenge');
    const oldProof = await computeProof(joined.sessionToken, old.nonce, joined.playerId, h.code);
    c.send({ type: 'resume', code: h.code, playerId: joined.playerId });
    await c.waitFor((m) => m.type === 'challenge' && m.nonce !== old.nonce);
    c.send({ type: 'proof', proof: oldProof });
    await c.waitError('bad_proof');
  });

  it('a proof without a started resume is refused', async () => {
    const h = await host();
    const c = await newClient(ACCOUNT_B);
    c.send({ type: 'proof', proof: 'a'.repeat(64) });
    await c.waitError('no_challenge');
    expect(h.code).toMatch(/^\d{6}$/);
  });

  it('the host keeps its seat for the grace period and can resume', async () => {
    const h = await host('Alex');
    h.client.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(server.rooms.getRoom(h.code)).toBeDefined();
    const back = await newClient(ACCOUNT_A);
    back.send({ type: 'resume', code: h.code, playerId: h.playerId });
    const ch = await back.wait('challenge');
    back.send({ type: 'proof', proof: await computeProof(h.sessionToken, ch.nonce, h.playerId, h.code) });
    const resumed = await back.wait('resumed');
    expect(resumed.role).toBe('host');
  });
});

describe('signalling server: WebRTC signalling and relay', () => {
  it('relays SDP offers and ICE candidates between two members', async () => {
    const h = await host('Alex');
    const friend = await newClient(ACCOUNT_B);
    friend.send({ type: 'join', code: h.code, name: 'Sam', protocol: 1, accountId: ACCOUNT_B });
    const joined = await friend.wait('joined');

    h.client.send({ type: 'rtc', to: joined.playerId, payload: { kind: 'offer', sdp: 'v=0 fake offer' } });
    const offer = await friend.wait('rtc');
    expect(offer.from).toBe(h.playerId);
    expect(offer.payload).toEqual({ kind: 'offer', sdp: 'v=0 fake offer' });

    friend.send({ type: 'rtc', to: h.playerId, payload: { kind: 'ice', candidate: { candidate: 'candidate:1', sdpMid: '0' } } });
    const ice = await h.client.wait('rtc');
    expect(ice.from).toBe(joined.playerId);
    expect(ice.payload.kind).toBe('ice');
  });

  it('refuses to signal players outside the sender room', async () => {
    const h = await host();
    const other = await host('Other');
    h.client.send({ type: 'rtc', to: other.playerId, payload: { kind: 'offer', sdp: 'x' } });
    await h.client.waitError('unknown_player');
  });

  it('fallback relay delivers game messages to the requested peer', async () => {
    const h = await host('Alex');
    const friend = await newClient(ACCOUNT_B);
    friend.send({ type: 'join', code: h.code, name: 'Sam', protocol: 1, accountId: ACCOUNT_B });
    const joined = await friend.wait('joined');
    friend.send({ type: 'relay', to: h.playerId, payload: { t: 'pos', dim: 'overworld', x: 1, y: 64, z: 2, yaw: 0, pitch: 0 } });
    const got = await h.client.wait('relay');
    expect(got.from).toBe(joined.playerId);
    expect(got.payload).toMatchObject({ t: 'pos', x: 1 });
  });

  it('visitors cannot send block edits; members can', async () => {
    const h = await host('Alex');
    const visitor = await newClient(ACCOUNT_B);
    visitor.send({ type: 'join', code: h.code, name: 'Viz', protocol: 1, accountId: ACCOUNT_B });
    const vj = await visitor.wait('joined');
    h.client.send({ type: 'admin', action: 'setRole', target: vj.playerId, role: 'visitor' });
    await visitor.waitFor((m) => m.type === 'roster' && m.roster.some((r) => r.playerId === vj.playerId && r.role === 'visitor'));

    const edit = { t: 'blockEdit' as const, dim: 'overworld', x: 4, y: 64, z: 4, id: 1, state: 0 };
    visitor.send({ type: 'relay', to: h.playerId, payload: edit });
    await visitor.waitError('forbidden');

    const member = await newClient(ACCOUNT_C);
    member.send({ type: 'join', code: h.code, name: 'Mo', protocol: 1, accountId: ACCOUNT_C });
    await member.wait('joined');
    member.send({ type: 'relay', to: h.playerId, payload: edit });
    const received = await h.client.wait('relay');
    expect(received.payload).toMatchObject({ t: 'blockEdit', x: 4 });
  });

  it('only the host may broadcast authoritative block updates and world sync', async () => {
    const h = await host('Alex');
    const friend = await newClient(ACCOUNT_B);
    friend.send({ type: 'join', code: h.code, name: 'Sam', protocol: 1, accountId: ACCOUNT_B });
    await friend.wait('joined');
    friend.send({ type: 'relay', to: 'all', payload: { t: 'blockUpdate', dim: 'overworld', x: 0, y: 1, z: 0, id: 1, state: 0, by: 'x' } });
    await friend.waitError('forbidden');
    h.client.send({ type: 'relay', to: 'all', payload: { t: 'worldSync', seed: 42, dim: 'overworld', edits: [] } });
    const sync = await friend.wait('relay');
    expect(sync.payload).toMatchObject({ t: 'worldSync', seed: 42 });
  });

  it('visitors may only send presence; mob state and arbitrary payloads are refused', async () => {
    const h = await host('Alex');
    const visitor = await newClient(ACCOUNT_B);
    visitor.send({ type: 'join', code: h.code, name: 'Viz', protocol: 1, accountId: ACCOUNT_B });
    const vj = await visitor.wait('joined');
    h.client.send({ type: 'admin', action: 'setRole', target: vj.playerId, role: 'visitor' });
    await visitor.waitFor((m) => m.type === 'roster' && m.roster.some((r) => r.playerId === vj.playerId && r.role === 'visitor'));

    visitor.send({ type: 'relay', to: h.playerId, payload: { t: 'mobs', dim: 'overworld', list: [] } });
    await visitor.waitError('forbidden');
    visitor.send({ type: 'relay', to: h.playerId, payload: { t: 'hurt', target: h.playerId, amount: 5 } });
    await visitor.waitError('forbidden');
    visitor.send({ type: 'relay', to: h.playerId, payload: { t: 'chat', name: 'x', text: 'y' } });
    await visitor.waitError('bad_request');

    visitor.send({ type: 'relay', to: h.playerId, payload: { t: 'pos', dim: 'overworld', x: 1, y: 2, z: 3, yaw: 0, pitch: 0 } });
    const got = await h.client.wait('relay');
    expect(got.payload).toMatchObject({ t: 'pos', x: 1 });
  });

  it('only the host may send mob snapshots and damage', async () => {
    const h = await host('Alex');
    const friend = await newClient(ACCOUNT_B);
    friend.send({ type: 'join', code: h.code, name: 'Sam', protocol: 1, accountId: ACCOUNT_B });
    const fj = await friend.wait('joined');
    friend.send({ type: 'relay', to: fj.playerId, payload: { t: 'hurt', target: fj.playerId, amount: 99 } });
    await friend.waitError('forbidden');
  });

  it('a member cannot unban an account; the host can', async () => {
    const h = await host('Alex');
    const member = await newClient(ACCOUNT_B);
    member.send({ type: 'join', code: h.code, name: 'Mo', protocol: 1, accountId: ACCOUNT_B });
    await member.wait('joined');
    const victim = await newClient(ACCOUNT_C);
    victim.send({ type: 'join', code: h.code, name: 'Vi', protocol: 1, accountId: ACCOUNT_C });
    const vj = await victim.wait('joined');
    h.client.send({ type: 'admin', action: 'ban', target: vj.playerId });
    await victim.wait('removed');
    member.send({ type: 'admin', action: 'unban', target: ACCOUNT_C });
    await member.waitError('forbidden');
    h.client.send({ type: 'admin', action: 'unban', target: ACCOUNT_C });
    const again = await newClient(ACCOUNT_C);
    again.send({ type: 'join', code: h.code, name: 'Vi', protocol: 1, accountId: ACCOUNT_C });
    await again.wait('joined');
  });

  it('refuses a second connection for an account that is already in the session', async () => {
    const h = await host('Alex');
    const first = await newClient(ACCOUNT_B);
    first.send({ type: 'join', code: h.code, name: 'Sam', protocol: 1, accountId: ACCOUNT_B });
    await first.wait('joined');
    const second = await newClient(ACCOUNT_B);
    second.send({ type: 'join', code: h.code, name: 'Sam', protocol: 1, accountId: ACCOUNT_B });
    await second.waitError('already_connected');
  });

  it('chat is broadcast to the whole room with the sender name', async () => {
    const h = await host('Alex');
    const friend = await newClient(ACCOUNT_B);
    friend.send({ type: 'join', code: h.code, name: 'Sam', protocol: 1, accountId: ACCOUNT_B });
    await friend.wait('joined');
    friend.send({ type: 'chat', text: 'hello there' });
    const msg = await h.client.wait('chat');
    expect(msg).toMatchObject({ name: 'Sam', text: 'hello there' });
  });

  it('answers pings', async () => {
    const h = await host();
    h.client.send({ type: 'ping', t: 1234 });
    const pong = await h.client.wait('pong');
    expect(pong.t).toBe(1234);
  });

  it('rejects messages that do not match the protocol', async () => {
    const c = await newClient(ACCOUNT_A);
    c.send({ type: 'host', name: 'x', protocol: 1 });
    await c.waitError('bad_request');
    c.send({ type: 'relay', to: 'all', payload: { t: 'explode' } } as unknown as Record<string, unknown>);
    await c.waitError('bad_request');
  });
});

describe('signalling server: moderation', () => {
  it('an operator can kick a member; the kicked member is told why', async () => {
    const h = await host('Alex');
    const op = await newClient(ACCOUNT_B);
    op.send({ type: 'join', code: h.code, name: 'Sam', protocol: 1, accountId: ACCOUNT_B });
    const opJoin = await op.wait('joined');
    h.client.send({ type: 'admin', action: 'setRole', target: opJoin.playerId, role: 'operator' });
    await op.waitFor((m) => m.type === 'roster' && m.roster.some((r) => r.role === 'operator'));

    const victim = await newClient(ACCOUNT_C);
    victim.send({ type: 'join', code: h.code, name: 'Mo', protocol: 1, accountId: ACCOUNT_C });
    const vj = await victim.wait('joined');
    op.send({ type: 'admin', action: 'kick', target: vj.playerId });
    const removed = await victim.wait('removed');
    expect(removed.reason).toBe('kicked');
  });

  it('a member cannot moderate others', async () => {
    const h = await host('Alex');
    const m1 = await newClient(ACCOUNT_B);
    m1.send({ type: 'join', code: h.code, name: 'Sam', protocol: 1, accountId: ACCOUNT_B });
    await m1.wait('joined');
    const m2 = await newClient(ACCOUNT_C);
    m2.send({ type: 'join', code: h.code, name: 'Mo', protocol: 1, accountId: ACCOUNT_C });
    const j2 = await m2.wait('joined');
    m1.send({ type: 'admin', action: 'kick', target: j2.playerId });
    await m1.waitError('forbidden');
  });

  it('banned players cannot rejoin, even with a fresh connection', async () => {
    const h = await host('Alex');
    const bad = await newClient(ACCOUNT_B);
    bad.send({ type: 'join', code: h.code, name: 'Sam', protocol: 1, accountId: ACCOUNT_B });
    const bj = await bad.wait('joined');
    h.client.send({ type: 'admin', action: 'ban', target: bj.playerId });
    const removed = await bad.wait('removed');
    expect(removed.reason).toBe('banned');

    const retry = await newClient(ACCOUNT_B);
    retry.send({ type: 'join', code: h.code, name: 'Sam again', protocol: 1, accountId: ACCOUNT_B });
    await retry.waitError('banned');
  });

  it('the host can unban an account', async () => {
    const h = await host('Alex');
    const bad = await newClient(ACCOUNT_B);
    bad.send({ type: 'join', code: h.code, name: 'Sam', protocol: 1, accountId: ACCOUNT_B });
    const bj = await bad.wait('joined');
    h.client.send({ type: 'admin', action: 'ban', target: bj.playerId });
    await bad.wait('removed');
    h.client.send({ type: 'admin', action: 'unban', target: ACCOUNT_B });
    const retry = await newClient(ACCOUNT_B);
    retry.send({ type: 'join', code: h.code, name: 'Sam', protocol: 1, accountId: ACCOUNT_B });
    await retry.wait('joined');
  });

  it('closing the host connection closes the room for everyone after the grace period', async () => {
    const rooms = new RoomManager({ graceMs: 30 });
    await server.close();
    server = await createSignalingServer({ port: 0, host: '127.0.0.1', rooms, heartbeatMs: 60_000 });
    const h = await host('Alex');
    const friend = await newClient(ACCOUNT_B);
    friend.send({ type: 'join', code: h.code, name: 'Sam', protocol: 1, accountId: ACCOUNT_B });
    await friend.wait('joined');
    h.client.close();
    await new Promise((r) => setTimeout(r, 120));
    expect(server.rooms.getRoom(h.code)).toBeUndefined();
  });
});

describe('signalling server: HTTP', () => {
  it('serves a health check', async () => {
    const res = await fetch(`http://127.0.0.1:${new URL(server.url().replace('ws:', 'http:')).port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});
