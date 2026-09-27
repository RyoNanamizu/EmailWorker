import { createHash } from "node:crypto";

const SHA256_HEX = /^[0-9a-f]{64}$/i;

/** Validate and normalize a caller-provided SHA-256 hexadecimal digest. */
export function normalizeSha256(value: string): string | null {
  return SHA256_HEX.test(value) ? value.toLowerCase() : null;
}

/** Hash the exact bytes supplied by the HTTP client. */
export function sha256Hex(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}
