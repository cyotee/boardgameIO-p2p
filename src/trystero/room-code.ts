/**
 * Short shareable room codes for Trystero tables (6–8 chars).
 * Alphabet avoids ambiguous 0/O/1/I.
 */

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Validate 6–8 character room code (case-insensitive). */
export function isValidRoomCode(code: string): boolean {
  if (typeof code !== "string") return false;
  const c = code.trim().toUpperCase();
  if (c.length < 6 || c.length > 8) return false;
  for (let i = 0; i < c.length; i++) {
    if (!ALPHABET.includes(c[i])) return false;
  }
  return true;
}

/** Normalize room code for join (uppercase, trim). */
export function normalizeRoomCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Generate a cryptographically random room code.
 * @param length 6–8 (default 7)
 */
export function generateRoomCode(length = 7): string {
  const len = Math.min(8, Math.max(6, length | 0));
  const bytes = new Uint8Array(len);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < len; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}
