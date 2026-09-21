import { GAMES, INFO_URL, ROLE_URL, SIGN_URL, type Game } from "./games";

export type CheckinStatus = "success" | "already" | "skipped" | "failed" | "cookie_expired";

export interface Result {
  user_id: string;
  user_name: string;
  game: string;
  role: string;
  status: CheckinStatus;
  message: string;
}

export interface CheckinUser {
  id: string;
  name: string;
  cookie: string;
  games?: string[];
}

export class ApiError extends Error {}
export class CookieExpiredError extends ApiError {}
export class NoGameRoleError extends ApiError {}

interface Role {
  nickname?: string;
  game_uid?: string | number;
  region?: string;
  [key: string]: unknown;
}

interface RequestOptions {
  params?: Record<string, string>;
  body?: Record<string, unknown>;
  signgame?: string;
}

export class MiyousheClient {
  private cookie: string;
  private timeoutMs: number;
  private deviceId: string;
  private ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36";

  constructor(cookie: string, timeoutSeconds = 20) {
    this.cookie = cookie.trim();
    this.timeoutMs = Math.max(1, timeoutSeconds) * 1000;
    this.deviceId = crypto.randomUUID().toUpperCase();
  }

  private headers(signgame?: string): Record<string, string> {
    const headers: Record<string, string> = {
      "User-Agent": this.ua,
      Cookie: this.cookie,
      Accept: "application/json, text/plain, */*",
      Origin: "https://www.miyoushe.com",
      Referer: "https://www.miyoushe.com/",
      "Content-Type": "application/json;charset=UTF-8",
      "x-rpc-client_type": "5",
      "x-rpc-app_version": "2.71.1",
      "x-rpc-channel": "miyousheluodi",
      "x-rpc-device_id": this.deviceId,
      "X-Requested-With": "com.mihoyo.hyperion",
      "Accept-Language": "zh-CN,en-US;q=0.8",
    };
    if (signgame) headers["x-rpc-signgame"] = signgame;
    return headers;
  }

