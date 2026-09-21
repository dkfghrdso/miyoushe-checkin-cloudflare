import { executeCheckin } from "./checkin";
import {
  activeUsers,
  loadConfig,
  loadScheduleState,
  saveScheduleState,
  DEFAULT_SCHEDULE,
  DEFAULT_TIMEZONE,
  type AppConfig,
} from "./store";
import { computeNextPlanned, localDateString } from "./time";

export { computeNextPlanned, zonedTimeToUtc, localDateString, timeZoneParts } from "./time";

const MAX_LATENESS_MS = 6 * 3600 * 1000;

export async function scheduledCheckin(env: Env): Promise<void> {
  const config: AppConfig = await loadConfig(env);
  const users = activeUsers(config);
  if (!users.length) return;

  const schedule = config.schedule ?? DEFAULT_SCHEDULE;
  if (schedule.enabled === false) return;
  const timeZone = config.timezone ?? DEFAULT_TIMEZONE;
  const now = new Date();

  const state = await loadScheduleState(env);
  const plannedAt = state.planned_at ? new Date(state.planned_at) : null;

  if (state.executed || !plannedAt || Number.isNaN(plannedAt.getTime())) {
    const next = computeNextPlanned(now, schedule, timeZone);
    await saveScheduleState(env, { date: localDateString(next, timeZone), planned_at: next.toISOString(), executed: false });
    return;
  }

  if (now.getTime() < plannedAt.getTime()) return;

  if (now.getTime() - plannedAt.getTime() > MAX_LATENESS_MS) {
    const next = computeNextPlanned(now, schedule, timeZone);
    await saveScheduleState(env, { date: localDateString(next, timeZone), planned_at: next.toISOString(), executed: false });
    return;
  }

  // Mark as executed before running so an overlapping cron tick cannot double-run.
  await saveScheduleState(env, {
    date: localDateString(plannedAt, timeZone),
    planned_at: plannedAt.toISOString(),
    executed: true,
  });
  await executeCheckin(env, config, "cron");
}
