# 第一阶段需求澄清

本文档用于明确基础邮件接收服务第一阶段的实现范围与验收口径。若本文档与原始需求冲突，以原始需求为准。

## 1. 阶段目标

本阶段只建立邮件接收、完整性校验及后续处理所需的基础边界：

1. 通过 HTTP 接收完整的 RFC822/MIME 邮件原始字节。
2. 使用 URL 中的 SHA-256 与原始请求体的 SHA-256 进行比较。
3. 将比较结果作为结构化数据交给后续处理接口。
4. 独立提供 warning 邮件生成能力。
5. 独立提供 Maildir 基础目录初始化能力。

本阶段不负责把收到的邮件写入 Maildir，也不负责实际投递、持久化或 MIME 解析。

## 2. HTTP 接口

### `POST /push/<hash>`

- `<hash>` 必须恰好为 64 个十六进制字符。
- URL 中允许大小写十六进制；进入内部逻辑后统一转换为小写。
- 请求的媒体类型必须为 `message/rfc822`。允许附带合法参数，例如 `message/rfc822; charset=utf-8`。
- 请求体被完整读入 `Buffer`。
- SHA-256 必须基于收到的原始字节计算，不得先转为字符串、解析 MIME、重新序列化或修改换行和编码。

响应语义：

| 情况 | HTTP 状态 |
| --- | ---: |
| hash 格式合法且摘要相符 | 204 |
| hash 格式合法但摘要不相符 | 204 |
| hash 格式非法 | 400 |
| `/push/` 路径使用非 POST method | 405 |
| `Content-Type` 不是 `message/rfc822` | 415 |
| 未知路径 | 404 |
| 请求读取或内部处理发生真正异常 | 500 |

摘要不相符代表邮件已经成功送达校验层，不属于 HTTP 投递失败，因此禁止仅因 mismatch 返回任何 5xx。

### `GET /health`

健康检查返回 HTTP 200：

```json
{
  "ok": true
}
```

## 3. 校验结果边界

HTTP 层将以下结构传递给后续 handler：

```ts
interface ValidatedMail {
  expectedHash: string;
  actualHash: string;
  hashValid: boolean;
  raw: Buffer;
}
```

- `expectedHash` 和 `actualHash` 均为小写十六进制。
- `hashValid` 明确表达摘要是否相符。
- `raw` 必须与 HTTP 请求体逐字节一致。
- handler 对 hash 相符和不相符两种情况都会被调用。
- 当前默认 handler 是无副作用的 TODO 扩展点。

如果 handler 本身抛出异常，则属于内部处理失败，可以返回 500；这与单纯的 hash mismatch 不同。

## 4. Warning 邮件生成器

生成器是纯内存模块：

- 输入包括 expected hash、actual hash、可选 envelope sender、可选 envelope recipient 和可选接收时间。
- 输出必须是包含完整 RFC822 邮件的 `Buffer`。
- 邮件使用 CRLF 行结束符。
- 固定包含 `From`、`To`、`Date`、`Message-ID`、`Subject`、`MIME-Version`、`Content-Type` 和 `Content-Transfer-Encoding` header。
- 正文包含两个 hash、envelope sender、envelope recipient 和接收时间。
- 缺失的 envelope 值写为 `<unknown>`。
- 每次调用生成唯一的 Message-ID。

该模块不访问 HTTP、Maildir 或其他文件系统资源。

## 5. Maildir 模块

Maildir 初始化只确保以下目录存在：

```text
<root>/tmp/
<root>/new/
<root>/cur/
```

- 首次调用创建缺失目录。
- 重复调用正常成功。
- 仅存在部分目录时补全其余目录。
- 文件系统错误不得静默吞掉，应向调用方抛出。
- 本阶段不提供邮件写入或移动操作。

## 6. 配置与运行

- 运行环境：Node.js 22 或更高版本。
- 包管理器：pnpm。
- `LISTEN_HOST` 默认值为 `0.0.0.0`。
- `LISTEN_PORT` 默认值为 `8080`。
- `LISTEN_PORT` 必须是 0 至 65535 之间的整数；端口 0 用于测试时由系统分配端口。

必须提供：

```text
pnpm run build
pnpm run typecheck
pnpm test
pnpm start
```

## 7. Docker

- 使用 Node.js 22 基础镜像和 multi-stage build。
- 最终镜像只包含运行服务所需文件。
- 默认监听 `0.0.0.0:8080`。
- 声明 `EXPOSE 8080`。
- `docker build .` 必须成功。

## 8. 非目标

以下能力明确不属于第一阶段：

- MIME 内容解析或重写。
- 邮件写入 Maildir。
- 数据库或其他持久化。
- 根据 mismatch 自动发送或投递 warning 邮件。
- 用户认证、授权或限流。
- 请求体大小限制、队列、重试和恢复机制。
- SMTP 接收服务。

这些能力可以在未来阶段通过 `handleValidatedMail` 边界接入，而不改变本阶段 hash mismatch 的 HTTP 204 语义。

## 9. 验收标准

1. 合法且匹配的 hash 返回 204，并产生 `hashValid: true`。
2. 合法但不匹配的 hash 返回 204，并产生 `hashValid: false`。
3. 大写 hash 被接受并规范化为小写。
4. 非法 hash、错误 method、错误媒体类型和未知路径返回约定状态码。
5. 包含 CRLF、非 ASCII 和二进制字节的请求体能够逐字节保留并正确计算摘要。
6. warning 生成器返回完整 RFC822 `Buffer`，必要字段齐全且 Message-ID 不重复。
7. Maildir 初始化能够创建、补全并重复初始化标准目录，同时正确传播文件系统错误。
8. 类型检查、构建、测试和 Docker 构建全部通过。
