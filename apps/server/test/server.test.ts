import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import type { typeMaildir } from "../src/maildir.js";
import { createMailServer } from "../src/server.js";

interface RecordedWrite {
  message: Buffer;
  returnPath: string | undefined;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

const recordingMaildir = (): { maildir: typeMaildir; writes: RecordedWrite[] } => {
  const writes: RecordedWrite[] = [];
  return {
    maildir: {
      rootPath: "unused",
      write: async (message, returnPath) => {
        writes.push({ message: Buffer.from(message), returnPath });
      },
    },
    writes,
  };
};

const start = async (maildir: typeMaildir): Promise<number> => {
  const server = createMailServer({ maildir });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return (server.address() as AddressInfo).port;
};

interface ResponseData {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

const send = async (
  port: number,
  path: string,
  body: Buffer = Buffer.alloc(0),
  method = "POST",
  contentType = "message/rfc822",
  headers: Record<string, string> = {},
): Promise<ResponseData> => {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: { "content-type": contentType, ...headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.once("error", reject);
    req.end(body);
  });
};

test("POST /push stores matching raw bytes and envelope sender", async () => {
  const raw = Buffer.concat([
    Buffer.from("From: sender@example.com\r\nSubject: café\r\n\r\n", "utf8"),
    Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x80]),
  ]);
  const expected = createHash("sha256").update(raw).digest("hex");
  const { maildir, writes } = recordingMaildir();
  const port = await start(maildir);

  const response = await send(port, `/push/${expected}`, raw, "POST", "message/rfc822", {
    "x-mail-from": "sender@example.com",
  });

  assert.equal(response.status, 204);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]?.message, raw);
  assert.equal(writes[0]?.returnPath, "sender@example.com");
});

test("a digest mismatch stores the original and a warning mail", async () => {
  const raw = Buffer.from("raw mail\r\n", "utf8");
  const expected = "0".repeat(64);
  const actual = createHash("sha256").update(raw).digest("hex");
  const { maildir, writes } = recordingMaildir();
  const port = await start(maildir);

  const response = await send(port, `/push/${expected}`, raw, "POST", "message/rfc822", {
    "x-mail-from": "sender@example.com",
    "x-mail-to": "recipient@example.com",
    "x-mail-received-at": "2026-01-02T03:04:05.000Z",
  });

  assert.equal(response.status, 204);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0]?.message, raw);
  assert.equal(writes[0]?.returnPath, "sender@example.com");
  assert.equal(writes[1]?.returnPath, undefined);
  const warning = writes[1]?.message.toString("utf8") ?? "";
  for (const value of [expected, actual, "sender@example.com", "recipient@example.com", "2026-01-02T03:04:05.000Z"]) {
    assert.ok(warning.includes(value));
  }
});

test("an invalid received-at header falls back to a valid current date", async () => {
  const raw = Buffer.from("mismatch", "utf8");
  const { maildir, writes } = recordingMaildir();
  const port = await start(maildir);

  const response = await send(port, `/push/${"0".repeat(64)}`, raw, "POST", "message/rfc822", {
    "x-mail-received-at": "not-a-date",
  });

  assert.equal(response.status, 204);
  assert.equal(writes.length, 2);
  const warning = writes[1]?.message.toString("utf8") ?? "";
  const receivedAt = /Received at:\r\n([^\r]+)\r\n/.exec(warning)?.[1];
  assert.ok(receivedAt);
  assert.equal(Number.isNaN(new Date(receivedAt).getTime()), false);
});

test("uppercase digest is accepted without generating a warning", async () => {
  const raw = Buffer.from("message", "utf8");
  const uppercase = createHash("sha256").update(raw).digest("hex").toUpperCase();
  const { maildir, writes } = recordingMaildir();
  const port = await start(maildir);

  assert.equal((await send(port, `/push/${uppercase}`, raw)).status, 204);
  assert.equal(writes.length, 1);
});

test("invalid digest returns 400 without writing mail", async () => {
  const { maildir, writes } = recordingMaildir();
  const port = await start(maildir);

  assert.equal((await send(port, "/push/not-a-sha256")).status, 400);
  assert.equal(writes.length, 0);
});

test("maildir write failures are awaited and return 500", async (context) => {
  context.mock.method(console, "error", () => undefined);
  const maildir: typeMaildir = {
    rootPath: "unused",
    write: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error("disk failure");
    },
  };
  const port = await start(maildir);
  const raw = Buffer.from("message", "utf8");
  const expected = createHash("sha256").update(raw).digest("hex");

  assert.equal((await send(port, `/push/${expected}`, raw)).status, 500);
});

test("non-POST push request returns 405 and an Allow header", async () => {
  const { maildir } = recordingMaildir();
  const port = await start(maildir);
  const response = await send(port, `/push/${"0".repeat(64)}`, Buffer.alloc(0), "GET");

  assert.equal(response.status, 405);
  assert.equal(response.headers.allow, "POST");
});

test("incorrect content type returns 415", async () => {
  const { maildir } = recordingMaildir();
  const port = await start(maildir);

  assert.equal((await send(port, `/push/${"0".repeat(64)}`, Buffer.from("x"), "POST", "text/plain")).status, 415);
});

test("unknown paths return 404 and health check returns JSON", async () => {
  const { maildir } = recordingMaildir();
  const port = await start(maildir);

  assert.equal((await send(port, "/unknown")).status, 404);
  const health = await send(port, "/health", Buffer.alloc(0), "GET");
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body.toString("utf8")), { ok: true });
});
