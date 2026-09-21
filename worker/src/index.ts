import {
  checkFactor,
  clearLoginFailures,
  consumeRecoveryCode,
  createPending,
  createSession,
  createTotpSetup,
  deleteOtherSessions,
  deleteTotpSetup,
  destroySession,
  getSession,
  getTotpSetup,
  listLoginFailures,
  listSessions,
  loginAllowed,
  popPending,
  recordLoginFailure,
} from "./auth";
import { executeCheckin } from "./checkin";
import {
  DEFAULT_PBKDF2_ITERATIONS,
  generateRecoveryCodes,
  generateTotpSecret,
  hashPassword,
  hashToken,
  timingSafeEqual,
  totpUri,
  verifyPassword,
  verifyTotp,
} from "./crypto";
import { GAMES, gameNames } from "./games";
import { MiyousheClient, ApiError, CookieExpiredError, NoGameRoleError } from "./miyoushe";
import { notify } from "./notify";
import { scheduledCheckin } from "./schedule";
import {
  addUser,
  activeUsers,
  deleteUser,
  findUser,
  loadConfig,
  loadHistory,
  loadLastRun,
  loadScheduleState,
  normalizeConfig,
  saveConfig,
  safeUser,
  updateUser,
  DEFAULT_TIMEZONE,
  type AppConfig,
} from "./store";
import { makeQrSvg } from "./qrcode";

const SESSION_COOKIE = "miyo_session";
const MAX_BODY_BYTES = 1_000_000;

