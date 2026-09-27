import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { normalizeSha256, sha256Hex } from "./hash.js";
import { type typeMaildir } from "./maildir.js";
import { generateWarningMail } from "./warning.js";
const PUSH_PREFIX = "/push/";

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
  maildir: typeMaildir
}

export const createMailServer = (options: MailServerOptions): Server => {

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      if (request.method === "GET" && url.pathname === "/health") {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end('{"ok":true}\n');
        return;
      }

      if (!url.pathname.startsWith(PUSH_PREFIX)) {
        sendText(response, 404, "Not Found\n");
        return;
      }

      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        sendText(response, 405, "Method Not Allowed\n");
        return;
      }

      const expectedHash = normalizeSha256(url.pathname.slice(PUSH_PREFIX.length));
      if (expectedHash === null) {
        sendText(response, 400, "Invalid SHA-256 hash\n");
        return;
      }

      if (mediaType(request) !== "message/rfc822") {
        sendText(response, 415, "Content-Type must be message/rfc822\n");
        return;
      }

      const receivedAtHeader = headerStringGuard(request.headers["x-mail-received-at"]);
      const receivedAt = dateGuard(receivedAtHeader)
      const envelopeFrom = headerStringGuard(request.headers["x-mail-from"])
      const envelopeTo = headerStringGuard(request.headers["x-mail-to"])

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