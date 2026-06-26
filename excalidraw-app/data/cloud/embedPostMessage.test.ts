import { describe, expect, it } from "vitest";

import {
  EMBED_API_SOURCE,
  EMBED_API_VERSION,
  createEmbedError,
  createEmbedEvent,
  createEmbedResponse,
  isEmbedApiEnvelope,
} from "./embedPostMessage";

describe("embedPostMessage", () => {
  it("creates versioned event envelopes", () => {
    expect(createEmbedEvent("ready", { sceneId: "scene-1" })).toEqual({
      source: EMBED_API_SOURCE,
      version: EMBED_API_VERSION,
      type: "event",
      name: "ready",
      payload: { sceneId: "scene-1" },
    });
  });

  it("recognizes valid envelopes only", () => {
    expect(
      isEmbedApiEnvelope({
        source: EMBED_API_SOURCE,
        version: EMBED_API_VERSION,
        type: "command",
        name: "ping",
      }),
    ).toBe(true);
    expect(isEmbedApiEnvelope({ source: EMBED_API_SOURCE, version: 2 })).toBe(
      false,
    );
  });

  it("creates response and error envelopes", () => {
    expect(createEmbedResponse("r1", "ping", { ok: true })).toMatchObject({
      type: "response",
      requestId: "r1",
      name: "ping",
    });
    expect(createEmbedError("Nope", "r2")).toMatchObject({
      type: "response",
      requestId: "r2",
      name: "error",
      payload: { message: "Nope" },
    });
  });
});