/** PBKDF2 cost for the admin password; tunable via the PBKDF2_ITERATIONS var. */
function pbkdf2Iterations(env: Env): number {
  const raw = Number(env.PBKDF2_ITERATIONS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PBKDF2_ITERATIONS;
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function fail(message: string, status = 400): Response {
  return json({ ok: false, message }, status);
}

async function readJson(request: Request): Promise<Record<string, any>> {
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (length > MAX_BODY_BYTES) throw new Error("请求过大");
  const text = await request.text();
  if (!text) return {};
  return JSON.parse(text);
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    if (trimmed.slice(0, index) === name) return trimmed.slice(index + 1);
  }
  return null;
}

function sessionCookie(request: Request, token: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function clientIp(request: Request): string {
  // x-miyo-client-ip is set by the Pages proxy so the real visitor IP survives the hop.
  return (
    request.headers.get("x-miyo-client-ip") ??
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For") ??
    "unknown"
  );
}

async function requireSession(env: Env, request: Request): Promise<string | null> {
  return getSession(env, getCookie(request, SESSION_COOKIE));
}

function publicConfig(config: AppConfig, lastRun: unknown) {
  return {
    timeout_seconds: config.timeout_seconds,
    delay_seconds: config.delay_seconds,
    notification_timeout_seconds: config.notification_timeout_seconds ?? 15,
    notifications: config.notifications,
    schedule: config.schedule,
    timezone: config.timezone,
    games_available: gameNames(),
    users_count: config.users.length,
    last_run: lastRun,
  };
}

async function handleLogin(env: Env, request: Request): Promise<Response> {
  const ip = clientIp(request);
  if (!(await loginAllowed(env, ip))) return fail("尝试次数过多，请 5 分钟后再试", 429);
  let data: Record<string, any>;
  try {
    data = await readJson(request);
  } catch {
    return fail("请求格式错误");
  }
  const config = await loadConfig(env);
  const auth = config.web_auth;
  if (!auth?.username || !auth.password_hash) {
    return fail("服务端未配置登录账号，请先完成首次设置", 503);
  }
  const suppliedUser = String(data.username ?? "");
  const suppliedPassword = String(data.password ?? "");
  if (timingSafeEqual(suppliedUser, auth.username) && (await verifyPassword(suppliedPassword, auth.password_hash))) {
    await clearLoginFailures(env, ip);
    if (auth.totp_secret) {
      const pending = await createPending(env, auth.username);
      return json({ ok: true, totp_required: true, pending });
    }
    const token = await createSession(env, auth.username);
    return json(
      { ok: true, username: auth.username, setup_2fa: true },
      200,
      { "Set-Cookie": sessionCookie(request, token, 12 * 3600) },
    );
  }
  await recordLoginFailure(env, ip);
  return fail("用户名或密码错误", 401);
}

async function handleLoginTotp(env: Env, request: Request): Promise<Response> {
  const ip = clientIp(request);
  if (!(await loginAllowed(env, ip))) return fail("尝试次数过多，请 5 分钟后再试", 429);
  let data: Record<string, any>;
  try {
    data = await readJson(request);
  } catch {
    return fail("请求格式错误");
  }
  const username = await popPending(env, String(data.pending ?? ""));
  if (!username) return fail("验证会话已过期，请重新登录", 401);
  const config = await loadConfig(env);
  const auth = config.web_auth;
  let verified = await verifyTotp(String(auth?.totp_secret ?? ""), String(data.code ?? ""));
  if (!verified && (await consumeRecoveryCode(config, String(data.code ?? "")))) {
    await saveConfig(env, config);
    verified = true;
  }
  if (!verified) {
    await recordLoginFailure(env, ip);
    const pending = await createPending(env, username);
    return json({ ok: false, message: "验证码错误", pending }, 401);
  }
  await clearLoginFailures(env, ip);
  const token = await createSession(env, username);
  return json({ ok: true, username }, 200, { "Set-Cookie": sessionCookie(request, token, 12 * 3600) });
}

async function handleSetup(env: Env, request: Request): Promise<Response> {
  if (request.method === "GET") {
    const config = await loadConfig(env);
    return json({ ok: true, configured: Boolean(config.web_auth?.username && config.web_auth.password_hash) });
  }
  const config = await loadConfig(env);
  if (config.web_auth?.username && config.web_auth.password_hash) {
    return fail("已完成初始化，无法重复设置", 409);
  }
  let data: Record<string, any>;
  try {
    data = await readJson(request);
  } catch {
    return fail("请求格式错误");
  }
  const username = String(data.username ?? "").trim();
  const password = String(data.password ?? "");
  if (!username) return fail("请填写用户名");
  if (password.length < 6) return fail("密码至少 6 位");
  config.web_auth = { username, password_hash: await hashPassword(password, pbkdf2Iterations(env)) };
  await saveConfig(env, config);
  const token = await createSession(env, username);
  return json({ ok: true, username }, 200, { "Set-Cookie": sessionCookie(request, token, 12 * 3600) });
}

async function handleApi(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  if (path === "/api/health") return json({ ok: true, service: "miyoushe-api" });
  if (path === "/api/login" && method === "POST") return handleLogin(env, request);
  if (path === "/api/login/totp" && method === "POST") return handleLoginTotp(env, request);
  if (path === "/api/setup") return handleSetup(env, request);

  if (path === "/api/logout" && method === "POST") {
    await destroySession(env, getCookie(request, SESSION_COOKIE));
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(request, "", 0) });
  }

  const username = await requireSession(env, request);
  if (path === "/api/session") {
    if (!username) return json({ ok: false, message: "未登录" }, 401);
    return json({ ok: true, username });
  }
  if (!username) return json({ ok: false, message: "未登录或会话已过期" }, 401);

  try {
    if (path === "/api/config" && method === "GET") {
      const config = await loadConfig(env);
      return json(publicConfig(config, await loadLastRun(env)));
    }
    if (path === "/api/config" && method === "POST") {
      const data = await readJson(request);
      const config = await loadConfig(env);
      if (data.timeout_seconds !== undefined) config.timeout_seconds = Number(data.timeout_seconds) || config.timeout_seconds;
      if (data.delay_seconds !== undefined) config.delay_seconds = Math.max(0, Number(data.delay_seconds) || 0);
      if (data.notification_timeout_seconds !== undefined) {
        config.notification_timeout_seconds = Number(data.notification_timeout_seconds) || 15;
      }
      if (Array.isArray(data.notifications)) config.notifications = data.notifications;
      if (data.schedule && typeof data.schedule === "object") config.schedule = data.schedule;
      if (typeof data.timezone === "string" && data.timezone) config.timezone = data.timezone;
      await saveConfig(env, normalizeConfig(config));
      return json({ ok: true, message: "全局配置已保存" });
    }
    if (path === "/api/users" && method === "GET") {
      const config = await loadConfig(env);
      return json({ ok: true, users: config.users.map(safeUser) });
    }
    if (path === "/api/users" && method === "POST") {
      const data = await readJson(request);
      if (!String(data.cookie ?? "").trim()) return fail("请填写 Cookie");
      const config = await loadConfig(env);
      const user = addUser(config, data);
      await saveConfig(env, config);
      return json({ ok: true, message: "用户已添加", user: safeUser(user) });
    }

    const userMatch = path.match(/^\/api\/users\/([^/]+)(\/.*)?$/);
    if (userMatch) {
      const userId = decodeURIComponent(userMatch[1]!);
      const suffix = userMatch[2] ?? "";
      if (suffix === "" && method === "PUT") {
        const data = await readJson(request);
        const config = await loadConfig(env);
        const user = updateUser(config, userId, data);
        if (!user) return fail(`找不到用户：${userId}`);
        await saveConfig(env, config);
        return json({ ok: true, message: "用户已更新", user: safeUser(user) });
      }
      if (suffix === "" && method === "DELETE") {
        const config = await loadConfig(env);
        if (!deleteUser(config, userId)) return fail(`找不到用户：${userId}`);
        await saveConfig(env, config);
        return json({ ok: true, message: "用户已删除" });
      }
      if (suffix === "/check-cookie" && method === "POST") {
        const data = await readJson(request);
        const config = await loadConfig(env);
        const user = findUser(config, userId);
        if (!user) return fail(`找不到用户：${userId}`);
        const cookie = String(data.cookie ?? "").trim() || String(user.cookie ?? "").trim();
        return json(await checkCookie(config, cookie, String(data.game ?? "genshin")));
      }
    }

    if (path === "/api/check-cookie" && method === "POST") {
      const data = await readJson(request);
      const config = await loadConfig(env);
      return json(await checkCookie(config, String(data.cookie ?? "").trim(), String(data.game ?? "genshin")));
    }
    if (path === "/api/test-notification" && method === "POST") {
      const data = await readJson(request);
      const config = await loadConfig(env);
      const inline = data.channel;
      if (inline && typeof inline === "object") {
        const errors = await notify(
          { ...config, notifications: [inline] },
          "success",
          "米游社签到测试通知",
          "这是来自管理页面的测试消息。",
        );
        return errors.length ? fail(errors.join("；")) : json({ ok: true, message: "测试通知已发送" });
      }
      const channels = config.notifications ?? [];
      const index = data.channel_index;
      if (index !== undefined && index !== null) {
        const selected = channels[Number(index)];
        if (!selected) return fail("通知渠道编号无效");
        const errors = await notify({ ...config, notifications: [selected] }, "success", "米游社签到测试通知", "这是来自管理页面的测试消息。");
        return errors.length ? fail(errors.join("；")) : json({ ok: true, message: "测试通知已发送" });
      }
      const errors = await notify(config, "success", "米游社签到测试通知", "这是来自管理页面的测试消息。");
      return errors.length ? fail(errors.join("；")) : json({ ok: true, message: "测试通知已发送" });
    }
    if (path === "/api/run" && method === "POST") {
      const config = await loadConfig(env);
      if (!config.users.length) return fail("没有已配置的用户，请先添加用户");
      const { summary, notifyErrors } = await executeCheckin(env, config, "manual");
      return json({ ok: true, summary, notify_errors: notifyErrors });
    }
    if (path === "/api/last-run" && method === "GET") {
      return json({ ok: true, last_run: await loadLastRun(env) });
    }
    if (path === "/api/dashboard" && method === "GET") {
      const config = await loadConfig(env);
      const state = await loadScheduleState(env);
      const active = activeUsers(config);
      const lastRun = await loadLastRun(env);
      const nextRun = state.planned_at && !state.executed ? state.planned_at : null;
      return json({
        ok: true,
        dashboard: {
          users_count: config.users.length,
          active_users: active.length,
          schedule: config.schedule,
          timezone: config.timezone ?? DEFAULT_TIMEZONE,
          next_run: nextRun,
          last_run: lastRun,
        },
      });
    }
    if (path === "/api/history" && method === "GET") {
      const limit = Math.min(60, Math.max(1, Number(url.searchParams.get("days") ?? "14") || 14));
      return json({ ok: true, days: await loadHistory(env, limit) });
    }
    if (path === "/api/security" && method === "GET") {
      const currentToken = getCookie(request, SESSION_COOKIE);
      const sessions = await listSessions(env);
      return json({
        ok: true,
        sessions: sessions.map((session) => ({
          id: session.token.slice(0, 8),
          username: session.username,
          created: session.created,
          current: session.token === currentToken,
        })),
        login_failures: await listLoginFailures(env),
      });
    }
    if (path === "/api/security/logout-others" && method === "POST") {
      const removed = await deleteOtherSessions(env, getCookie(request, SESSION_COOKIE));
      return json({ ok: true, message: `已退出其他 ${removed} 个会话` });
    }

    if (path === "/api/2fa" && method === "GET") {
      const config = await loadConfig(env);
      const auth = config.web_auth;
      return json({
        ok: true,
        enabled: Boolean(auth?.totp_secret),
        recovery_remaining: auth?.recovery_hashes?.length ?? 0,
        qr_available: true,
      });
    }
    if (path === "/api/2fa/setup" && method === "POST") {
      const data = await readJson(request);
      const config = await loadConfig(env);
      const auth = config.web_auth;
      if (!auth) return fail("未配置账号");
      if (auth.totp_secret) return fail("两步验证已启用");
      if (!(await verifyPassword(String(data.password ?? ""), auth.password_hash))) return fail("密码错误");
      const secret = generateTotpSecret();
      const setupToken = await createTotpSetup(env, auth.username, secret);
      const uri = totpUri(secret, auth.username);
      return json({ ok: true, setup_token: setupToken, secret, uri, qr_svg: makeQrSvg(uri), qr_available: true });
    }
    if (path === "/api/2fa/enable" && method === "POST") {
      const data = await readJson(request);
      const setup = await getTotpSetup(env, String(data.setup_token ?? ""));
      if (!setup) return fail("设置已过期，请重新生成二维码");
      if (!(await verifyTotp(setup.secret, String(data.code ?? "")))) return fail("验证码错误");
      const config = await loadConfig(env);
      const auth = config.web_auth;
      if (!auth) return fail("未配置账号");
      const recovery = generateRecoveryCodes();
      auth.totp_secret = setup.secret;
      auth.recovery_hashes = await Promise.all(recovery.map((code) => hashToken(code)));
      config.web_auth = auth;
      await saveConfig(env, config);
      await deleteTotpSetup(env, String(data.setup_token ?? ""));
      return json({ ok: true, recovery_codes: recovery });
    }
    if (path === "/api/2fa/disable" && method === "POST") {
      const data = await readJson(request);
      const config = await loadConfig(env);
      const auth = config.web_auth;
      if (!auth?.totp_secret) return fail("两步验证未启用");
      if (!(await verifyPassword(String(data.password ?? ""), auth.password_hash))) return fail("密码错误");
      if (!(await checkFactor(env, config, String(data.code ?? "")))) return fail("验证码错误");
      delete auth.totp_secret;
      delete auth.recovery_hashes;
      await saveConfig(env, config);
      return json({ ok: true });
    }
    if (path === "/api/2fa/recovery" && method === "POST") {
      const data = await readJson(request);
      const config = await loadConfig(env);
      const auth = config.web_auth;
      if (!auth?.totp_secret) return fail("两步验证未启用");
      if (!(await verifyPassword(String(data.password ?? ""), auth.password_hash))) return fail("密码错误");
      if (!(await checkFactor(env, config, String(data.code ?? "")))) return fail("验证码错误");
      const recovery = generateRecoveryCodes();
      auth.recovery_hashes = await Promise.all(recovery.map((code) => hashToken(code)));
      await saveConfig(env, config);
      return json({ ok: true, recovery_codes: recovery });
    }
  } catch (error) {
    return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 400);
  }

  return fail("Not found", 404);
}

