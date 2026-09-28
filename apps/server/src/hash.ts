import { createHash } from "node:crypto";
import { SHA256_HEX_PATTERN } from "./constants.js";

/** Validate and normalize a caller-provided SHA-256 hexadecimal digest. */
export const normalizeSha256 = (value: string): string | null => {
  return SHA256_HEX_PATTERN.test(value) ? value.toLowerCase() : null;
};

/** Hash the exact bytes supplied by the HTTP client. */
export const sha256Hex = (raw: Buffer): string => {
  return createHash("sha256").update(raw).digest("hex");
};
