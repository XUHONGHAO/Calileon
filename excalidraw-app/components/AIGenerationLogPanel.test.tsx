import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { vi } from "vitest";

import { copyTextToSystemClipboard } from "@excalidraw/excalidraw/clipboard";

import { saveAIGenerationLogs } from "../ai/generationLog";

import { AIGenerationLogPanel } from "./AIGenerationLogPanel";

import type { AIGenerationLogEntry } from "../ai/types";

vi.mock("@excalidraw/excalidraw/clipboard", () => ({
  copyTextToSystemClipboard: vi.fn().mockResolvedValue(undefined),
}));

const createGenerationLog = (): AIGenerationLogEntry => ({
  id: "generation-log-fixture",
  submittedAt: "2026-06-18T10:00:00.000Z",
  completedAt: "2026-06-18T10:00:02.000Z",
  mediaType: "image",
  mode: "text-to-image",
  status: "success",
  model: {
    id: "fixture-model-id",
    name: "fixture-native-model",
    siteName: "Fixture Site",
  },
  prompt: "history panel reusable prompt",
  negativePrompt: "low contrast",
  params: {
    size: "1024x1024",
    n: 1,
    seed: 42,
    quality: "auto",
    style: "",
    referenceStrength: 0.6,
    duration: 5,
    fps: 24,
    resolution: "auto",
    aspectRatio: "auto",
    audioFormat: "mp3",
    voice: "",
  },
  request: {
    baseURL: "https://api.example.test/v1",
    endpoint: "https://api.example.test/v1/images/generations",
  },
  response: {
    summary: "Generated image inserted.",
    details: {
      outputCount: 1,
    },
  },
});

describe("AIGenerationLogPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("reuses expanded generation log settings from history", () => {
    const log = createGenerationLog();
    const onReuseLog = vi.fn();

    saveAIGenerationLogs([log]);
    render(<AIGenerationLogPanel onReuseLog={onReuseLog} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: /fixture-native-model \/ Fixture Site/i,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Reuse settings" }));

    expect(onReuseLog).toHaveBeenCalledTimes(1);
    expect(onReuseLog).toHaveBeenCalledWith(log);
    expect(
      screen.getByText("Generation settings sent to Generate."),
    ).toBeInTheDocument();
  });

  it("copies the prompt from an expanded generation log", async () => {
    const log = createGenerationLog();

    saveAIGenerationLogs([log]);
    render(<AIGenerationLogPanel />);

    fireEvent.click(
      screen.getByRole("button", {
        name: /fixture-native-model \/ Fixture Site/i,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }));

    await waitFor(() => {
      expect(copyTextToSystemClipboard).toHaveBeenCalledWith(log.prompt);
    });
    expect(screen.getByText("Prompt copied.")).toBeInTheDocument();
  });

  it("copies a plain-text report with the run header and details JSON", async () => {
    const log = {
      ...createGenerationLog(),
      status: "failed" as const,
      response: {
        summary: "size must be 1:1",
        details: { code: "unsupported", details: { status: 422 } },
      },
    };

    saveAIGenerationLogs([log]);
    render(<AIGenerationLogPanel />);

    fireEvent.click(
      screen.getByRole("button", {
        name: /fixture-native-model \/ Fixture Site/i,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));

    await waitFor(() => {
      expect(copyTextToSystemClipboard).toHaveBeenCalledTimes(1);
    });
    const report = vi.mocked(copyTextToSystemClipboard).mock
      .calls[0][0] as string;
    expect(report).toContain("status: failed");
    expect(report).toContain("model: fixture-native-model / Fixture Site");
    expect(report).toContain("summary: size must be 1:1");
    expect(report).toContain('"status": 422');
    expect(
      screen.getByText(
        "Details copied. Paste them when reporting the problem.",
      ),
    ).toBeInTheDocument();
  });

  it("hides the clear-logs header while there are no logs", () => {
    render(<AIGenerationLogPanel />);

    expect(screen.getByText("No generation logs.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear logs" })).toBeNull();
  });

  it("asks before clearing logs and keeps them when declined", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    saveAIGenerationLogs([createGenerationLog()]);
    render(<AIGenerationLogPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Clear logs" }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(
      screen.getByRole("button", { name: /fixture-native-model/ }),
    ).toBeInTheDocument();

    confirmSpy.mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Clear logs" }));
    expect(await screen.findByText("No generation logs.")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });
});
