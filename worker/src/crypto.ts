/** WebCrypto helpers ported from the Python implementation. */

const encoder = new TextEncoder();

export const DEFAULT_PBKDF2_ITERATIONS = 50_000;
export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;
export const TOTP_ISSUER = "米游社签到管理";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  if (clean.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const value = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(value)) throw new Error("invalid hex");
    out[i] = value;
  }
  return out;
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function randomToken(byteLength = 32): string {
  return base64UrlEncode(randomBytes(byteLength));
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Constant-time comparison for two strings. */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations = DEFAULT_PBKDF2_ITERATIONS): Promise<string> {
  const salt = randomBytes(16);
  const derived = await pbkdf2(password, salt, iterations);
  return `pbkdf2_sha256$${iterations}$${bytesToHex(salt)}$${bytesToHex(derived)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [algo, iterationsText, saltHex, expectedHex] = stored.split("$");
    if (algo !== "pbkdf2_sha256" || !iterationsText || !saltHex || !expectedHex) return false;
    const iterations = Number.parseInt(iterationsText, 10);
    if (!Number.isFinite(iterations) || iterations <= 0) return false;
    const derived = await pbkdf2(password, hexToBytes(saltHex), iterations);
    return timingSafeEqual(bytesToHex(derived), expectedHex.toLowerCase());
  } catch {
    return false;
  }
}

// ── Base32 (RFC 4648, no padding) ────────────────────────────────────────────

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(secret: string): Uint8Array {
  const clean = secret.trim().replace(/[\s-]+/g, "").toUpperCase().replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error("invalid base32 secret");
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

// ── TOTP (HMAC-SHA1) ─────────────────────────────────────────────────────────

async function totpCode(secret: Uint8Array, counter: number): Promise<string> {
  const message = new Uint8Array(8);
  const view = new DataView(message.buffer);
  view.setUint32(0, Math.floor(counter / 0x1_0000_0000));
  view.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey("raw", secret as BufferSource, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export async function verifyTotp(secret: string, code: string, atSeconds?: number, window = 1): Promise<boolean> {
  if (!secret) return false;
  const digits = String(code ?? "").replace(/\D/g, "");
  if (digits.length !== TOTP_DIGITS) return false;
  let secretBytes: Uint8Array;
  try {
    secretBytes = base32Decode(secret);
  } catch {
    return false;
  }
  const now = atSeconds ?? Math.floor(Date.now() / 1000);
  const counter = Math.floor(now / TOTP_PERIOD);
  for (let offset = -window; offset <= window; offset++) {
    const candidate = await totpCode(secretBytes, counter + offset);
    if (timingSafeEqual(candidate, digits)) return true;
  }
  return false;
}

export function totpUri(secret: string, username: string): string {
  const label = encodeURIComponent(`${TOTP_ISSUER}:${username}`);
  const params = new URLSearchParams({
    secret,
    issuer: TOTP_ISSUER,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () => bytesToHex(randomBytes(16)));
}

// ── Fast salted hashes for high-entropy tokens (recovery codes) ──────────────

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

export async function hashToken(token: string): Promise<string> {
  const salt = randomBytes(16);
  const digest = await sha256(concatBytes(salt, encoder.encode(token)));
  return `sha256$${bytesToHex(salt)}$${bytesToHex(digest)}`;
}

export async function verifyToken(token: string, stored: string): Promise<boolean> {
  try {
    const [algo, saltHex, expectedHex] = stored.split("$");
    if (algo !== "sha256" || !saltHex || !expectedHex) return false;
    const digest = await sha256(concatBytes(hexToBytes(saltHex), encoder.encode(token)));
    return timingSafeEqual(bytesToHex(digest), expectedHex.toLowerCase());
  } catch {
    return false;
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ── HMAC-SHA256 signatures (Feishu / DingTalk) ───────────────────────────────

export async function hmacSha256Base64(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return base64Encode(new Uint8Array(signature));
}
