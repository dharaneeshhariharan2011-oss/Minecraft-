/**
 * Session token handshake.
 *
 * 1. A player is admitted to a room and receives a random `sessionToken` once.
 * 2. When that player reconnects (e.g. after a network drop) they send `resume`.
 * 3. The server replies with a fresh random `nonce` (challenge).
 * 4. The client answers with `proof = HMAC-SHA256(sessionToken, nonce + "|" + playerId + "|" + code)`.
 * 5. The server recomputes the proof and compares in constant time.
 *
 * The raw token is never sent again after admission, and a captured proof is useless
 * for any other nonce, so replaying it does not grant access.
 *
 * Uses Web Crypto so the exact same code runs in browsers and Node 20+.
 */

const encoder = new TextEncoder();

export const TOKEN_BYTES = 32;
export const NONCE_BYTES = 16;

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('invalid hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Random hex string of `bytes` bytes using Web Crypto. */
export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

export function createSessionToken(): string {
  return randomHex(TOKEN_BYTES);
}

export function createNonce(): string {
  return randomHex(NONCE_BYTES);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/** Computes the hex-encoded HMAC-SHA256 proof for a challenge. */
export async function computeProof(
  sessionToken: string,
  nonce: string,
  playerId: string,
  joinCode: string,
): Promise<string> {
  const key = await hmacKey(sessionToken);
  const message = encoder.encode(`${nonce}|${playerId}|${joinCode}`);
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, message);
  return bytesToHex(new Uint8Array(sig));
}

/** Constant-time string comparison (avoids leaking the position of the first mismatch). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Verifies a proof produced by `computeProof`. Never throws on malformed input. */
export async function verifyProof(
  sessionToken: string,
  nonce: string,
  playerId: string,
  joinCode: string,
  proof: unknown,
): Promise<boolean> {
  if (typeof proof !== 'string' || proof.length !== 64) return false;
  const expected = await computeProof(sessionToken, nonce, playerId, joinCode);
  return constantTimeEqual(expected, proof);
}
