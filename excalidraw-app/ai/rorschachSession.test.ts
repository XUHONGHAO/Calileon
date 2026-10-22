import { beforeEach, describe, expect, it, vi } from "vitest";

import { RORSCHACH_IMAGE_PARAMS, runRorschachImage } from "./rorschachImage";
import { getRorschachPersona } from "./rorschachPersonas";
import {
  createRorschachAttempt,
  describeErrorMessage,
  patchRorschachAttempt,
  pushRorschachHistory,
  runRorschachReading,
  toRorschachImageOutput,
} from "./rorschachSession";
import { createRorschachSession } from "./rorschachSession";
import { parseRorschachReading } from "./rorschachReading";

import type { AIImageModel, AIImageProviderConfig } from "./types";
import type { RorschachAttempt, RorschachSession } from "./rorschachTypes";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

const attempt = (): RorschachAttempt =>
  createRorschachAttempt({
    sequence: 1,
    mode: "read-and-draw",
    personaId: "gentleCounselor",
    image: PNG,
  });

const model: AIImageModel = {
  id: "card-1",
  siteName: "Test",
  baseURL: "https://example.test/v1",
  apiKey: "key",
  model: "image-model",
  label: "Image model",
  mediaType: "image",
  capabilities: ["image-to-image"],
  endpoints: {
    textToImage: { path: "/images/generations" },
    imageToImage: { path: "/images/edits" },
    inpaint: { path: "/images/edits" },
  } as any,
  requestTimeoutSeconds: 60,
};

const config: AIImageProviderConfig = {
  baseURL: "https://example.test/v1",
  apiKey: "key",
  defaultModel: "image-model",
  models: [model],
};

describe("rorschachSession reading stage", () => {
  const buildOptions = (overrides: Record<string, unknown> = {}) => {
    const patches: Array<[string, Partial<RorschachAttempt>]> = [];
    return {
      patches,
      options: {
        session: createRorschachSession("gentleCounselor"),
        attempt: attempt(),
        agent: null,
        systemPrompt: "system",
        userPrompt: "user",
        locale: "zh-CN",
        signal: new AbortController().signal,
        parse: parseRorschachReading,
        isCurrent: () => true,
        onPatch: (id: string, patch: Partial<RorschachAttempt>) =>
          patches.push([id, patch]),
        ...overrides,
      } as any,
    };
  };

  it("stores the parsed reading and clears errors", async () => {
    const { options, patches } = buildOptions({
      deps: {
        describe: vi.fn(async () => ({
          text: JSON.stringify({
            reading: "我看到一只想飞的鸟",
            imagePrompt: "bird from strokes",
          }),
        })),
      },
    });

    const result = await runRorschachReading(options);

    expect(result).toEqual({
      reading: "我看到一只想飞的鸟",
      imagePrompt: "bird from strokes",
    });
    expect(patches[0][1]).toMatchObject({ readingStatus: "running" });
    expect(patches[patches.length - 1][1]).toMatchObject({
      readingStatus: "succeeded",
      readingError: null,
    });
  });

  it("fails with a localized message on a malformed answer, never echoing it", async () => {
    const raw = "totally not json with api key sk-123";
    const { options, patches } = buildOptions({
      deps: { describe: vi.fn(async () => ({ text: raw })) },
    });

    await expect(runRorschachReading(options)).resolves.toBeNull();
    const last = patches[patches.length - 1][1];
    expect(last.readingStatus).toBe("failed");
    expect(last.readingError).not.toContain("sk-123");
  });

  it("reports cancellation without a thrown error", async () => {
    const controller = new AbortController();
    const { options, patches } = buildOptions({
      signal: controller.signal,
      deps: {
        describe: vi.fn(async () => {
          throw new DOMException("Aborted", "AbortError");
        }),
      },
    });

    await expect(runRorschachReading(options)).resolves.toBeNull();
    expect(patches[patches.length - 1][1].readingStatus).toBe("failed");
  });

  it("ignores results that arrive after the run was superseded", async () => {
    const { options, patches } = buildOptions({
      isCurrent: () => false,
      deps: {
        describe: vi.fn(async () => ({
          text: JSON.stringify({
            reading: "我看到一只鸟",
            imagePrompt: "bird",
          }),
        })),
      },
    });

    await expect(runRorschachReading(options)).resolves.toBeNull();
    expect(
      patches.some(([, patch]) => patch.readingStatus === "succeeded"),
    ).toBe(false);
  });
});

