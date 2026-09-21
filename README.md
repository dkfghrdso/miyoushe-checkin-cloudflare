# 米游社自动签到（Cloudflare Workers + Pages + KV）

> [!IMPORTANT]
> **使用下面的一键部署按钮前，请先 Fork 本仓库。**
> 一键部署会把仓库克隆到你的 GitHub 账号，并在**你的 Cloudflare 账号**里创建资源、申请授权。先 Fork 才能得到属于你自己的副本，后续的修改和更新都基于你的 Fork。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dkfghrdso/miyoushe-checkin-cloudflare/tree/main/worker)

一键部署会打开 Cloudflare 授权页，申请本项目所需权限（Workers 脚本、KV 命名空间等），并自动创建 KV、部署 **Worker 后端**（含每分钟 Cron）。

> [!WARNING]
> Cloudflare 官方的「Deploy to Cloudflare」按钮**只支持 Workers 应用，不支持 Pages**。所以上面的按钮只部署后端 Worker；**前端 Pages 需要再单独部署一次**，步骤见 [部署前端（Pages）](#部署前端pages)。

把原来的本地 Python 版本重构为 Cloudflare 全托管：

- **工作线程（后端）** `worker/` — 提供 `/api/*` HTTP 接口，并用 **Cron Trigger**（每分钟）替代原来的 `daemon` 常驻进程。
- **Pages（前端）** `pages/` — 静态管理页面（`index.html` / `login.html`），通过 **Pages Functions 反向代理**把 `/api/*` 转发给 Worker，浏览器看到的是同源，会话 Cookie 稳定可用。
- **KV（数据库）** — 绑定 `MIYO_KV`，保存配置、用户、定时状态、会话、两步验证临时数据。

## 目录结构

```
miyoushe-checkin-cf/
├── worker/                 # 后端 Worker
│   ├── src/
│   │   ├── index.ts        # 路由 + fetch/scheduled 入口
│   │   ├── miyoushe.ts     # 米游社客户端与签到逻辑
│   │   ├── games.ts        # 游戏与活动 ID 配置
│   │   ├── crypto.ts       # PBKDF2 / TOTP / HMAC / base32
│   │   ├── store.ts        # KV 存取与配置模型
│   │   ├── notify.ts       # Server酱 / 飞书 / 钉钉 / Telegram / Webhook
│   │   ├── schedule.ts     # 时区计算 + Cron 调度
│   │   ├── auth.ts         # 会话 / 登录限流 / 两步验证
│   │   ├── checkin.ts      # 一次执行（签到 + 通知 + 记录）
│   │   └── qrcode.ts       # otpauth URI -> SVG 二维码
│   ├── test/quick.ts       # 纯函数自测（TOTP/时区/PBKDF2）
│   ├── wrangler.jsonc
│   └── worker-configuration.d.ts  # wrangler types 生成
└── pages/                  # 前端 Pages
    ├── public/             # 静态资源
    ├── functions/api/[[path]].ts  # 反向代理到 Worker
    └── wrangler.jsonc
```

## 部署后的资源

| 资源 | 默认值（请替换为你自己的） |
| --- | --- |
| Worker | `miyoushe-api` → `https://<your-worker>.<your-subdomain>.workers.dev` |
| Cron | `* * * * *`（每分钟检查一次是否到达签到时间） |
| KV | `MIYO_KV`（id `******`；一键部署会自动创建并回填） |
| Pages | `miyoushe-checkin` → `https://<your-project>.pages.dev` |
| 自定义域名 | 可选，绑定你自己的域名（CNAME 到 Pages） |
| Cloudflare 账号 ID | `******` |

> 部分网络会污染 `*.workers.dev` 的解析。前端只访问 Pages 域名，Worker 由 Pages Function 在 Cloudflare 内部调用，因此浏览器不需要直连 `workers.dev`。如需更稳的入口，可给 Pages 绑定自有域名。

## 首次使用

1. 打开你的 Pages 域名（如 `https://<your-project>.pages.dev` 或你绑定的自定义域名），会自动跳转 `/login`。
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
# 后端
cd worker && npm install
npx wrangler dev --test-scheduled        # 本地；触发定时：curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
npx tsc --noEmit                          # 类型检查
npx wrangler deploy

# 纯函数自测
npx esbuild test/quick.ts --bundle --format=esm --platform=node --outfile=/tmp/quick.mjs && node /tmp/quick.mjs

# 前端
cd ../pages && npm install
npx wrangler pages deploy                 # 读取 wrangler.jsonc 的 pages_build_output_dir
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

- Cookie 与推送令牌保存在你自己的 Cloudflare KV 中；管理页面务必使用 HTTPS（Pages 默认提供）。
- 建议开启两步验证；登录失败连续 5 次会临时锁定来源 IP。
- Worker 的 API 仅接受已登录会话（首次设置接口在初始化后自动关闭）。

## 部署

### 一键部署后端（推荐）

1. **先 Fork** 本仓库。
2. 点击顶部的 **Deploy to Cloudflare** 按钮，在 Cloudflare 授权页同意所需权限。
3. Cloudflare 会克隆你的 Fork、自动创建 KV 命名空间、部署 Worker（含每分钟 Cron），并把新资源的 id 回填到配置里。

### 手动部署后端

```bash
cd worker && npm install
npx wrangler kv namespace create MIYO_KV      # 复制返回的 id
# 把 id 填进 worker/wrangler.jsonc 的 kv_namespaces[0].id
npx wrangler deploy
```

### 部署前端（Pages）

「Deploy to Cloudflare」按钮不支持 Pages，前端需要单独部署一次：

**方式 A：Dashboard 连接 Git**
Workers & Pages → Create → Pages → 连接你的 Fork，Build output directory 填 `pages/public`。

**方式 B：命令行**
```bash
cd pages && npm install
# 把 functions/api/[[path]].ts 的 DEFAULT_API_ORIGIN 改成你的 Worker 地址
npx wrangler pages deploy
```

建议再给 Pages 项目配置 **Service binding**（变量名 `API`，指向 Worker）：这样浏览器只访问 Pages 域名，由 Cloudflare 内部调用 Worker，不依赖 `workers.dev`。未配置时会回退到 `DEFAULT_API_ORIGIN`。

### 需要替换的占位符

本仓库不含任何密钥，以下值用 `******` 占位，部署时替换为你自己的：

| 位置 | 内容 |
| --- | --- |
| `worker/wrangler.jsonc` | `kv_namespaces[0].id`（一键部署会自动创建并回填） |
| `pages/functions/api/[[path]].ts` | `DEFAULT_API_ORIGIN` |
| `worker/wrangler.jsonc` / `pages/wrangler.jsonc` | `name`、服务绑定 `service` |

命令行部署需要 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID` 环境变量。

## 许可证

[MIT](LICENSE)

