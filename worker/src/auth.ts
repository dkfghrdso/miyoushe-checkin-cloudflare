import { verifyPassword, verifyTotp, verifyToken, randomToken } from "./crypto";
import {
  LOGIN_FAIL_PREFIX,
  LOGIN_FAIL_TTL,
  MAX_LOGIN_FAILURES,
  PENDING_PREFIX,
  PENDING_TTL,
  SESSION_PREFIX,
  SESSION_TTL,
  TOTP_SETUP_PREFIX,
  type AppConfig,
} from "./store";

export async function createSession(env: Env, username: string): Promise<string> {
  const token = randomToken(32);
  await env.MIYO_KV.put(`${SESSION_PREFIX}${token}`, JSON.stringify({ username, created: Date.now() }), {
    expirationTtl: SESSION_TTL,
  });
  return token;
}

export async function getSession(env: Env, token: string | null): Promise<string | null> {
  if (!token) return null;
  const raw = await env.MIYO_KV.get(`${SESSION_PREFIX}${token}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { username?: string };
    return parsed.username ?? null;
  } catch {
    return raw;
  }
}

export interface SessionInfo {
  token: string;
  username: string | null;
  created: number | null;
}

export async function listSessions(env: Env): Promise<SessionInfo[]> {
  const listing = await env.MIYO_KV.list({ prefix: SESSION_PREFIX, limit: 1000 });
  const sessions: SessionInfo[] = [];
  for (const key of listing.keys) {
    const raw = await env.MIYO_KV.get(key.name);
    let username: string | null = null;
    let created: number | null = null;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { username?: string; created?: number };
        username = parsed.username ?? null;
        created = parsed.created ?? null;
      } catch {
        username = raw;
      }
    }
    sessions.push({ token: key.name.slice(SESSION_PREFIX.length), username, created });
  }
  return sessions;
}

export async function deleteOtherSessions(env: Env, currentToken: string | null): Promise<number> {
  const listing = await env.MIYO_KV.list({ prefix: SESSION_PREFIX, limit: 1000 });
  let removed = 0;
  for (const key of listing.keys) {
    if (currentToken && key.name === `${SESSION_PREFIX}${currentToken}`) continue;
    await env.MIYO_KV.delete(key.name);
    removed++;
  }
  return removed;
}

export async function listLoginFailures(env: Env): Promise<Array<{ ip: string; count: number }>> {
  const listing = await env.MIYO_KV.list({ prefix: LOGIN_FAIL_PREFIX, limit: 1000 });
  const failures: Array<{ ip: string; count: number }> = [];
  for (const key of listing.keys) {
    const count = Number((await env.MIYO_KV.get(key.name)) ?? "0") || 0;
    failures.push({ ip: key.name.slice(LOGIN_FAIL_PREFIX.length), count });
  }
  return failures;
}

export async function destroySession(env: Env, token: string | null): Promise<void> {
  if (token) await env.MIYO_KV.delete(`${SESSION_PREFIX}${token}`);
}

export async function loginAllowed(env: Env, ip: string): Promise<boolean> {
  const raw = await env.MIYO_KV.get(`${LOGIN_FAIL_PREFIX}${ip}`);
  return (Number(raw ?? 0) || 0) < MAX_LOGIN_FAILURES;
}

export async function recordLoginFailure(env: Env, ip: string): Promise<void> {
  const raw = await env.MIYO_KV.get(`${LOGIN_FAIL_PREFIX}${ip}`);
  const count = (Number(raw ?? 0) || 0) + 1;
  await env.MIYO_KV.put(`${LOGIN_FAIL_PREFIX}${ip}`, String(count), { expirationTtl: LOGIN_FAIL_TTL });
}

export async function clearLoginFailures(env: Env, ip: string): Promise<void> {
  await env.MIYO_KV.delete(`${LOGIN_FAIL_PREFIX}${ip}`);
}

export async function createPending(env: Env, username: string): Promise<string> {
  const token = randomToken(24);
  await env.MIYO_KV.put(`${PENDING_PREFIX}${token}`, username, { expirationTtl: PENDING_TTL });
  return token;
}

export async function popPending(env: Env, token: string | null): Promise<string | null> {
  if (!token) return null;
  const key = `${PENDING_PREFIX}${token}`;
  const username = await env.MIYO_KV.get(key);
  if (username) await env.MIYO_KV.delete(key);
  return username ?? null;
}

export async function createTotpSetup(env: Env, username: string, secret: string): Promise<string> {
  const token = randomToken(24);
  await env.MIYO_KV.put(`${TOTP_SETUP_PREFIX}${token}`, JSON.stringify({ username, secret }), {
    expirationTtl: PENDING_TTL,
  });
  return token;
}

export async function getTotpSetup(env: Env, token: string | null): Promise<{ username: string; secret: string } | null> {
  if (!token) return null;
  const raw = await env.MIYO_KV.get(`${TOTP_SETUP_PREFIX}${token}`, "json");
  return (raw as { username: string; secret: string } | null) ?? null;
}

export async function deleteTotpSetup(env: Env, token: string | null): Promise<void> {
  if (token) await env.MIYO_KV.delete(`${TOTP_SETUP_PREFIX}${token}`);
}

export async function checkFactor(env: Env, config: AppConfig, code: string): Promise<boolean> {
  const auth = config.web_auth;
  if (!auth) return false;
  if (auth.totp_secret && (await verifyTotp(auth.totp_secret, code))) return true;
  return consumeRecoveryCode(config, code);
}

export async function consumeRecoveryCode(config: AppConfig, code: string): Promise<boolean> {
  const auth = config.web_auth;
  if (!auth?.recovery_hashes?.length) return false;
  const normalized = String(code ?? "").trim().toLowerCase();
  if (!normalized) return false;
  for (let index = 0; index < auth.recovery_hashes.length; index++) {
    if (await verifyToken(normalized, auth.recovery_hashes[index]!)) {
      auth.recovery_hashes.splice(index, 1);
      return true;
    }
  }
  return false;
}
