/**
 * PBKDF2-based password hashing using Web Crypto (built-in, no dep).
 * Format stored in DB: "pbkdf2:<base64-salt>:<base64-hash>"
 */

const ITERATIONS = 200_000;
const KEY_LEN = 32;
const DIGEST = "SHA-256";

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: DIGEST },
    keyMaterial,
    KEY_LEN * 8,
  );
  return `pbkdf2:${Buffer.from(salt).toString("base64")}:${Buffer.from(bits).toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  // Bcrypt hashes from the old Next.js auth system — verify with bcryptjs for backward compat.
  if (stored.startsWith("$2b$") || stored.startsWith("$2a$")) {
    const bcrypt = await import("bcryptjs");
    const compareFn = (bcrypt as unknown as { default?: typeof bcrypt }).default ?? bcrypt;
    return compareFn.compare(password, stored);
  }
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "pbkdf2") return false;
  const salt = Buffer.from(parts[1], "base64");
  const expectedHash = Buffer.from(parts[2], "base64");
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: DIGEST },
    keyMaterial,
    KEY_LEN * 8,
  );
  const actualHash = new Uint8Array(bits);
  // Constant-time comparison
  if (actualHash.length !== expectedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < actualHash.length; i++) {
    diff |= actualHash[i] ^ expectedHash[i];
  }
  return diff === 0;
}
