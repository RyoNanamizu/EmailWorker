import assert from "node:assert/strict";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initializeMaildir, Maildir } from "../src/maildir.js";

async function temporaryPath(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mail-receiver-test-"));
}

async function assertMaildir(root: string): Promise<void> {
  for (const directory of ["tmp", "new", "cur"]) {
    assert.equal((await stat(join(root, directory))).isDirectory(), true);
  }
}

test("Maildir initialization creates tmp, new, and cur and is idempotent", async () => {
  const root = join(await temporaryPath(), "Maildir");
  const maildir = new Maildir(root);
  await maildir.initialize();
  await assertMaildir(root);
  await maildir.initialize();
  await assertMaildir(root);
});

test("Maildir initialization fills in missing directories", async () => {
  const root = join(await temporaryPath(), "Maildir");
  await mkdir(join(root, "tmp"), { recursive: true });
  await initializeMaildir(root);
  await assertMaildir(root);
});

test("Maildir initialization propagates filesystem errors", async () => {
  const root = join(await temporaryPath(), "not-a-directory");
  await writeFile(root, "file");
  await assert.rejects(initializeMaildir(root));
});