describe("rorschachSession helpers", () => {
  it("patches only the matching attempt", () => {
    const first = attempt();
    const second = attempt();
    const session: RorschachSession = {
      ...createRorschachSession("gentleCounselor"),
      attempts: [first, second],
    };
    const next = patchRorschachAttempt(session, second.id, {
      readingStatus: "succeeded",
    });
    expect(next.attempts[0].readingStatus).toBe("idle");
    expect(next.attempts[1].readingStatus).toBe("succeeded");
    expect(
      patchRorschachAttempt(session, "unknown", { readingStatus: "failed" }),
    ).toBe(session);
  });

  it("bounds the reading history", () => {
    let history: string[] = [];
    for (let index = 0; index < 12; index++) {
      history = pushRorschachHistory(history, `reading ${index}`, 8);
    }
    expect(history).toHaveLength(8);
    expect(history[0]).toBe("reading 4");
    expect(history[7]).toBe("reading 11");
  });

  it("redacts secrets and URLs from error messages", () => {
    expect(describeErrorMessage(new Error("Bearer sk-secret"))).not.toContain(
      "sk-secret",
    );
    expect(
      describeErrorMessage(new Error("failed at https://api.example.test/x")),
    ).not.toContain("https://");
    expect(describeErrorMessage(new Error("plain failure"))).toBe(
      "plain failure",
    );
  });

  it("accepts only data-url image outputs", () => {
    expect(
      toRorschachImageOutput({
        dataURL: "https://example.test/a.png",
        mimeType: "image/png",
        storageType: "remote-url",
      }),
    ).toBeNull();
    expect(
      toRorschachImageOutput({ dataURL: PNG, mimeType: "image/png" }),
    ).toEqual({ dataURL: PNG, mimeType: "image/png" });
  });
});

describe("rorschachImage stage", () => {
  let patches: Array<[string, Partial<RorschachAttempt>]>;

  beforeEach(() => {
    patches = [];
  });

  const run = (overrides: Record<string, unknown> = {}) => {
    const target = attempt();
    return {
      target,
      promise: runRorschachImage({
        attempt: target,
        imageDataURL: PNG,
        imagePrompt: "draw a bird",
        persona: getRorschachPersona("gentleCounselor"),
        model,
        config,
        signal: new AbortController().signal,
        isCurrent: () => true,
        onPatch: (id: string, patch: Partial<RorschachAttempt>) =>
          patches.push([id, patch]),
        ...overrides,
      } as any),
    };
  };

  it("generates image-to-image with the attempt's prompt and no re-read", async () => {
    const generate = vi.fn(async () => [
      { dataURL: PNG, mimeType: "image/png" },
    ]);
    await run({ deps: { generate } }).promise;

    const request = (generate.mock.calls[0] as any[])[0];
    expect(request.mode).toBe("image-to-image");
    expect(request.prompt).toBe("draw a bird");
    expect(request.params).toEqual(RORSCHACH_IMAGE_PARAMS);
    expect(request.sources[0].dataURL).toBe(PNG);
    expect(patches[patches.length - 1][1]).toMatchObject({
      imageStatus: "succeeded",
    });
  });

  it("keeps a failed image retryable without touching the reading", async () => {
    await run({
      deps: {
        generate: vi.fn(async () => {
          throw new Error("provider down");
        }),
      },
    }).promise;

    const last = patches[patches.length - 1][1];
    expect(last.imageStatus).toBe("failed");
    expect(last).not.toHaveProperty("readingStatus");
    expect(last.imageError).toBe("provider down");
  });

  it("treats a missing output as a failure rather than a silent success", async () => {
    await run({ deps: { generate: vi.fn(async () => []) } }).promise;
    expect(patches[patches.length - 1][1].imageStatus).toBe("failed");
  });

  it("drops late results once the run is no longer current", async () => {
    const result = await run({
      isCurrent: () => false,
      deps: {
        generate: vi.fn(async () => [{ dataURL: PNG, mimeType: "image/png" }]),
      },
    }).promise;

    expect(result).toBeNull();
    expect(patches.some(([, patch]) => patch.imageStatus === "succeeded")).toBe(
      false,
    );
  });
});
