import { randomUUID } from "node:crypto";

export interface WarningMailInput {
  expectedHash: string;
  actualHash: string;
  envelopeFrom?: string;
  envelopeTo?: string;
  receivedAt?: Date;
}

function bodyValue(value: string | undefined): string {
  if (value === undefined || value === "") return "<unknown>";
  return value.replace(/[\r\n]+/g, " ");
}

/** Generate a standalone RFC822 warning message without doing any I/O. */
export function generateWarningMail(input: WarningMailInput): Buffer {
  const receivedAt = input.receivedAt ?? new Date();
  const messageId = `<warning-${receivedAt.getTime()}-${randomUUID()}@localhost>`;
  const lines = [
    "From: warning@localhost",
    "To: warning@localhost",
    `Date: ${receivedAt.toUTCString()}`,
    `Message-ID: ${messageId}`,
    "Subject: Mail integrity warning: SHA-256 mismatch",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    "A mail integrity check failed.",
    "",
    "Expected SHA-256:",
    input.expectedHash,
    "",
    "Actual SHA-256:",
    input.actualHash,
    "",
    "Envelope sender:",
    bodyValue(input.envelopeFrom),
    "",
    "Envelope recipient:",
    bodyValue(input.envelopeTo),
    "",
    "Received at:",
    receivedAt.toISOString(),
    "",
  ];

  return Buffer.from(lines.join("\r\n"), "utf8");
}
