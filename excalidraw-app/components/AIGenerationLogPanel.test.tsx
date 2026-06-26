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
});
