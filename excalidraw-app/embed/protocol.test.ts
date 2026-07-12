import { describe, expect, it } from "vitest";

import {
  DEFAULT_EMBED_CAPABILITIES,
  EMBED_MAX_COMMAND_BYTES,
  createEmbedCommand,
  createEmbedErrorResponse,
  createEmbedEvent,
  createEmbedSuccessResponse,
  getEmbedMessageByteSize,
  isEmbedProtocolMessage,
} from "./protocol";

describe("embed protocol", () => {
  it("creates versioned, instance-scoped command and response envelopes", () => {
    const command = createEmbedCommand({
      instanceId: "board-1",
      requestId: "request-1",
      name: "setMode",
      payload: { mode: "view" },
    });

    expect(command).toMatchObject({
      channel: "excalidraw-embed",
      protocolVersion: 1,
      instanceId: "board-1",
      requestId: "request-1",
      kind: "command",
      name: "setMode",
      payload: { mode: "view" },
    });
    expect(
      createEmbedSuccessResponse({
        instanceId: "board-1",
        requestId: "request-1",
        name: "setMode",
        payload: { mode: "view" },
      }),
    ).toMatchObject({ kind: "response", ok: true });
    expect(
      createEmbedErrorResponse({
        instanceId: "board-1",
        requestId: "request-1",
        name: "setMode",
        error: { code: "READ_ONLY", message: "Read-only" },
      }),
    ).toMatchObject({
      kind: "response",
      ok: false,
      payload: { code: "READ_ONLY" },
    });
  });

  it("advertises the frozen MVP capability surface", () => {
    expect(DEFAULT_EMBED_CAPABILITIES).toMatchObject({
      protocolVersions: [1],
      exportFormats: ["png", "svg", "json"],
      modes: ["view", "edit"],
      uiPresets: ["full", "compact", "presentation"],
      sourceTypes: ["share", "p1", "scene"],
    });
    expect(DEFAULT_EMBED_CAPABILITIES.commands).toEqual(
      expect.arrayContaining([
        "loadScene",
        "setMode",
        "scrollToContent",
        "scrollToElement",
        "getScene",
        "export",
        "subscribe",
        "unsubscribe",
      ]),
    );
  });

  it("rejects unknown versions, missing IDs, and unknown messages", () => {
    const ready = createEmbedEvent({
      instanceId: "board-1",
      requestId: "event-1",
      name: "ready",
      payload: {
        mode: "view",
        preset: "compact",
        capabilities: DEFAULT_EMBED_CAPABILITIES,
      },
    });
    expect(isEmbedProtocolMessage(ready)).toBe(true);
    expect(isEmbedProtocolMessage({ ...ready, protocolVersion: 2 })).toBe(
      false,
    );
    expect(isEmbedProtocolMessage({ ...ready, instanceId: "" })).toBe(false);
    expect(isEmbedProtocolMessage({ ...ready, requestId: undefined })).toBe(
      false,
    );
    expect(isEmbedProtocolMessage({ ...ready, name: "secretEvent" })).toBe(
      false,
    );
  });

  it("measures serialized messages for transport size enforcement", () => {
    const command = createEmbedCommand({
      instanceId: "board-1",
      requestId: "request-1",
      name: "loadScene",
      payload: {
        source: { type: "p1", payload: "x".repeat(1024) },
      },
    });
    expect(getEmbedMessageByteSize(command)).toBeGreaterThan(1024);
    expect(getEmbedMessageByteSize(command)).toBeLessThan(
      EMBED_MAX_COMMAND_BYTES,
    );
    expect(getEmbedMessageByteSize({ value: BigInt(1) })).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});
