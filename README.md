# 米游社自动签到（Cloudflare Workers + Static Assets + KV）

> [!IMPORTANT]
> **使用下面的一键部署按钮前，请先 Fork 本仓库。**
> 一键部署会把仓库克隆到你的 GitHub 账号，并在**你的 Cloudflare 账号**里创建资源、申请授权。先 Fork 才能得到属于你自己的副本，后续的修改和更新都基于你的 Fork。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dkfghrdso/miyoushe-checkin-cloudflare/tree/main/worker)

一键部署会打开 Cloudflare 授权页，申请本项目所需权限（Workers 脚本、KV 命名空间等），并自动创建 KV、部署**整个应用**：后端 API + Cron + 前端页面（由同一个 Worker 的 Static Assets 托管）。

把原来的本地 Python 版本重构为 Cloudflare 全托管：

- **Worker（后端 + 前端）** `worker/` — 提供 `/api/*` HTTP 接口，并用 **Cron Trigger**（每分钟）替代原来的 `daemon` 常驻进程；同时通过 **Static Assets** 托管 `worker/public/` 里的管理页面。
- **KV（数据库）** — 绑定 `MIYO_KV`，保存配置、用户、定时状态、会话、两步验证临时数据。

因为前后端同源（都由同一个 Worker 提供），会话 Cookie 直接可用，无需 CORS 或反向代理。

## 目录结构

```
miyoushe-checkin-cf/
└── worker/                 # 单个 Worker：API + 前端静态资源
    ├── src/
    │   ├── index.ts        # 路由 + fetch/scheduled 入口
    │   ├── miyoushe.ts     # 米游社客户端与签到逻辑
    │   ├── games.ts        # 游戏与活动 ID 配置
    │   ├── crypto.ts       # PBKDF2 / TOTP / HMAC / base32
    │   ├── store.ts        # KV 存取与配置模型
    │   ├── notify.ts       # Server酱 / 飞书 / 钉钉 / Telegram / Webhook
    │   ├── schedule.ts     # 时区计算 + Cron 调度
    │   ├── auth.ts         # 会话 / 登录限流 / 两步验证
    │   ├── checkin.ts      # 一次执行（签到 + 通知 + 记录）
    │   ├── time.ts         # 时区工具
    │   └── qrcode.ts       # otpauth URI -> SVG 二维码
    ├── public/             # 前端静态资源（index.html / login.html / theme.js）
    ├── test/quick.ts       # 纯函数自测（TOTP/时区/PBKDF2）
    ├── wrangler.jsonc
    └── worker-configuration.d.ts  # wrangler types 生成
```

## 部署后的资源

| 资源 | 默认值（请替换为你自己的） |
| --- | --- |
| Worker | `miyoushe-api` → `https://<your-worker>.<your-subdomain>.workers.dev` |
| Cron | `* * * * *`（每分钟检查一次是否到达签到时间） |
| KV | `MIYO_KV`（id `******`；一键部署会自动创建并回填） |
| 自定义域名 | 可选，给 Worker 绑定你自己的域名（Worker Route / Custom Domain） |
| Cloudflare 账号 ID | `******` |

> 部分网络会污染 `*.workers.dev` 的解析。前后端都在同一个 Worker 上，如需更稳的入口，给 Worker 绑定自有域名即可。

## 首次使用

1. 打开你的域名（`https://<your-worker>.<your-subdomain>.workers.dev` 或你绑定的自定义域名），会自动跳转 `/login`。
2. 因为尚未初始化，页面会显示「首次使用，请创建管理账号」，设置用户名 + 密码（≥ 6 位）并登录。
3. 登录后建议按提示开启两步验证（TOTP，支持扫码）。
4. 在「用户管理」中「+ 添加用户」，粘贴米游社 Cookie、选择游戏，保存。
5. 在「全局设置」里设置统一签到时间、时区、抖动、超时，以及推送渠道。
6. 可随时点「立即执行签到」验证配置。

签到时间逻辑与 Python 版一致：每天在 `start_time`（指定时区）前后 ± `jitter_seconds` 内随机取一个时刻，所有账号统一执行；当天结果写入 KV，不会重复执行。

## KV 键布局

