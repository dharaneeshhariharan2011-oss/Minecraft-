/** Friend join codes are always exactly six decimal digits, e.g. "048213". */
export const JOIN_CODE_LENGTH = 6;
const JOIN_CODE_PATTERN = /^\d{6}$/;

export function isValidJoinCode(code: unknown): code is string {
  return typeof code === 'string' && JOIN_CODE_PATTERN.test(code);
}

/** Normalises user input: strips spaces/dashes so "048-213" and " 048 213 " both work. */
export function normalizeJoinCode(input: string): string {
  return input.replace(/[\s-]/g, '');
}

/**
 * Generates a join code from a random source returning [0, 1).
 * Leading zeros are kept so every code has six characters.
 */
export function generateJoinCode(random: () => number = Math.random): string {
  const n = Math.floor(random() * 1_000_000);
  return String(Math.min(n, 999_999)).padStart(JOIN_CODE_LENGTH, '0');
}
