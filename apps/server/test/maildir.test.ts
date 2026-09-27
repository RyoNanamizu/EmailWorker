import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initMailDir } from "../src/maildir.js";

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

test("write stores the complete message in new and leaves tmp empty", async () => {
  const root = join(await temporaryPath(), "Maildir");
  const maildir = await initMailDir(root);
  const message = Buffer.from("Subject: test\r\n\r\nHello\r\n");

  await maildir.write(message);

  assert.deepEqual(await readdir(join(root, "tmp")), []);
  const files = await readdir(join(root, "new"));
  assert.equal(files.length, 1);
  assert.deepEqual(await readFile(join(root, "new", files[0]!)), message);
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
  assert.deepEqual(stored.sort(), messages.map((message) => message.toString()).sort());
});
