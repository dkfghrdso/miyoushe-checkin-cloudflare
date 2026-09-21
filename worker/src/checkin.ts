import { resultsMessage, runUsers, type Result } from "./miyoushe";
import { notify, type NotifyEvent } from "./notify";
import { activeUsers, appendHistory, saveLastRun, DEFAULT_TIMEZONE, type AppConfig, type RunSummary } from "./store";
import { localDateString } from "./time";

export async function executeCheckin(
  env: Env,
  config: AppConfig,
  triggeredBy: "cron" | "manual",
): Promise<{ summary: RunSummary; notifyErrors: string[] }> {
  const users = activeUsers(config);
  const results: Result[] = users.length
    ? await runUsers(users, {
        timeoutSeconds: Number(config.timeout_seconds ?? 20),
        delaySeconds: Number(config.delay_seconds ?? 1),
      })
    : [];

  let event: NotifyEvent = "success";
  if (results.some((item) => item.status === "cookie_expired")) event = "cookie_expired";
  else if (results.some((item) => item.status === "failed")) event = "failed";

  const title =
    event === "cookie_expired" ? "米游社 Cookie 已过期或失效" : event === "failed" ? "米游社签到失败" : "米游社签到完成";

  const userLabel = users.length === 1 ? `【${users[0]!.name}】` : "";
  const message = resultsMessage(results) || `${userLabel}没有可执行的签到项目`;

  const notifyErrors = results.length ? await notify(config, event, title, message) : [];

  const summary: RunSummary = {
    at: new Date().toISOString(),
    triggered_by: triggeredBy,
    results: results.map((item) => ({
      user_name: item.user_name,
      game: item.game,
      role: item.role,
      status: item.status,
      message: item.message,
    })),
  };
  await saveLastRun(env, summary);
  await appendHistory(env, localDateString(new Date(summary.at), config.timezone ?? DEFAULT_TIMEZONE), summary);
  return { summary, notifyErrors };
}
