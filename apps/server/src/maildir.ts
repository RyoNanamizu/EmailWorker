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

const CRLF = Buffer.from("\r\n");
const LF = Buffer.from("\n");
const CRLF_HEADER_SEPARATOR = Buffer.concat([CRLF, CRLF]);
const LF_HEADER_SEPARATOR = Buffer.concat([LF, LF]);
/**
 * Match every complete Return-Path header field:
 * - `^Return-Path:` finds the field name at the start of a header line (`i` ignores case);
 * - `[^\r\n]*` consumes the value on that first line;
 * - `(?:\r?\n[ \t][^\r\n]*)*` consumes folded continuation lines, which start with space or tab;
 * - `(?:\r?\n|$)` consumes the field's final line ending, or accepts end of input;
 * - `g` removes all occurrences and `m` makes `^` apply to every header line.
 */
const RETURN_PATH_HEADER = /^Return-Path:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*(?:\r?\n|$)/gim;

/**
 * Find the end of the header slice that may be edited.
 *
 * An empty line separates the headers from the body, represented by either
 * `CRLF CRLF` or `LF LF`. The returned offset is between those two line
 * endings: the editable slice retains the line ending of the final header,
 * while the unedited remainder starts with the empty line before the body.
 * If no separator exists, the entire input is treated as the header section.
 */
const headerEnd = (raw: Buffer): number => {
  const crlfSeparator = raw.indexOf(CRLF_HEADER_SEPARATOR);
  const lfSeparator = raw.indexOf(LF_HEADER_SEPARATOR);

  if (crlfSeparator !== -1 && (lfSeparator === -1 || crlfSeparator < lfSeparator)) {
    return crlfSeparator + CRLF.length;
  }
  if (lfSeparator !== -1) {
    return lfSeparator + LF.length;
  }
  return raw.length;
};

/**
 * Remove every Return-Path field from the message's header section, including
 * any folded continuation lines. The body is never searched or modified, so
 * text such as `Return-Path:` in the body remains intact.
 *
 * The header slice is decoded and re-encoded with latin1 because it maps each
 * byte to one character and back without changing the untouched bytes. The
 * original body Buffer is then appended directly.
 */
const removeReturnPathHeaders = (raw: Buffer): Buffer => {
  const end = headerEnd(raw);
  const headers = raw.subarray(0, end).toString("latin1");
  const headersWithoutReturnPath = headers.replace(RETURN_PATH_HEADER, "");

  return Buffer.concat([
    Buffer.from(headersWithoutReturnPath, "latin1"),
    raw.subarray(end),
  ]);
};

export const addReturnPath = (raw: Buffer, envelopeFrom?: string): Buffer => {
  const returnPath = !envelopeFrom || envelopeFrom === "<>" ? "<>" : `<${envelopeFrom}>`;

  return Buffer.concat([
    Buffer.from(`Return-Path: ${returnPath}\r\n`, "utf8"),
    removeReturnPathHeaders(raw),
  ]);
};
