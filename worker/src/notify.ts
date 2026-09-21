import { hmacSha256Base64 } from "./crypto";
import type { AppConfig, NotificationChannel } from "./store";

export type NotifyEvent = "success" | "failed" | "cookie_expired";

function renderTemplate(value: unknown, variables: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\{(\w+)\}/g, (_, key: string) => variables[key] ?? "");
  }
  if (Array.isArray(value)) return value.map((item) => renderTemplate(item, variables));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = renderTemplate(item, variables);
    return out;
  }
  return value;
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Record<string, any>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function postForm(url: string, params: Record<string, string>, timeoutMs: number): Promise<Record<string, any>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function notify(
  config: AppConfig,
  event: NotifyEvent,
  title: string,
  message: string,
): Promise<string[]> {
  const channels = config.notifications ?? [];
  const timeoutMs = Number(config.notification_timeout_seconds ?? 15) * 1000;
  const variables = {
    event,
    title,
    message,
    status: event,
    time: new Date().toISOString(),
  };
  const errors: string[] = [];

  for (const channel of channels) {
    if (channel.enabled === false) continue;
    const events = Array.isArray(channel.events) ? channel.events : ["success", "failed", "cookie_expired"];
    if (!events.includes(event)) continue;
    const kind = String(channel.type ?? "webhook");
    try {
      if (kind === "serverchan") {
        const sendkey = String(channel.sendkey ?? "");
        if (!sendkey) throw new Error("Server酱缺少 sendkey");
        const result = await postForm(`https://sctapi.ftqq.com/${encodeURIComponent(sendkey)}.send`, { title, desp: message }, timeoutMs);
        if (result.code !== undefined && result.code !== null && Number(result.code) !== 0) {
          throw new Error(`Server酱返回 code=${result.code}：${result.message ?? "未知错误"}`);
        }
      } else if (kind === "feishu") {
        const url = String(channel.webhook_url ?? "");
        if (!url) throw new Error("飞书缺少 webhook_url");
        const body: Record<string, unknown> = { msg_type: "text", content: { text: `${title}\n${message}` } };
        const secret = String(channel.secret ?? "");
        if (secret) {
          const timestamp = String(Math.floor(Date.now() / 1000));
          body.timestamp = timestamp;
          body.sign = await hmacSha256Base64(`${timestamp}\n${secret}`, "");
        }
        const result = await postJson(url, body, {}, timeoutMs);
        if (result.code !== undefined && result.code !== null && Number(result.code) !== 0) {
          throw new Error(`飞书返回 code=${result.code}：${result.msg ?? "未知错误"}`);
        }
      } else if (kind === "dingtalk") {
        let token = String(channel.access_token ?? "");
        let webhookUrl = String(channel.webhook_url ?? "");
        if (!token && !webhookUrl) throw new Error("钉钉缺少 access_token 或 webhook_url");
        if (token && (token.includes("oapi.dingtalk.com") || token.includes("access_token="))) {
          const parsed = new URL(token);
          token = parsed.searchParams.get("access_token") ?? "";
          if (!webhookUrl) webhookUrl = `${parsed.origin}${parsed.pathname}`;
        }
        const query = new URLSearchParams();
        if (token) query.set("access_token", token);
        const secret = String(channel.secret ?? "");
        if (secret) {
          const timestamp = String(Date.now());
          query.set("timestamp", timestamp);
          query.set("sign", await hmacSha256Base64(secret, `${timestamp}\n${secret}`));
        }
        const base = webhookUrl || "https://oapi.dingtalk.com/robot/send";
        const url = query.toString() ? `${base}?${query.toString()}` : base;
        const keyword = String(channel.keyword ?? "").trim();
        const result = await postJson(url, { msgtype: "text", text: { content: `${keyword ? `${keyword}\n` : ""}${title}\n${message}` } }, {}, timeoutMs);
        if (result.errcode !== undefined && result.errcode !== null && Number(result.errcode) !== 0) {
          throw new Error(`钉钉返回 errcode=${result.errcode}：${result.errmsg ?? "未知错误"}`);
        }
      } else if (kind === "telegram") {
        const token = String(channel.bot_token ?? "");
        const chatId = String(channel.chat_id ?? "");
        if (!token || !chatId) throw new Error("Telegram 缺少 bot_token 或 chat_id");
        const result = await postJson(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text: `${title}\n${message}` }, {}, timeoutMs);
        if (result.ok === false) throw new Error(`Telegram 返回错误：${result.description ?? "未知错误"}`);
      } else {
        const url = String(channel.url ?? "");
        if (!url) throw new Error("Webhook 缺少 url");
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries((channel.headers as Record<string, unknown>) ?? {})) {
          headers[key] = String(value);
        }
        const body =
          renderTemplate(channel.body, variables) ?? { title: "{title}", content: "{message}", event: "{event}" };
        await postJson(url, body, headers, timeoutMs);
      }
    } catch (error) {
      errors.push(`${kind}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}
