# Cloudflare Email Worker：VPS 直推与 R2 兜底

这个 Worker 接收 Cloudflare Email Routing 投递的原始邮件，计算完整 RFC822/MIME 字节的 SHA-256，并优先用 HTTPS `POST` 到 VPS daemon。只有 VPS 返回 2xx 才算直推成功；网络错误、超时或非 2xx 都会把同一份原始字节保存到 R2 的 `pending/<sha256>.eml`。

VPS 可通过带 Bearer token 的 `/list` 分批列出待补投邮件，再通过 `/mail` 逐封下载。VPS 将邮件可靠落盘后，再调用 `/confirm` 删除 R2 对象。项目不使用 KV、D1、Queues、Durable Objects 或其他数据库。

## 架构与故障语义

```text
Internet -> Cloudflare Email Routing -> Email Worker
                                           |
                                           +-- HTTPS POST /push -> 2xx -> 完成（不写 R2）
                                           |
                                           +-- 失败/超时/非 2xx -> R2 pending/<mailId>.eml

VPS daemon -> GET /list -> GET /mail -> 保存原始邮件 -> POST /confirm -> 删除 R2 对象
```

`mailId` 是完整原始邮件字节的 lowercase SHA-256 hex。R2 对象存在就表示仍待确认，对象不存在就表示没有待补投状态；只有 `/confirm` 会删除对象。

这是至少一次投递，而不是恰好一次投递。VPS 可能已经保存 `/push` 的正文，但响应在到达 Worker 前断开；此时 Worker 仍会写入 R2，之后 VPS 会再次取得相同 `mailId`。VPS 必须按 `mailId` 幂等保存。系统选择“可能重复”，避免“可能丢信”。如果 VPS 推送和 R2 写入都失败，Worker 会抛出异常，不会静默返回成功。

Email Routing 当前接收入站邮件的上限为 25 MiB。Worker 会把单封邮件读取到一个 `ArrayBuffer`，因为一次性的 `message.raw` 必须同时支持哈希、直推以及失败后的 R2 兜底。Cloudflare 当前 Worker isolate 内存上限为 128 MB；代码不解析或重建 MIME。

## 前置条件

- 域名 DNS 托管在 Cloudflare，并已启用 Email Routing。
- Node.js、pnpm，以及可访问 Cloudflare 账户的 Wrangler。
- 一个公开可访问、证书有效的 HTTPS VPS daemon。

安装依赖并登录：

```bash
pnpm install
pnpm exec wrangler login
```

## 创建并绑定 R2

当前 [`wrangler.toml`](./wrangler.toml) 使用 bucket 名 `email-worker-mail` 和 binding 名 `MAIL_BUCKET`：

```bash
pnpm exec wrangler r2 bucket create email-worker-mail
```

如需其他 bucket 名，先创建它，再修改 `wrangler.toml` 中的 `bucket_name`。不要修改 `binding = "MAIL_BUCKET"`，除非同步修改源码。Dashboard 的等价操作是 **R2 Object Storage > Create bucket**，然后在 Worker 的 **Settings > Bindings** 中添加 R2 bucket binding `MAIL_BUCKET`。

修改任何 binding 后运行：

```bash
pnpm run cf-typegen
```

R2 bucket 不需要公开域名或 S3 API token；Worker 通过内部 binding 访问它。

## Secrets 与变量

必须配置以下三项，且不要写入源码或 `wrangler.toml`：

| 名称 | 用途 |
| --- | --- |
| `VPS_BASE_URL` | VPS daemon 的 HTTPS 基础 URL，不包含尾部 `push`，例如 `https://mail.example.net` 或 `https://example.net/daemon` |
| `VPS_PUSH_TOKEN` | Worker 调用 VPS `/push` 时发送的 Bearer token |
| `WORKER_API_TOKEN` | VPS 调用 Worker `/list`、`/mail`、`/confirm` 时使用的 Bearer token |

生产 secrets：

```bash
pnpm exec wrangler secret put VPS_BASE_URL
pnpm exec wrangler secret put VPS_PUSH_TOKEN
pnpm exec wrangler secret put WORKER_API_TOKEN
```

本地开发可复制 `.dev.vars.example` 为 `.dev.vars` 并填写测试值；`.dev.vars*` 已被 gitignore 忽略。

## 部署并连接 Email Routing

```bash
pnpm run deploy
```

然后在 Cloudflare Dashboard 中：

1. 打开 **Compute > Email Service > Email Routing**，按引导启用目标域名；Cloudflare 会配置所需 MX/TXT 记录。
2. 打开 **Routing Rules > Create routing rule**。
3. 选择具体收件地址的 local part，或按需要配置 catch-all。
4. Action 选择 **Send to a Worker**，并选择 `email-fallback-worker`。
5. 启用规则后发送测试邮件，检查 Worker 日志、VPS 和 R2。

