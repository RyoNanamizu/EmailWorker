import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { normalizeSha256, sha256Hex } from "./hash.js";
import {
  handleValidatedMail,
  type ValidatedMail,
  type ValidatedMailHandler,
} from "./validated-mail.js";

const PUSH_PREFIX = "/push/";

function sendText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(body);
}

function mediaType(request: IncomingMessage): string | undefined {
  return request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
}

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export interface MailServerOptions {
  onValidatedMail?: ValidatedMailHandler;
}

export function createMailServer(options: MailServerOptions = {}): Server {
  const onValidatedMail = options.onValidatedMail ?? handleValidatedMail;

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

      const raw = await readRawBody(request);
      const actualHash = sha256Hex(raw);
      const mail: ValidatedMail = {
        expectedHash,
        actualHash,
        hashValid: expectedHash === actualHash,
        raw,
      };

      await onValidatedMail(mail);

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
}
