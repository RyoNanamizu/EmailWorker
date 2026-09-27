import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface Maildir {
  readonly rootPath: string;
  write(message: Buffer, hashname: string): Promise<void>;
}

const writeMail = async (rootPath: string, message: Buffer, hashname: string): Promise<void> => {
  const filename = `${Date.now()}.${process.pid}.${randomUUID()}`;
  const temporaryPath = join(rootPath, "tmp", hashname);
  const destinationPath = join(rootPath, "new", filename);
  const file = await open(temporaryPath, "wx");

  try {
    await file.writeFile(message);
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
export const initMailDir = async (rootPath: string): Promise<Maildir> => {
  for (const directory of ["tmp", "new", "cur"] as const) {
    await mkdir(join(rootPath, directory), { recursive: true });
  }

  return {
    rootPath,
    write: (message, hashname) => writeMail(rootPath, message, hashname),
  };
};
