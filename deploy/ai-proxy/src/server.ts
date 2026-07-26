import { pathToFileURL } from "node:url";

import { loadAIProxyConfig } from "./config.js";
import { createAIProxyServer } from "./handler.js";

export const startAIProxyServer = () => {
  const config = loadAIProxyConfig();
  const server = createAIProxyServer(config);

  server.listen(config.port, "0.0.0.0", () => {
    console.info(
      JSON.stringify({
        event: "ai_proxy_started",
        port: config.port,
        production: config.production,
        tokenRequired: config.requireClientToken,
      }),
    );
  });

  const shutdown = (signal: NodeJS.Signals) => {
    console.info(JSON.stringify({ event: "ai_proxy_stopping", signal }));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), config.shutdownGraceMs).unref();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  return server;
};

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";

if (import.meta.url === entrypoint) {
  startAIProxyServer();
}
