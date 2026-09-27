import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export class Maildir {
  public constructor(public readonly rootPath: string) {}

  /** Create the standard Maildir directories. Safe to call repeatedly. */
  public async initialize(): Promise<void> {
    for (const directory of ["tmp", "new", "cur"] as const) {
      await mkdir(join(this.rootPath, directory), { recursive: true });
    }
  }
}

export async function initializeMaildir(rootPath: string): Promise<void> {
  await new Maildir(rootPath).initialize();
}
