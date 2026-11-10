import { describe, expect, it } from 'vitest';
import {
  computeProof,
  constantTimeEqual,
  createNonce,
  createSessionToken,
  verifyProof,
} from '../../shared/protocols/session.js';
import { parseClientMessage, sanitizeName } from '../../shared/protocols/messages.js';
import { generateJoinCode, isValidJoinCode, normalizeJoinCode } from '../../shared/protocols/joinCode.js';

describe('session token handshake', () => {
  it('issues 64-hex-character tokens and 32-hex-character nonces, all distinct', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => createSessionToken()));
    expect(tokens.size).toBe(50);
    for (const t of tokens) expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(createNonce()).toMatch(/^[0-9a-f]{32}$/);
    expect(createNonce()).not.toBe(createNonce());
  });

  it('accepts the proof computed from the token, nonce, player and code', async () => {
    const token = createSessionToken();
    const nonce = createNonce();
    const proof = await computeProof(token, nonce, 'player-1', '123456');
    expect(proof).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyProof(token, nonce, 'player-1', '123456', proof)).toBe(true);
  });

  it('rejects a proof for a different nonce (replay), code, player or token', async () => {
    const token = createSessionToken();
    const nonce = createNonce();
    const proof = await computeProof(token, nonce, 'player-1', '123456');
    expect(await verifyProof(token, createNonce(), 'player-1', '123456', proof)).toBe(false);
    expect(await verifyProof(token, nonce, 'player-1', '654321', proof)).toBe(false);
    expect(await verifyProof(token, nonce, 'player-2', '123456', proof)).toBe(false);
    expect(await verifyProof(createSessionToken(), nonce, 'player-1', '123456', proof)).toBe(false);
  });

  it('rejects a tampered or truncated proof without throwing', async () => {
    const token = createSessionToken();
    const nonce = createNonce();
    const proof = await computeProof(token, nonce, 'p', '000001');
    const flipped = (proof[0] === 'a' ? 'b' : 'a') + proof.slice(1);
    expect(await verifyProof(token, nonce, 'p', '000001', flipped)).toBe(false);
    expect(await verifyProof(token, nonce, 'p', '000001', proof.slice(0, 10))).toBe(false);
    expect(await verifyProof(token, nonce, 'p', '000001', '')).toBe(false);
  });

  it('compares strings in constant time semantics (length and content)', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'ab')).toBe(false);
  });
});

describe('join codes', () => {
  it('generates six-digit codes that validate and normalise', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateJoinCode();
      expect(code).toMatch(/^\d{6}$/);
      expect(isValidJoinCode(code)).toBe(true);
    }
    expect(normalizeJoinCode(' 12 34-56 ')).toBe('123456');
    expect(isValidJoinCode('12345')).toBe(false);
    expect(isValidJoinCode('12345a')).toBe(false);
  });

  it('is deterministic with an injected random source (for tests and replay)', () => {
    expect(generateJoinCode(() => 0)).toBe('000000');
    expect(generateJoinCode(() => 0.999999)).toBe('999999');
  });
});

describe('client message validation', () => {
  const account = 'account-aaaa-1111';

  it('parses a valid host request and sanitises names', () => {
    const msg = parseClientMessage(JSON.stringify({ type: 'host', name: '  Alex<script>  ', protocol: 1, accountId: account }));
    expect(msg).toMatchObject({ type: 'host', protocol: 1 });
    expect(sanitizeName('  Alex<script>  ')).toBe('Alexscript');
    expect(sanitizeName('!!!')).toBe('Player');
  });

  it('rejects oversized and malformed payloads', () => {
    expect(() => parseClientMessage('{not json')).toThrow();
    expect(() => parseClientMessage(JSON.stringify({ type: 'host', name: 'x', protocol: 1, accountId: 'short' }))).toThrow();
    expect(() => parseClientMessage(JSON.stringify({ type: 'nope' }))).toThrow();
  });
});