重命名 Worker 后需重新选择 Email Routing 规则中的 Worker。

## VPS `/push` 协议

Worker 最多等待约 10 秒，并请求 `${VPS_BASE_URL}/push`。如果基础 URL 含路径，该路径会保留，例如 `https://example.net/daemon` 变成 `https://example.net/daemon/push`。

```http
POST /push
Authorization: Bearer <VPS_PUSH_TOKEN>
Content-Type: message/rfc822
X-Mail-ID: <64-char lowercase sha256>
X-Mail-From: <envelope sender>
X-Mail-To: <envelope recipient>

<完整原始 RFC822/MIME bytes>
```

只有 2xx 表示成功。VPS 应先按 `X-Mail-ID` 幂等、可靠地保存 body，再返回 2xx。不要依据 MIME `Message-ID` 去重。

## Worker HTTP API

完整的机器可读接口定义见 [`openapi.yaml`](./openapi.yaml)，可导入 Swagger UI、Redoc 或支持 OpenAPI 3.1 的客户端工具。该文件只描述 Worker 提供的 `/list`、`/mail` 和 `/confirm`；VPS daemon 提供的 `/push` 不属于 Worker API。

所有 `/list`、`/mail` 和 `/confirm` 请求都必须带：

```http
Authorization: Bearer <WORKER_API_TOKEN>
```

token 不支持 query string。未授权返回 401，错误 method 返回 405，未知路径返回 404。错误响应不会包含 token、stack trace 或 Cloudflare 内部异常。

### 列出 pending 邮件

`limit` 必填，必须是 1–100 的整数。响应中的 `completed` 是 boolean；`true` 表示本次列出时已到达 pending 列表末尾，`false` 表示确认当前批次后还应继续调用 `/list`。

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $WORKER_API_TOKEN" \
  "https://email-fallback-worker.<subdomain>.workers.dev/list?limit=100"
```

```json
{
  "ids": [
    "3f523f3f07453d8b680088dc84d427b87050385b93b4bc32de3127b843e73122"
  ],
  "completed": false
}
```

### 下载原始邮件

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $WORKER_API_TOKEN" \
  "https://email-fallback-worker.<subdomain>.workers.dev/mail?id=$MAIL_ID" \
  --output "$MAIL_ID.eml"
```

存在时返回 `Content-Type: message/rfc822`、`Content-Length`、`X-Mail-ID`、envelope 元数据和原始字节流；不存在返回 404。`id` 仅接受 64 位 hex，输入可为大小写，内部统一为小写。

`/list` 和 `/mail` 都不会删除对象。在 `/confirm` 前重复调用它们会得到相同邮件，这是至少一次投递协议的预期行为。VPS 应按 `X-Mail-ID` 幂等、可靠落盘，只确认已经成功保存的 ID。

### 确认并删除

VPS 只有在邮件已可靠保存后才应调用：

```bash
curl --fail-with-body \
  -X POST \
  -H "Authorization: Bearer $WORKER_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"ids":["<sha256>"]}' \
  "https://email-fallback-worker.<subdomain>.workers.dev/confirm"
```

单次最多 100 个 ID。删除是幂等的：对象已经不存在仍返回成功。

```json
{"ok":true,"confirmed":1}
```

## 本地开发与验证

```bash
cp .dev.vars.example .dev.vars
pnpm run dev
pnpm run typecheck
pnpm test -- --run
```

Vitest 使用本地隔离的 R2 binding。Email Routing 的真实 SMTP 接入仍需部署后测试。`pnpm run dev` 启动后也可使用 Wrangler 输出的 Local Explorer 查看 R2 对象与请求日志。

## 需要手动完成的 Cloudflare 配置

1. 创建 R2 bucket `email-worker-mail`，或修改配置为你已有的 bucket。
2. 确认 Worker 的 R2 binding 名为 `MAIL_BUCKET`。
3. 用 `wrangler secret put` 设置 `VPS_BASE_URL`、`VPS_PUSH_TOKEN`、`WORKER_API_TOKEN`。
4. 部署 Worker，并为其保留可供 VPS 访问的 HTTP URL（`workers.dev` 或自定义域）。
5. 为域名启用 Email Routing/MX 记录，并创建 **Send to a Worker** 的 routing rule。
6. 在 VPS daemon 配置相同 token、Worker URL、每次启动及每 60 分钟执行的 `/list`、`/mail`、`/confirm` 补投流程。

相关 Cloudflare 文档：[Email Routing 设置](https://developers.cloudflare.com/email-service/get-started/route-emails/)、[Email Worker handler](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)、[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)。
