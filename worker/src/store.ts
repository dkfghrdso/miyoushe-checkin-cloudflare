import { DEFAULT_GAMES } from "./games";

export interface WebAuth {
  username: string;
  password_hash: string;
  totp_secret?: string;
  recovery_hashes?: string[];
}

export interface ScheduleConfig {
  enabled: boolean;
  start_time: string;
  jitter_seconds: number;
}

export interface NotificationChannel {
  enabled?: boolean;
  type?: string;
  events?: string[];
  [key: string]: unknown;
}

export interface UserConfig {
  id: string;
  name: string;
  cookie: string;
  games: string[];
}

export interface AppConfig {
  users: UserConfig[];
  timeout_seconds: number;
  delay_seconds: number;
  notification_timeout_seconds?: number;
  notifications: NotificationChannel[];
  schedule?: ScheduleConfig;
  timezone?: string;
  web_auth?: WebAuth;
}

export interface ScheduleState {
  date?: string;
  planned_at?: string;
  executed?: boolean;
}

export interface RunSummary {
  at: string;
  triggered_by: "cron" | "manual";
  results: Array<{
    user_name: string;
    game: string;
    role: string;
    status: string;
    message: string;
  }>;
}

export const CONFIG_KEY = "config";
export const SCHEDULE_KEY = "schedule_state";
export const LAST_RUN_KEY = "last_run";
export const HISTORY_PREFIX = "result:";
export const SESSION_PREFIX = "session:";
export const PENDING_PREFIX = "pending:";
export const TOTP_SETUP_PREFIX = "totp_setup:";
export const LOGIN_FAIL_PREFIX = "login_fail:";

export const SESSION_TTL = 12 * 3600;
export const PENDING_TTL = 300;
export const LOGIN_FAIL_TTL = 300;
export const MAX_LOGIN_FAILURES = 5;

export const DEFAULT_TIMEZONE = "Asia/Shanghai";
export const DEFAULT_SCHEDULE: ScheduleConfig = { enabled: true, start_time: "09:00", jitter_seconds: 30 };
export const HISTORY_TTL = 90 * 24 * 3600;

export function generateUserId(now = Date.now()): string {
  return `user_${now}`;
}

export function defaultConfig(): AppConfig {
  return {
    users: [],
    timeout_seconds: 20,
    delay_seconds: 1,
    notifications: [],
    schedule: { ...DEFAULT_SCHEDULE },
    timezone: DEFAULT_TIMEZONE,
  };
}

export function normalizeConfig(raw: unknown): AppConfig {
  const config = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const base = defaultConfig();

  // Migrate the legacy single-user format.
  if (!Array.isArray(config.users) && typeof config.cookie === "string" && config.cookie.trim()) {
    config.users = [
      {
        id: generateUserId(),
        name: "默认用户",
        cookie: String(config.cookie).trim(),
        games: Array.isArray(config.games) ? config.games : [...DEFAULT_GAMES],
      },
    ];
  }

  const users = Array.isArray(config.users)
    ? config.users.map((entry) => {
        const user = (entry ?? {}) as Record<string, unknown>;
        return {
          id: String(user.id ?? generateUserId()),
          name: String(user.name ?? "未命名用户"),
          cookie: String(user.cookie ?? "").trim(),
          games: Array.isArray(user.games) && user.games.length ? (user.games as string[]) : [...DEFAULT_GAMES],
        } satisfies UserConfig;
      })
    : [];

  const schedule = (config.schedule ?? {}) as Record<string, unknown>;

  return {
    users,
    timeout_seconds: Number(config.timeout_seconds ?? base.timeout_seconds) || base.timeout_seconds,
    delay_seconds: Number(config.delay_seconds ?? base.delay_seconds) || 0,
    notification_timeout_seconds: Number(config.notification_timeout_seconds ?? 15) || 15,
    notifications: Array.isArray(config.notifications) ? (config.notifications as NotificationChannel[]) : [],
    schedule: {
      enabled: schedule.enabled !== false,
      start_time: typeof schedule.start_time === "string" ? schedule.start_time : DEFAULT_SCHEDULE.start_time,
      jitter_seconds: Math.max(0, Math.min(600, Number(schedule.jitter_seconds ?? DEFAULT_SCHEDULE.jitter_seconds) || 0)),
    },
    timezone: typeof config.timezone === "string" && config.timezone ? config.timezone : DEFAULT_TIMEZONE,
    web_auth: (config.web_auth as WebAuth | undefined) ?? undefined,
  };
}

