interface Env {
  API?: Fetcher;
  API_ORIGIN?: string;
}

// Fallback origin used when the service binding is not configured on the Pages project.
// 占位符：改成你的 Worker 地址，例如 https://miyoushe-api.<your-subdomain>.workers.dev
const DEFAULT_API_ORIGIN = "******";

export const onRequest: PagesFunction<Env> = async (context) => {
  const clientIp = context.request.headers.get("CF-Connecting-IP");
  const headers = new Headers(context.request.headers);
  if (clientIp) headers.set("x-miyo-client-ip", clientIp);

  if (context.env.API) {
    const proxied = new Request(context.request.url, {
      method: context.request.method,
      headers,
      body: context.request.method === "GET" || context.request.method === "HEAD" ? undefined : context.request.body,
      redirect: "manual",
    });
    return context.env.API.fetch(proxied);
  }

  const origin = context.env.API_ORIGIN || DEFAULT_API_ORIGIN;
  const incoming = new URL(context.request.url);
  const target = new URL(incoming.pathname + incoming.search, origin);
  const proxied = new Request(target.toString(), {
    method: context.request.method,
    headers,
    body: context.request.method === "GET" || context.request.method === "HEAD" ? undefined : context.request.body,
    redirect: "manual",
  });
  return fetch(proxied);
};
