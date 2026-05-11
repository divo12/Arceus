/**
 * JWT sign/verify using Web Crypto HMAC-SHA256 — no external dependency.
 * Secret from ARCEUS_JWT_SECRET (≥32 chars). Tokens expire in 7 days.
 */

/// <reference lib="dom" />

export interface ArceusJwtPayload {
  userId: string;
  companyId: string;
  exp: number;
}

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let cachedKey: CryptoKey | null = null;

async function getSigningKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;

  const secret = process.env.ARCEUS_JWT_SECRET;
  if (!secret || secret.length < 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("ARCEUS_JWT_SECRET must be set (≥32 chars) in production.");
    }
    console.warn("[auth] Using dev default ARCEUS_JWT_SECRET. Set it before deploying.");
  }
  const raw = new TextEncoder().encode(
    (!secret || secret.length < 32) ? "arceus-dev-jwt-secret-change-this!" : secret,
  );
  cachedKey = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return cachedKey;
}

function b64url(input: string | Uint8Array | ArrayBuffer): string {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : input instanceof Uint8Array ? input : new Uint8Array(input);
  return Buffer.from(bytes).toString("base64url");
}

function parseB64url(s: string): ArrayBuffer {
  const buf = Buffer.from(s, "base64url");
  const ab = new ArrayBuffer(buf.length);
  new Uint8Array(ab).set(buf);
  return ab;
}

export async function signJwt(payload: Omit<ArceusJwtPayload, "exp">): Promise<string> {
  const key = await getSigningKey();
  const full: ArceusJwtPayload = { ...payload, exp: Math.floor((Date.now() + TOKEN_TTL_MS) / 1000) };
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(full));
  const signing = `${header}.${body}`;
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signing));
  return `${signing}.${b64url(sig)}`;
}

export async function verifyJwt(token: string): Promise<ArceusJwtPayload> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");
  const [header, body, sig] = parts as [string, string, string];
  const key = await getSigningKey();
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    parseB64url(sig),
    new TextEncoder().encode(`${header}.${body}`),
  );
  if (!valid) throw new Error("JWT signature invalid");
  const payload = JSON.parse(Buffer.from(parseB64url(body)).toString("utf8")) as ArceusJwtPayload;
  if (Math.floor(Date.now() / 1000) > payload.exp) throw new Error("JWT expired");
  return payload;
}
