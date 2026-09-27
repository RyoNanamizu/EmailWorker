import { createHash } from "node:crypto";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createMailServer } from "../src/server.js";
import type { ValidatedMail } from "../src/validated-mail.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function start(onValidatedMail?: (mail: ValidatedMail) => void): Promise<number> {
  const server = createMailServer(onValidatedMail ? { onValidatedMail } : {});
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

interface ResponseData {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

async function send(
  port: number,
  path: string,
  body: Buffer = Buffer.alloc(0),
  method = "POST",
  contentType = "message/rfc822",
): Promise<ResponseData> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { "content-type": contentType } }, (res) => {
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
}

test("POST /push accepts a matching digest and preserves exact raw bytes", async () => {
  const raw = Buffer.concat([
    Buffer.from("From: sender@example.com\r\nSubject: café\r\n\r\n", "utf8"),
    Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x80]),
  ]);
  const expected = createHash("sha256").update(raw).digest("hex");
  let delivered: ValidatedMail | undefined;
  const port = await start((mail) => { delivered = mail; });

  const response = await send(port, `/push/${expected}`, raw);

  assert.equal(response.status, 204);
  assert.equal(delivered?.hashValid, true);
  assert.equal(delivered?.expectedHash, expected);
  assert.equal(delivered?.actualHash, expected);
  assert.deepEqual(delivered?.raw, raw);
});

test("a digest mismatch is structured data and still returns 204", async () => {
  const raw = Buffer.from("raw mail\r\n", "utf8");
  const expected = "0".repeat(64);
  let delivered: ValidatedMail | undefined;
  const port = await start((mail) => { delivered = mail; });

  const response = await send(port, `/push/${expected}`, raw);

  assert.equal(response.status, 204);
  assert.equal(delivered?.hashValid, false);
  assert.equal(delivered?.actualHash, createHash("sha256").update(raw).digest("hex"));
});

test("uppercase digest is accepted and normalized", async () => {
  const raw = Buffer.from("message", "utf8");
  const uppercase = createHash("sha256").update(raw).digest("hex").toUpperCase();
  let delivered: ValidatedMail | undefined;
  const port = await start((mail) => { delivered = mail; });

  assert.equal((await send(port, `/push/${uppercase}`, raw)).status, 204);
  assert.equal(delivered?.expectedHash, uppercase.toLowerCase());
  assert.equal(delivered?.hashValid, true);
});

test("invalid digest returns 400 without invoking the handler", async () => {
  let called = false;
  const port = await start(() => { called = true; });
  assert.equal((await send(port, "/push/not-a-sha256")).status, 400);
  assert.equal(called, false);
});

test("non-POST push request returns 405 and an Allow header", async () => {
  const port = await start();
  const response = await send(port, `/push/${"0".repeat(64)}`, Buffer.alloc(0), "GET");
  assert.equal(response.status, 405);
  assert.equal(response.headers.allow, "POST");
});

test("incorrect content type returns 415", async () => {
  const port = await start();
  assert.equal((await send(port, `/push/${"0".repeat(64)}`, Buffer.from("x"), "POST", "text/plain")).status, 415);
});

test("unknown paths return 404 and health check returns JSON", async () => {
  const port = await start();
  assert.equal((await send(port, "/unknown")).status, 404);
  const health = await send(port, "/health", Buffer.alloc(0), "GET");
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body.toString("utf8")), { ok: true });
});
