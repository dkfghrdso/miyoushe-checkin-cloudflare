export interface TimeZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function timeZoneParts(date: Date, timeZone: string): TimeZoneParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function offsetMs(date: Date, timeZone: string): number {
  const parts = timeZoneParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

/** Convert a wall-clock time in `timeZone` to the corresponding UTC instant. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let timestamp = guess - offsetMs(new Date(guess), timeZone);
  timestamp = guess - offsetMs(new Date(timestamp), timeZone);
  return new Date(timestamp);
}

export function localDateString(date: Date, timeZone: string): string {
  const parts = timeZoneParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function formatInTimeZone(date: Date, timeZone: string): string {
  const parts = timeZoneParts(date, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function randomInt(min: number, max: number): number {
  if (max <= min) return min;
  const range = max - min + 1;
  const buffer = new Uint32Array(1);
  const limit = Math.floor(0xffffffff / range) * range;
  let value: number;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0]!;
  } while (value >= limit);
  return min + (value % range);
}

export interface ScheduleRule {
  start_time: string;
  jitter_seconds: number;
}

export function computeNextPlanned(now: Date, schedule: ScheduleRule, timeZone: string): Date {
  const [hourText, minuteText] = String(schedule.start_time ?? "09:00").split(":");
  const hour = Number(hourText) || 0;
  const minute = Number(minuteText) || 0;
  const parts = timeZoneParts(now, timeZone);
  let base = zonedTimeToUtc(parts.year, parts.month, parts.day, hour, minute, 0, timeZone);
  if (base.getTime() <= now.getTime()) {
    base = new Date(base.getTime() + 24 * 3600 * 1000);
  }
  const jitter = Math.max(0, Math.min(600, Number(schedule.jitter_seconds ?? 0)));
  const offsetSeconds = randomInt(-jitter, jitter);
  return new Date(base.getTime() + offsetSeconds * 1000);
}
