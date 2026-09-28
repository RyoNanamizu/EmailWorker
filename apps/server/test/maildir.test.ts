import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addReturnPath, initMailDir } from "../src/maildir.js";

const temporaryPath = async (): Promise<string> => {
  return mkdtemp(join(tmpdir(), "mail-receiver-test-"));
};

const assertMaildir = async (root: string): Promise<void> => {
  for (const directory of ["tmp", "new", "cur"]) {
    assert.equal((await stat(join(root, directory))).isDirectory(), true);
  }
};

test("Maildir initialization creates tmp, new, and cur and is idempotent", async () => {
  const root = join(await temporaryPath(), "Maildir");
  const first = await initMailDir(root);
  await assertMaildir(root);
  const second = await initMailDir(root);
  await assertMaildir(root);
  assert.equal(first.rootPath, root);
  assert.equal(second.rootPath, root);
});

test("Maildir initialization fills in missing directories", async () => {
  const root = join(await temporaryPath(), "Maildir");
  await mkdir(join(root, "tmp"), { recursive: true });
  await initMailDir(root);
  await assertMaildir(root);
});

test("Maildir initialization propagates filesystem errors", async () => {
  const root = join(await temporaryPath(), "not-a-directory");
  await writeFile(root, "file");
  await assert.rejects(initMailDir(root));
});

test("write prepends an empty Return-Path, stores the message in new, and leaves tmp empty", async () => {
  const root = join(await temporaryPath(), "Maildir");
  const maildir = await initMailDir(root);
  const message = Buffer.from("Subject: test\r\n\r\nHello\r\n");

  await maildir.write(message);

  assert.deepEqual(await readdir(join(root, "tmp")), []);
  const files = await readdir(join(root, "new"));
  assert.equal(files.length, 1);
  assert.deepEqual(await readFile(join(root, "new", files[0]!)), addReturnPath(message));
});

test("write includes the envelope sender in Return-Path", async () => {
  const root = join(await temporaryPath(), "Maildir");
  const maildir = await initMailDir(root);
  const message = Buffer.from("Subject: test\r\n\r\nHello\r\n");

  await maildir.write(message, "sender@example.com");

  const files = await readdir(join(root, "new"));
  assert.equal(files.length, 1);
  assert.deepEqual(
    await readFile(join(root, "new", files[0]!)),
    addReturnPath(message, "sender@example.com"),
  );
});

test("addReturnPath replaces existing Return-Path headers and their continuations", () => {
  const message = Buffer.from([
    "rEtUrN-pAtH: <untrusted@example.com>",
    "\tcontinued-untrusted-value",
    "Subject: test",
    "Return-Path: <also-untrusted@example.com>",
    " X-Untrusted: continuation",
    "From: sender@example.com",
    "",
    "Return-Path: body text must be preserved",
    "",
  ].join("\r\n"));

  assert.deepEqual(
    addReturnPath(message, "trusted@example.com"),
    Buffer.from([
      "Return-Path: <trusted@example.com>",
      "Subject: test",
      "From: sender@example.com",
      "",
      "Return-Path: body text must be preserved",
      "",
    ].join("\r\n")),
  );
});

test("addReturnPath supports a UTF-8 envelope sender without changing other message bytes", () => {
  const message = Buffer.concat([
    Buffer.from("Subject: test\r\n\r\n"),
    Buffer.from([0x00, 0x80, 0xff]),
  ]);

  assert.deepEqual(
    addReturnPath(message, "用户@example.com"),
    Buffer.concat([
      Buffer.from("Return-Path: <用户@example.com>\r\n", "utf8"),
      message,
    ]),
  );
});

test("addReturnPath preserves a null SMTP reverse-path", () => {
  const message = Buffer.from("Subject: delivery status\r\n\r\nHello\r\n");

  assert.deepEqual(
    addReturnPath(message, "<>"),
    Buffer.concat([
      Buffer.from("Return-Path: <>\r\n"),
      message,
    ]),
  );
});

test("concurrent writes use unique names and preserve every message", async () => {
  const root = join(await temporaryPath(), "Maildir");
  const maildir = await initMailDir(root);
  const messages = Array.from({ length: 20 }, (_, index) => Buffer.from(`message-${index}`));

  await Promise.all(messages.map((message) => maildir.write(message)));

  assert.deepEqual(await readdir(join(root, "tmp")), []);
  const files = await readdir(join(root, "new"));
  assert.equal(files.length, messages.length);
  const stored = await Promise.all(files.map((file) => readFile(join(root, "new", file), "utf8")));
  assert.deepEqual(
    stored.sort(),
    messages.map((message) => addReturnPath(message).toString()).sort(),
  );
});