export async function loadConfig(env: Env): Promise<AppConfig> {
  const raw = await env.MIYO_KV.get(CONFIG_KEY, "json");
  return normalizeConfig(raw);
}

export async function saveConfig(env: Env, config: AppConfig): Promise<void> {
  await env.MIYO_KV.put(CONFIG_KEY, JSON.stringify(config));
}

export function activeUsers(config: AppConfig): UserConfig[] {
  return (config.users ?? []).filter((user) => String(user.cookie ?? "").trim());
}

export function findUser(config: AppConfig, userId: string): UserConfig | undefined {
  return (config.users ?? []).find((user) => user.id === userId);
}

export function addUser(config: AppConfig, data: Partial<UserConfig>): UserConfig {
  const user: UserConfig = {
    id: generateUserId(),
    name: String(data.name ?? "未命名用户"),
    cookie: String(data.cookie ?? "").trim(),
    games: Array.isArray(data.games) && data.games.length ? data.games : [...DEFAULT_GAMES],
  };
  config.users.push(user);
  return user;
}

export function updateUser(config: AppConfig, userId: string, data: Partial<UserConfig>): UserConfig | undefined {
  const user = findUser(config, userId);
  if (!user) return undefined;
  if (data.name !== undefined) user.name = String(data.name);
  if (data.cookie !== undefined) user.cookie = String(data.cookie).trim();
  if (data.games !== undefined) user.games = data.games;
  return user;
}

export function deleteUser(config: AppConfig, userId: string): boolean {
  const before = config.users.length;
  config.users = config.users.filter((user) => user.id !== userId);
  return config.users.length < before;
}

export function safeUser(user: UserConfig) {
  return {
    id: user.id,
    name: user.name,
    cookie_configured: Boolean(String(user.cookie ?? "").trim()),
    games: user.games ?? [],
  };
}

export async function loadScheduleState(env: Env): Promise<ScheduleState> {
  return ((await env.MIYO_KV.get(SCHEDULE_KEY, "json")) as ScheduleState | null) ?? {};
}

export async function saveScheduleState(env: Env, state: ScheduleState): Promise<void> {
  await env.MIYO_KV.put(SCHEDULE_KEY, JSON.stringify(state));
}

export async function saveLastRun(env: Env, summary: RunSummary): Promise<void> {
  await env.MIYO_KV.put(LAST_RUN_KEY, JSON.stringify(summary));
}

export async function loadLastRun(env: Env): Promise<RunSummary | null> {
  return (await env.MIYO_KV.get(LAST_RUN_KEY, "json")) as RunSummary | null;
}

export interface HistoryDay {
  date: string;
  runs: RunSummary[];
}

export async function appendHistory(env: Env, date: string, run: RunSummary): Promise<void> {
  const key = `${HISTORY_PREFIX}${date}`;
  const existing = ((await env.MIYO_KV.get(key, "json")) as RunSummary[] | null) ?? [];
  existing.unshift(run);
  await env.MIYO_KV.put(key, JSON.stringify(existing.slice(0, 50)), { expirationTtl: HISTORY_TTL });
}

export async function loadHistory(env: Env, limitDays = 14): Promise<HistoryDay[]> {
  const listing = await env.MIYO_KV.list({ prefix: HISTORY_PREFIX, limit: 1000 });
  const keys = listing.keys
    .map((key) => key.name)
    .sort()
    .reverse()
    .slice(0, limitDays);
  const days: HistoryDay[] = [];
  for (const key of keys) {
    const runs = ((await env.MIYO_KV.get(key, "json")) as RunSummary[] | null) ?? [];
    days.push({ date: key.slice(HISTORY_PREFIX.length), runs });
  }
  return days;
}
