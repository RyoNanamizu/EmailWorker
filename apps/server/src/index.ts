import type { Server } from "node:http";
import { createMailServer } from "./server.js";

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
  if (value === undefined) return 8080;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`LISTEN_PORT must be an integer from 0 to 65535; received ${JSON.stringify(value)}`);
  }
  return port;
};

export const main = async (): Promise<void> => {
  const host = process.env.LISTEN_HOST ?? "0.0.0.0";
  const port = listenPort(process.env.LISTEN_PORT);
  const server = createMailServer();
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
