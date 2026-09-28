import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  BEARER_AUTH_PREFIX,
  BEARER_AUTH_SCHEME,
  MAIL_FROM_HEADER,
  MAIL_MEDIA_TYPE,
  MAIL_RECEIVED_AT_HEADER,
  MAIL_TO_HEADER,
  PUSH_PATH_PREFIX,
} from "./constants.js";
import { normalizeSha256, sha256Hex } from "./hash.js";
import { type typeMaildir } from "./maildir.js";
import { generateWarningMail } from "./warning.js";

const sendText = (response: ServerResponse, status: number, body: string): void => {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(body);
};

const mediaType = (request: IncomingMessage): string | undefined => {
  return request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
};

const readRawBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

interface MailServerOptions {
  maildir: typeMaildir;
  bearerToken: string;
}

export const createMailServer = (options: MailServerOptions): Server => {
  if (options.bearerToken.length === 0) {
    throw new Error("bearerToken must not be empty");
  }

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      if (!url.pathname.startsWith(PUSH_PATH_PREFIX)) {
        sendText(response, 404, "Not Found\n");
        return;
      }

      if (!hasValidBearerToken(request, options.bearerToken)) {
        response.setHeader("www-authenticate", BEARER_AUTH_SCHEME);
        sendText(response, 401, "Unauthorized\n");
        return;
      }

      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        sendText(response, 405, "Method Not Allowed\n");
        return;
      }

      const expectedHash = normalizeSha256(url.pathname.slice(PUSH_PATH_PREFIX.length));
      if (expectedHash === null) {
        sendText(response, 400, "Invalid SHA-256 hash\n");
        return;
      }

      if (mediaType(request) !== MAIL_MEDIA_TYPE) {
        sendText(response, 415, `Content-Type must be ${MAIL_MEDIA_TYPE}\n`);
        return;
      }

      const receivedAtHeader = headerStringGuard(request.headers[MAIL_RECEIVED_AT_HEADER]);
      const receivedAt = dateGuard(receivedAtHeader)
      const envelopeFrom = headerStringGuard(request.headers[MAIL_FROM_HEADER])
      const envelopeTo = headerStringGuard(request.headers[MAIL_TO_HEADER])

      const optionalHeaders = {
        ...envelopeFrom ? { envelopeFrom } : {},
        ...envelopeTo ? { envelopeTo } : {}
      }


      const raw = await readRawBody(request);

      const fileQuene = [options.maildir.write(raw, envelopeFrom)]

      const actualHash = sha256Hex(raw);
      if (expectedHash !== actualHash) {
        const warningMail = generateWarningMail({
          expectedHash,
          actualHash,
          receivedAt,
          ...optionalHeaders
        })
        fileQuene.push(options.maildir.write(warningMail))
      }

      await Promise.all(fileQuene)

      // A mismatch was delivered successfully and is therefore still a 204.
      response.writeHead(204);
      response.end();
    } catch (error) {
      console.error("Failed to receive mail", error);
      if (!response.headersSent) {
        sendText(response, 500, "Internal Server Error\n");
      } else {
        response.destroy(error instanceof Error ? error : undefined);
      }
    }
  });
};

const hasValidBearerToken = (request: IncomingMessage, expectedToken: string): boolean => {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith(BEARER_AUTH_PREFIX)) {
    return false;
  }

  const providedToken = Buffer.from(authorization.slice(BEARER_AUTH_PREFIX.length));
  const expectedTokenBuffer = Buffer.from(expectedToken);
  return providedToken.length === expectedTokenBuffer.length
    && timingSafeEqual(providedToken, expectedTokenBuffer);
};

const headerStringGuard = (headerValue: string | string[] | undefined): string | undefined => {
  if (typeof headerValue === "string") {
    return headerValue;
  }
  if (Array.isArray(headerValue)) {
    return JSON.stringify(headerValue);
  }
  return undefined;
};

const dateGuard = (str: string | undefined) => {
  if (str === undefined) {
    return new Date()
  }
  const date = new Date(str)
  if (Number.isNaN(date.getTime())) {
    return new Date()
  }
  return date
}
