import { pathToFileURL } from "node:url";

import { loadAIProxyConfig } from "./config.js";
import { createAIProxyServer } from "./handler.js";
import {
  createGatewayRuntime,
  createUnavailableGatewayHandler,
} from "./gateway/runtime.js";
import { GatewayError } from "./gateway/errors.js";

export const startAIProxyServer = () => {
  const config = loadAIProxyConfig();
  let gateway: ReturnType<typeof createGatewayRuntime>;
  try {
    gateway = createGatewayRuntime(config);
  } catch (error) {
    // A broken optional gateway must not take the independent BYOK proxy
    // down. Do not log configuration values (which may contain credentials).
    console.error(
      JSON.stringify({
        event: "ai_gateway_unavailable",
        code: "AI_GATEWAY_NOT_READY",
      }),
    );
    gateway = {
      handler: createUnavailableGatewayHandler(config.allowedOrigins),
      close: async () => {},
      checkReady: async () => false,
    };
  }
  const gatewayHandler =
    gateway?.handler ||
    createUnavailableGatewayHandler(
      config.allowedOrigins,
      new GatewayError("AI_GATEWAY_DISABLED", 404, { retryable: false }),
    );
  const server = createAIProxyServer(config, undefined, gatewayHandler);

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
    server.close(() => {
      void gateway?.close().finally(() => process.exit(0));
      if (!gateway) {
        process.exit(0);
      }
    });
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
