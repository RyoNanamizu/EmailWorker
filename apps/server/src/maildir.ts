import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_MAILDIR_PATH, MAILDIR_DIRECTORIES } from "./constants.js";

const writeMail = (rootPath: string) => async (message: Buffer, returnPath?: string,): Promise<void> => {
  const filename = `${Date.now()}.${process.pid}.${randomUUID()}`;
  const temporaryPath = join(rootPath, "tmp", filename);
  const destinationPath = join(rootPath, "new", filename);
  const file = await open(temporaryPath, "wx");
  const editedMail = addReturnPath(message, returnPath)

  try {
    await file.writeFile(editedMail);
    await file.sync();
    await file.close();
    await rename(temporaryPath, destinationPath);
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
};

/** Ensure the standard Maildir directories exist and return a ready-to-use instance. */
export const initMailDir = async (rootPath: string = DEFAULT_MAILDIR_PATH) => {
  for (const directory of MAILDIR_DIRECTORIES) {
    await mkdir(join(rootPath, directory), { recursive: true });
  }

  return {
    rootPath,
    write: writeMail(rootPath),
  };
};

export type typeMaildir = Awaited<ReturnType<typeof initMailDir>>

export const addReturnPath = (raw: Buffer, envelopeFrom?: string): Buffer => {
  const returnPath = envelopeFrom ? `<${envelopeFrom}>` : "<>";

  return Buffer.concat([
    Buffer.from(`Return-Path: ${returnPath}\r\n`, "ascii"),
    raw,
  ]);
};