  private async request(url: string, options: RequestOptions = {}): Promise<Record<string, any>> {
    const target = new URL(url);
    if (options.params) {
      for (const [key, value] of Object.entries(options.params)) target.searchParams.set(key, value);
    }
    const method = options.body === undefined ? "GET" : "POST";
    let response: Response;
    try {
      response = await fetch(target.toString(), {
        method,
        headers: this.headers(options.signgame),
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ApiError(`网络错误：${error instanceof Error ? error.message : String(error)}`);
    }
    const raw = await response.text();
    if (!response.ok) throw new ApiError(`HTTP ${response.status} ${response.statusText}`);
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new ApiError("服务器返回了非 JSON 内容，可能需要重新登录或接口已变更");
    }
    const retcode = payload.retcode;
    if (retcode !== 0 && retcode !== undefined && retcode !== null) {
      const message = String(payload.message ?? "未知错误");
      const lowered = message.toLowerCase();
      const expired =
        retcode === -100 ||
        retcode === 10001 ||
        retcode === 1004 ||
        ["login", "cookie", "登录", "失效", "过期"].some((word) => lowered.includes(word.toLowerCase()));
      if (expired) throw new CookieExpiredError(`Cookie 可能已过期：${message}`);
      if (retcode === -10002 || message.includes("未查询到游戏角色")) {
        throw new NoGameRoleError(`未查询到该游戏角色：${message}`);
      }
      throw new ApiError(`接口错误 ${retcode}：${message}`);
    }
    return payload;
  }

  async roles(gameBiz: string): Promise<Role[]> {
    const payload = await this.request(ROLE_URL, { params: { game_biz: gameBiz } });
    return (payload.data?.list as Role[] | undefined) ?? [];
  }

  async signed(game: Game, role: Role): Promise<Record<string, any>> {
    const url = game.info_url ?? INFO_URL;
    const payload = await this.request(url, {
      params: {
        act_id: game.act_id,
        region: String(role.region ?? ""),
        uid: String(role.game_uid ?? ""),
      },
      signgame: game.signgame,
    });
    return payload.data ?? {};
  }

  async sign(game: Game, role: Role): Promise<Record<string, any>> {
    const payload = await this.request(game.sign_url ?? SIGN_URL, {
      body: { act_id: game.act_id, region: role.region, uid: role.game_uid },
      signgame: game.signgame,
    });
    return payload.data ?? {};
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runSingleUser(user: CheckinUser, timeoutSeconds = 20, delaySeconds = 1): Promise<Result[]> {
  const userId = user.id || "unknown";
  const userName = user.name || "未命名用户";
  const cookie = String(user.cookie ?? "").trim();
  if (!cookie) {
    return [{ user_id: userId, user_name: userName, game: "-", role: "-", status: "failed", message: "Cookie 未配置" }];
  }
  const client = new MiyousheClient(cookie, timeoutSeconds);
  const selected = user.games ?? ["genshin", "starrail", "zzz"];
  const results: Result[] = [];

  for (const key of selected) {
    const game = GAMES[key];
    if (!game) {
      results.push({ user_id: userId, user_name: userName, game: key, role: "-", status: "skipped", message: "未知游戏配置" });
      continue;
    }
    try {
      const roles = await client.roles(game.game_biz);
      if (!roles.length) {
        results.push({ user_id: userId, user_name: userName, game: game.name, role: "-", status: "skipped", message: "没有找到绑定角色" });
        continue;
      }
      for (const role of roles) {
        const nickname = String(role.nickname ?? role.game_uid ?? "未知角色");
        const label = `${nickname}(${role.game_uid ?? "-"})`;
        const info = await client.signed(game, role);
        if (info.is_sign) {
          results.push({ user_id: userId, user_name: userName, game: game.name, role: label, status: "already", message: "今天已签到" });
          continue;
        }
        try {
          const data = await client.sign(game, role);
          if (data.is_risk) {
            results.push({ user_id: userId, user_name: userName, game: game.name, role: label, status: "failed", message: "触发风控，签到未完成，请稍后手动处理" });
          } else {
            results.push({ user_id: userId, user_name: userName, game: game.name, role: label, status: "success", message: "签到成功" });
          }
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          if (text.includes("-5003") || text.includes("已签到")) {
            results.push({ user_id: userId, user_name: userName, game: game.name, role: label, status: "already", message: "今天已签到" });
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof CookieExpiredError) {
        results.push({ user_id: userId, user_name: userName, game: game.name, role: "-", status: "cookie_expired", message: error.message });
      } else if (error instanceof NoGameRoleError) {
        results.push({ user_id: userId, user_name: userName, game: game.name, role: "-", status: "skipped", message: `${error.message}；请确认 Cookie 包含 account_id/cookie_token，且账号已绑定该游戏` });
      } else if (error instanceof ApiError) {
        results.push({ user_id: userId, user_name: userName, game: game.name, role: "-", status: "failed", message: error.message });
      } else {
        results.push({ user_id: userId, user_name: userName, game: game.name, role: "-", status: "failed", message: `程序异常：${error instanceof Error ? error.message : String(error)}` });
      }
    }
    if (delaySeconds > 0) await sleep(delaySeconds * 1000);
  }
  return results;
}

export interface RunSettings {
  timeoutSeconds: number;
  delaySeconds: number;
}

export async function runUsers(users: CheckinUser[], settings: RunSettings): Promise<Result[]> {
  const all: Result[] = [];
  for (const user of users) {
    all.push(...(await runSingleUser(user, settings.timeoutSeconds, settings.delaySeconds)));
  }
  return all;
}

export function renderResults(results: Result[]): string {
  const now = new Date().toISOString();
  const lines = [`[${now}] 米游社签到结果`];
  let currentUser: string | null = null;
  for (const item of results) {
    if (item.user_name !== currentUser) {
      currentUser = item.user_name;
      lines.push("", `【${item.user_name}】`);
    }
    lines.push(`  - [${item.status}] ${item.game} / ${item.role}：${item.message}`);
  }
  return lines.join("\n");
}

export function resultsMessage(results: Result[]): string {
  const grouped = new Map<string, string[]>();
  for (const item of results) {
    const list = grouped.get(item.user_name) ?? [];
    list.push(`${item.game} / ${item.role}：${item.message}`);
    grouped.set(item.user_name, list);
  }
  if (!grouped.size) return "没有可执行的签到项目";
  return [...grouped.entries()].map(([name, lines]) => `【${name}】\n${lines.join("\n")}`).join("\n\n");
}
