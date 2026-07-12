import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_EMBED_CAPABILITIES,
  createEmbedEvent,
  createEmbedSuccessResponse,
} from "./protocol";
import { connectExcalidrawEmbed, createExcalidrawEmbed } from "./host";

const TARGET_ORIGIN = "https://embed.example.com";

const dispatchEmbedMessage = (
  iframe: HTMLIFrameElement,
  data: unknown,
  origin = TARGET_ORIGIN,
) => {
  window.dispatchEvent(
    new MessageEvent("message", {
      data,
      origin,
      source: iframe.contentWindow,
    }),
  );
};

const dispatchReady = (iframe: HTMLIFrameElement, instanceId: string) => {
  dispatchEmbedMessage(
    iframe,
    createEmbedEvent({
      instanceId,
      requestId: `ready:${instanceId}`,
      name: "ready",
      payload: {
        mode: "view",
        preset: "full",
        capabilities: DEFAULT_EMBED_CAPABILITIES,
      },
    }),
  );
};

describe("ExcalidrawEmbedHost", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/embed-host");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("creates a default read-only iframe with exact origin bootstrap data", () => {
    const host = createExcalidrawEmbed({
      container: document.body,
      src: `${TARGET_ORIGIN}/embed#share=secret`,
      instanceId: "board-1",
    });
    const url = new URL(host.iframe.src);

    expect(url.origin).toBe(TARGET_ORIGIN);
    expect(url.searchParams.get("instanceId")).toBe("board-1");
    expect(url.searchParams.get("parentOrigin")).toBe(window.location.origin);
    expect(url.searchParams.get("mode")).toBe("view");
    expect(url.hash).toBe("#share=secret");
    expect(host.iframe.getAttribute("sandbox")).not.toContain(
      "allow-top-navigation",
    );
    void host.ready.catch(() => {});
    host.destroy();
  });

  it("accepts ready only from the iframe window, exact origin, and instance", async () => {
    const iframe = document.createElement("iframe");
    iframe.src = `${TARGET_ORIGIN}/embed`;
    document.body.appendChild(iframe);
    const host = connectExcalidrawEmbed(iframe, { instanceId: "board-1" });
    let resolved = false;
    void host.ready.then(() => {
      resolved = true;
    });

    dispatchEmbedMessage(
      iframe,
      createEmbedEvent({
        instanceId: "board-1",
        requestId: "wrong-origin",
        name: "ready",
        payload: {
          mode: "view",
          preset: "full",
          capabilities: DEFAULT_EMBED_CAPABILITIES,
        },
      }),
      "https://attacker.example.com",
    );
    await Promise.resolve();
    expect(resolved).toBe(false);

    dispatchReady(iframe, "another-board");
    await Promise.resolve();
    expect(resolved).toBe(false);

    dispatchReady(iframe, "board-1");
    await expect(host.ready).resolves.toMatchObject({ mode: "view" });
    host.destroy();
  });

  it("correlates responses and prevents cross-instance message delivery", async () => {
    const iframe = document.createElement("iframe");
    iframe.src = `${TARGET_ORIGIN}/embed`;
    document.body.appendChild(iframe);
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
    const host = connectExcalidrawEmbed(iframe, { instanceId: "board-1" });
    dispatchReady(iframe, "board-1");

    const responsePromise = host.getScene();
    await Promise.resolve();
    const command = postMessage.mock.calls[0][0] as {
      requestId: string;
      name: "getScene";
    };
    dispatchEmbedMessage(
      iframe,
      createEmbedSuccessResponse({
        instanceId: "board-2",
        requestId: command.requestId,
        name: "getScene",
        payload: { scene: { elements: [] } },
      }),
    );
    dispatchEmbedMessage(
      iframe,
      createEmbedSuccessResponse({
        instanceId: "board-1",
        requestId: "another-request",
        name: "getScene",
        payload: { scene: { elements: [] } },
      }),
    );
    dispatchEmbedMessage(
      iframe,
      createEmbedSuccessResponse({
        instanceId: "board-1",
        requestId: command.requestId,
        name: "getScene",
        payload: { scene: { elements: [{ id: "rect-1" }] } },
      }),
    );

    await expect(responsePromise).resolves.toEqual({
      scene: { elements: [{ id: "rect-1" }] },
    });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: "board-1",
        kind: "command",
        name: "getScene",
      }),
      TARGET_ORIGIN,
    );
    host.destroy();
  });

  it("delivers only registered events and exposes explicit subscriptions", async () => {
    const iframe = document.createElement("iframe");
    iframe.src = `${TARGET_ORIGIN}/embed`;
    document.body.appendChild(iframe);
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
    const host = connectExcalidrawEmbed(iframe, { instanceId: "board-1" });
    dispatchReady(iframe, "board-1");
    const handler = vi.fn();
    const unsubscribeLocal = host.on("sceneChange", handler);

    dispatchEmbedMessage(
      iframe,
      createEmbedEvent({
        instanceId: "board-1",
        requestId: "event-1",
        name: "sceneChange",
        payload: { revision: 2, elementCount: 3 },
      }),
    );
    expect(handler).toHaveBeenCalledWith({ revision: 2, elementCount: 3 });
    unsubscribeLocal();

    const subscribePromise = host.subscribe(["sceneChange"]);
    await Promise.resolve();
    const command = postMessage.mock.calls.at(-1)?.[0] as {
      requestId: string;
    };
    dispatchEmbedMessage(
      iframe,
      createEmbedSuccessResponse({
        instanceId: "board-1",
        requestId: command.requestId,
        name: "subscribe",
        payload: { events: ["sceneChange"] },
      }),
    );
    await expect(subscribePromise).resolves.toEqual({
      events: ["sceneChange"],
    });
    host.destroy();
  });

  it("rejects oversized commands before posting them", async () => {
    const iframe = document.createElement("iframe");
    iframe.src = `${TARGET_ORIGIN}/embed`;
    document.body.appendChild(iframe);
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
    const host = connectExcalidrawEmbed(iframe, { instanceId: "board-1" });
    dispatchReady(iframe, "board-1");

    await expect(
      host.loadScene({ type: "p1", payload: "x".repeat(6 * 1024 * 1024) }),
    ).rejects.toMatchObject({
      error: { code: "MESSAGE_TOO_LARGE" },
    });
    expect(postMessage).not.toHaveBeenCalled();
    host.destroy();
  });
});