async function checkCookie(config: AppConfig, cookie: string, gameKey: string) {
  if (!cookie) return { ok: false, status: "missing", message: "请先填写 Cookie" };
  const game = GAMES[gameKey] ?? GAMES.genshin!;
  try {
    const roles = await new MiyousheClient(cookie, Number(config.timeout_seconds ?? 20)).roles(game.game_biz);
    return { ok: true, status: "valid", message: `Cookie 可用，找到 ${roles.length} 个${game.name}角色` };
  } catch (error) {
    if (error instanceof CookieExpiredError) return { ok: false, status: "expired", message: error.message };
    if (error instanceof NoGameRoleError) {
      return { ok: false, status: "no_role", message: `${error.message}；请确认 Cookie 包含 account_id/cookie_token，且账号已绑定该游戏` };
    }
    if (error instanceof ApiError) return { ok: false, status: "failed", message: error.message };
    return { ok: false, status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Static assets (the admin UI) are served by the assets binding, so only /api/* reaches the Worker.
    if (!url.pathname.startsWith("/api/")) return fail("Not found", 404);
    try {
      return await handleApi(env, request);
    } catch (error) {
      console.error("unhandled error", error);
      return fail("服务器内部错误", 500);
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(scheduledCheckin(env));
  },
} satisfies ExportedHandler<Env>;
