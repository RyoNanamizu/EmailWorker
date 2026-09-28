import type { Server } from "node:http";
import {
  BEARER_TOKEN_ENV,
  DEFAULT_LISTEN_HOST,
  DEFAULT_LISTEN_PORT,
  LISTEN_HOST_ENV,
  LISTEN_PORT_ENV,
} from "./constants.js";
import { createMailServer } from "./server.js";
import { initMailDir } from "./maildir.js";

const listen = (server: Server, host: string, port: number): Promise<void> => {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
};

const listenPort = (value: string | undefined): number => {
  if (value === undefined) return DEFAULT_LISTEN_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${LISTEN_PORT_ENV} must be an integer from 0 to 65535; received ${JSON.stringify(value)}`);
  }
  return port;
};

const requiredBearerToken = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) {
    throw new Error(`${BEARER_TOKEN_ENV} must be set and must not be empty`);
  }
  return value;
};

export const main = async (): Promise<void> => {
  const host = process.env[LISTEN_HOST_ENV] ?? DEFAULT_LISTEN_HOST;
  const port = listenPort(process.env[LISTEN_PORT_ENV]);
  const bearerToken = requiredBearerToken(process.env[BEARER_TOKEN_ENV]);
  const maildir = await initMailDir()
  console.log("Maildir inited.")
  const server = createMailServer({
    maildir,
    bearerToken,
  });
  await listen(server, host, port);
  console.log(`Mail receiver listening on http://${host}:${port}`);

  const shutdown = (signal: string): void => {
    console.log(`Received ${signal}; shutting down`);
    server.close((error) => {
      if (error) {
        console.error("Shutdown failed", error);
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
};

void main().catch((error: unknown) => {
  console.error("Unable to start mail receiver", error);
  process.exitCode = 1;
});
