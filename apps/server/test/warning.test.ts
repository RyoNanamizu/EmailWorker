import assert from "node:assert/strict";
import { test } from "node:test";
import { generateWarningMail } from "../src/warning.js";

const input = {
  expectedHash: "a".repeat(64),
  actualHash: "b".repeat(64),
  envelopeFrom: "sender@example.com",
  envelopeTo: "recipient@example.com",
  receivedAt: new Date("2026-01-02T03:04:05.000Z"),
};

test("warning generator returns a complete RFC822 Buffer", () => {
  const result = generateWarningMail(input);
  const message = result.toString("utf8");

  assert.ok(Buffer.isBuffer(result));
  assert.match(message, /^From: warning@localhost\r\nTo: warning@localhost\r\n/);
  assert.match(message, /\r\nDate: Fri, 02 Jan 2026 03:04:05 GMT\r\n/);
  assert.match(message, /\r\nMessage-ID: <warning-.+@localhost>\r\n/);
  assert.match(message, /\r\nSubject: Mail integrity warning: SHA-256 mismatch\r\n/);
  assert.match(message, /\r\nMIME-Version: 1\.0\r\n/);
  assert.match(message, /\r\nContent-Type: text\/plain; charset=utf-8\r\n/);
  assert.match(message, /\r\nContent-Transfer-Encoding: 8bit\r\n\r\n/);
  for (const value of [input.expectedHash, input.actualHash, input.envelopeFrom, input.envelopeTo]) {
    assert.ok(message.includes(value));
  }
  assert.ok(message.includes(input.receivedAt.toISOString()));
});

test("warning generator uses unknown envelope values and unique Message-IDs", () => {
  const first = generateWarningMail({ expectedHash: "a".repeat(64), actualHash: "b".repeat(64) }).toString();
  const second = generateWarningMail({ expectedHash: "a".repeat(64), actualHash: "b".repeat(64) }).toString();
  const messageId = (message: string): string => /Message-ID: (.+)\r\n/.exec(message)?.[1] ?? "";

  assert.equal((first.match(/<unknown>/g) ?? []).length, 2);
  assert.notEqual(messageId(first), messageId(second));
});