| Key | 说明 |
| --- | --- |
| `config` | 全局配置：`users` / `notifications` / `schedule` / `timezone` / `web_auth` |
| `schedule_state` | `{ planned_at, executed, date }` 当日调度状态 |
| `last_run` | 最近一次执行结果（概览展示） |
| `result:<YYYY-MM-DD>` | 每日签到记录，TTL 90 天（签到记录页） |
| `session:<token>` | 会话 `{username, created}`，TTL 12 小时 |
| `pending:<token>` | 两步验证登录中间态，TTL 5 分钟 |
| `totp_setup:<token>` | 两步验证绑定中间态，TTL 5 分钟 |
| `login_fail:<ip>` | 登录失败计数，TTL 5 分钟（连续 5 次锁定） |

## 页面与接口

管理页面（一行导航）：**概览 / 用户管理 / 签到记录 / 推送管理 / 全局设置 / 安全 / 帮助**

| 接口 | 说明 |
| --- | --- |
| `GET /api/dashboard` | 概览：账号数、下次签到、最近结果 |
| `GET /api/history?days=14` | 每日签到记录 |
| `GET /api/security` | 会话列表 + 登录失败记录 |
| `POST /api/security/logout-others` | 退出其他所有会话 |
| `/api/config` `/api/users` `/api/check-cookie` `/api/test-notification` `/api/run` `/api/2fa/*` | 同前 |

## 本地开发 / 重新部署

```bash
cd worker && npm install
npx wrangler dev --test-scheduled        # 本地；触发定时：curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
npx tsc --noEmit                          # 类型检查
npx wrangler deploy                       # 一次部署：API + Cron + 前端静态资源

# 纯函数自测
npx esbuild test/quick.ts --bundle --format=esm --platform=node --outfile=/tmp/quick.mjs && node /tmp/quick.mjs
```

部署需要 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID` 环境变量。

## 重置 / 找回

忘记密码时，删除 KV 中的 `config` 键即可回到「首次设置」状态（会一并清空用户与通知配置）：

```bash
npx wrangler kv key delete --namespace-id ****** config --remote
```

## 与 Python 版的差异

- 常驻 `daemon` → Worker Cron（每分钟检查，按当天随机时间触发一次）。
- `config.json` / `schedule_state.json` → KV。
- 本地 `http.server` → Worker 路由；会话从内存字典 → KV（TTL）。
- 密码哈希：PBKDF2-HMAC-SHA256，默认 **50,000** 次（可通过 Worker 变量 `PBKDF2_ITERATIONS` 调整；免费版 CPU 限制为 10ms，不宜过大）。哈希字符串内记录迭代次数，调大不影响已有密码。
- 恢复码：因免费版 CPU 限制，改用「高熵随机码 + 加盐 SHA-256」而非 PBKDF2。
- 通知发送、Cookie 检测、签到逻辑与 Python 版保持一致。
- 二维码由 `qrcode-generator` 生成内联 SVG，无需额外系统依赖。

## 安全提示

- Cookie 与推送令牌保存在你自己的 Cloudflare KV 中；管理页面务必使用 HTTPS（worker.dev / 自定义域名默认提供）。
- 建议开启两步验证；登录失败连续 5 次会临时锁定来源 IP。
- Worker 的 API 仅接受已登录会话（首次设置接口在初始化后自动关闭）。

## 部署

### 一键部署（推荐）

1. **先 Fork** 本仓库。
2. 点击顶部的 **Deploy to Cloudflare** 按钮，在 Cloudflare 授权页同意所需权限。
3. Cloudflare 会克隆你的 Fork、自动创建 KV 命名空间、部署整个应用（API + Cron + 前端），并把新资源的 id 回填到配置里。

### 手动部署

```bash
cd worker && npm install
npx wrangler kv namespace create MIYO_KV      # 复制返回的 id
# 把 id 填进 worker/wrangler.jsonc 的 kv_namespaces[0].id
npx wrangler deploy                            # 一次部署：API + Cron + 前端静态资源
```

### 绑定自定义域名（可选）

给 Worker 绑定域名即可，无需 Pages：Dashboard → Workers & Pages → 选择该 Worker → Settings → Domains & Routes → 添加 Custom Domain；或加一条 Worker Route（`your.domain/*` → 该 Worker，并在 DNS 建一条代理记录）。

### 需要替换的占位符

本仓库不含任何密钥，以下值用 `******` 占位，部署时替换为你自己的：

| 位置 | 内容 |
| --- | --- |
| `worker/wrangler.jsonc` | `kv_namespaces[0].id`（一键部署会自动创建并回填） |
| `worker/wrangler.jsonc` | `name`（你的 Worker 名称） |

命令行部署需要 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID` 环境变量。

## 许可证

[MIT](LICENSE)

