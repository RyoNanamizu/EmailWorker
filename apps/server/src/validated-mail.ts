export interface ValidatedMail {
  expectedHash: string;
  actualHash: string;
  hashValid: boolean;
  raw: Buffer;
}

/**
 * Boundary for a future persistence/delivery pipeline.
 *
 * A hash mismatch is deliberately represented as data (`hashValid: false`),
 * not as an exception or an HTTP delivery failure.
 */
export async function handleValidatedMail(_mail: ValidatedMail): Promise<void> {
  // TODO: connect validated mail to warning generation and/or persistence.
}

export type ValidatedMailHandler = (mail: ValidatedMail) => Promise<void> | void;
