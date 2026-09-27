# Email Receiver Server

一个基于 Node.js 22 和 TypeScript 的轻量邮件接收服务。第一阶段通过 HTTP 接收原始 RFC822/MIME 字节、校验调用方提供的 SHA-256，并为未来的投递/持久化流程提供清晰接口。项目只使用 Node.js 标准库处理运行时逻辑。

完整的阶段范围、响应语义和非目标见 [`REQUIREMENTS.md`](./REQUIREMENTS.md)。

## 安装与运行

需要 Node.js 22+ 和 pnpm。

```bash
pnpm install
pnpm run typecheck
pnpm run build
pnpm test
pnpm start         # 运行 dist/src/index.js，需先 build
```

配置项：

- `LISTEN_HOST`：监听地址，默认 `0.0.0.0`
- `LISTEN_PORT`：监听端口，默认 `8080`

`GET /health` 返回 `{ "ok": true }`。

## 接收 API

`POST /push/<hash>` 接收 `Content-Type: message/rfc822` 的完整请求体。`hash` 必须是 64 位十六进制 SHA-256；大写输入会被规范化为小写。摘要直接基于原始 `Buffer` 计算，不会解码、修改换行或重新序列化邮件。

```bash
sha256=$(sha256sum mail.eml | cut -d ' ' -f 1)
curl \
  -X POST \
  -H 'Content-Type: message/rfc822' \
  --data-binary @mail.eml \
  "http://localhost:8080/push/$sha256"
```

摘要相符和不相符都会返回 `204 No Content`。不相符表示 HTTP 投递成功，但传给 `handleValidatedMail` 的结构化数据中 `hashValid` 为 `false`；它不是 5xx 服务错误。非法摘要、错误 method、错误媒体类型及未知路径分别返回 400、405、415 和 404。

## 独立模块

- `generateWarningMail(input)` 返回一封完整 warning 邮件的 `Buffer`，不访问 HTTP 或文件系统。
- `await initMailDir(path)` 幂等创建 `tmp/`、`new/` 和 `cur/`，并返回可用的 Maildir 对象。`maildir.write(buffer)` 先将完整邮件同步写入 `tmp/`，再移动到 `new/`。
- `handleValidatedMail(mail)` 是后续投递/持久化的 TODO 边界。

## Docker

```bash
docker build -t email-receiver .
docker run --rm -p 8080:8080 email-receiver
```

镜像使用 Node.js 22 multi-stage build，默认在容器内监听 `0.0.0.0:8080`。
