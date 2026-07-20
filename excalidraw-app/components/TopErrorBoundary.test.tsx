import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TopErrorBoundary } from "./TopErrorBoundary";

vi.mock("@excalidraw/excalidraw/i18n", () => ({
  t: (key: string, values?: { eventId?: string }) => {
    const messages: Record<string, string> = {
      "errorSplash.headingMain":
        "Encountered an error. Try <button>reloading the page</button>.",
      "errorSplash.clearCanvasMessage":
        "If reloading doesn't work, try <button>clearing the canvas</button>.",
      "errorSplash.clearCanvasCaveat": " This will result in loss of work ",
      "errorSplash.trackedToSentry": `Tracked ${values?.eventId ?? ""}`,
      "errorSplash.openIssueMessage":
        "Please follow up on our <button>bug tracker</button>.",
      "errorSplash.sceneContent": "Scene content:",
    };
    return messages[key] ?? key;
  },
}));

vi.mock("@sentry/browser", () => ({
  captureException: vi.fn(() => "vault-test-event"),
  withScope: vi.fn(
    (callback: (scope: { setExtras: (value: unknown) => void }) => void) =>
      callback({ setExtras: vi.fn() }),
  ),
}));

const ThrowingChild = () => {
  throw new Error("boundary test");
};

const renderBoundary = () =>
  render(
    <TopErrorBoundary>
      <ThrowingChild />
    </TopErrorBoundary>,
  );

describe("TopErrorBoundary Vault diagnostics", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    window.history.replaceState({}, "", "/");
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("does not expose localStorage on a Vault route", () => {
    const rootKey = "A".repeat(43);
    const capability = "B".repeat(43);
    const sentinel = "P4-PLAINTEXT-SENTINEL-20260713";
    window.history.replaceState(
      {},
      "",
      `/#vault=1&id=123e4567-e89b-42d3-a456-426614174000&key=${rootKey}&cap=${capability}`,
    );
    localStorage.setItem("vault-sentinel", sentinel);

    renderBoundary();

    expect(
      screen.getByRole("button", { name: "reloading the page" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "clearing the canvas" }),
    ).toBeInTheDocument();

    const report = (screen.getByRole("textbox") as HTMLTextAreaElement).value;
    expect(report).toContain("REDACTED_VAULT_CONTENT");
    expect(report).not.toContain(sentinel);
    expect(report).not.toContain(rootKey);
    expect(report).not.toContain(capability);
  });

  it("preserves ordinary route diagnostics", () => {
    window.history.replaceState({}, "", "/");
    localStorage.setItem("json", JSON.stringify({ status: "ordinary" }));
    localStorage.setItem("raw", "ordinary-value");

    renderBoundary();

    const report = JSON.parse(
      (screen.getByRole("textbox") as HTMLTextAreaElement).value,
    );
    expect(report).toEqual({
      json: { status: "ordinary" },
      raw: "ordinary-value",
    });
  });
});
