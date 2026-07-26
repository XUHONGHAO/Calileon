export type AIProxyLogEntry = {
  requestId: string;
  method: string;
  status: number;
  durationMs: number;
  errorCode?: string;
  targetHostname?: string;
  responseBytes?: number;
  clientAborted?: boolean;
};

export type AIProxyLogger = {
  info(entry: AIProxyLogEntry): void;
};

export const consoleAIProxyLogger: AIProxyLogger = {
  info(entry) {
    console.info(JSON.stringify({ event: "ai_proxy_request", ...entry }));
  },
};
