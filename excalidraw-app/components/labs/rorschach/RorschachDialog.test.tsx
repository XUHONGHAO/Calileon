import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import React from "react";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { insertRorschachResultIntoCanvas } from "../../../ai/rorschachCanvas";

import { RorschachDialog } from "./RorschachDialog";

import type { RorschachRunnerDeps } from "../../../ai/rorschachRunner";

// Only the wire boundaries are mocked; the runner, parser and prompts run for
// real so the test covers the actual orchestration.
vi.mock("@excalidraw/excalidraw/components/Dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("../../../ai/rorschachCanvas", () => ({
  insertRorschachResultIntoCanvas: vi.fn(),
}));

const READING = "我看到一只想飞的鸟";
const IMAGE_PROMPT = "a bird made of the existing strokes";
const PNG = "data:image/png;base64,BBBB";

const fakeAPI = (selectedCount: number) => {
  const elements = Array.from({ length: selectedCount }, (_, index) => ({
    id: `el-${index}`,
    type: "freedraw",
    x: 10,
    y: 10,
    width: 100,
    height: 100,
    isDeleted: false,
  }));
  return {
    getSceneElements: () => elements,
    getAppState: () => ({
      selectedElementIds: Object.fromEntries(
        elements.map((element) => [element.id, true]),
      ),
    }),
    getFiles: () => ({}),
    onChange: () => () => {},
    addFiles: vi.fn(),
    updateScene: vi.fn(),
  };
};

type Harness = {
  deps: RorschachRunnerDeps;
  describe: ReturnType<typeof vi.fn>;
  generate: ReturnType<typeof vi.fn>;
  capture: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  resolveTransport: ReturnType<typeof vi.fn>;
};

const createHarness = (
  overrides: Partial<RorschachRunnerDeps> = {},
): Harness => {
  const describe = vi.fn(async () => ({
    text: JSON.stringify({ reading: READING, imagePrompt: IMAGE_PROMPT }),
  }));
  const generate = vi.fn(async () => [{ dataURL: PNG, mimeType: "image/png" }]);
  const capture = vi.fn(async () => ({
    dataURL: "data:image/png;base64,AAAA",
    width: 300,
    height: 200,
    sourceElementIds: ["el-0"],
    bounds: { x: 10, y: 10, width: 100, height: 100 },
  }));
  const resolveTransport = vi.fn(async () => ({
    visionAgent: { id: "vision-1", baseURL: "x", model: "m" } as any,
    imageModel: { id: "card-1", capabilities: ["image-to-image"] } as any,
    managed: false,
    visionUnavailableReason: null,
    imageUnavailableReason: null,
  }));

  return {
    describe,
    generate,
    capture,
    insert: insertRorschachResultIntoCanvas as unknown as ReturnType<
      typeof vi.fn
    >,
    resolveTransport,
    deps: {
      capture: capture as any,
      describe: describe as any,
      generate: generate as any,
      resolveTransport: resolveTransport as any,
      resolveAvailability: (() => ({
        visionAgent: { id: "vision-1" },
        imageModel: { id: "card-1" },
        managed: false,
        visionUnavailableReason: null,
        imageUnavailableReason: null,
      })) as any,
      ...overrides,
    },
  };
};

const renderDialog = (
  harness: Harness,
  props: Partial<React.ComponentProps<typeof RorschachDialog>> = {},
) =>
  render(
    <RorschachDialog
      open
      onClose={vi.fn()}
      excalidrawAPI={fakeAPI(1) as any}
      externalFeaturesDisabled={false}
      runnerDeps={harness.deps}
      {...props}
    />,
  );

describe("RorschachDialog", () => {
  let harness: Harness;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    (insertRorschachResultIntoCanvas as any).mockResolvedValue({
      imageElement: { id: "img" },
      textElement: { id: "txt" },
    });
    harness = createHarness();
  });

  it("renders nothing in Vault mode", () => {
    const { container } = renderDialog(harness, {
      externalFeaturesDisabled: true,
    });
    expect(container.firstChild).toBeNull();
  });

  it("offers a primary read-and-draw action and a secondary read-only action", () => {
    renderDialog(harness);
    expect(
      screen.getByRole("button", { name: /what does it see/i }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /just one line/i })).toBeTruthy();
    expect(screen.getByText(/not a psychological assessment/i)).toBeTruthy();
    expect(
      screen.getByText(/drops anything you have not put on the canvas/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/1 reading request and 1 image request/i),
    ).toBeTruthy();
  });

  it("selects the persona only once, through the clickable cards", () => {
    renderDialog(harness);
    // No duplicate dropdown: the cards below are the single control.
    expect(screen.queryByRole("combobox")).toBeNull();
    const group = screen.getByRole("group", { name: /reader/i });
    expect(within(group).getAllByRole("button")).toHaveLength(3);
    expect(
      within(group).getByRole("button", { name: /gentle counselor/i }),
    ).toBeTruthy();
  });

  it("blocks execution without a selection and never calls the network", () => {
    renderDialog(harness, { excalidrawAPI: fakeAPI(0) as any });
    expect(
      screen
        .getByRole("button", { name: /what does it see/i })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByText(/select your scribble/i)).toBeTruthy();
    expect(harness.describe).not.toHaveBeenCalled();
    expect(harness.capture).not.toHaveBeenCalled();
  });

  it("reads then draws, and inserts picture plus sentence in one call", async () => {
    renderDialog(harness);
    fireEvent.click(screen.getByRole("button", { name: /what does it see/i }));

    await waitFor(() =>
      expect(screen.getByTestId("rorschach-reading").textContent).toContain(
        READING,
      ),
    );
    await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(1));
    expect(harness.describe).toHaveBeenCalledTimes(1);
    expect(harness.describe.mock.calls[0][0].systemPrompt).toContain(
      "Never perform medical",
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /put on canvas/i }),
    );
    await waitFor(() =>
      expect(insertRorschachResultIntoCanvas).toHaveBeenCalledTimes(1),
    );
    const args = (insertRorschachResultIntoCanvas as any).mock.calls[0][0];
    expect(args.reading).toBe(READING);
    expect(args.relation.sourceElementIds).toEqual(["el-0"]);
    expect(args.relation.batchId).toMatch(/^rorschach/);
    expect(args.imageOutput).toEqual({ dataURL: PNG, mimeType: "image/png" });
  });

  it("read-only mode never calls the image provider", async () => {
    renderDialog(harness);
    fireEvent.click(screen.getByRole("button", { name: /just one line/i }));

    await waitFor(() => expect(harness.describe).toHaveBeenCalledTimes(1));
    expect(harness.generate).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("button", { name: /only the sentence/i }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /draw it/i })).toBeTruthy();
    expect(
      screen.getByText(/1 reading request and no image request/i),
    ).toBeTruthy();
  });

  it("draws later from a read-only run without reading again", async () => {
    renderDialog(harness);
    fireEvent.click(screen.getByRole("button", { name: /just one line/i }));
    const draw = await screen.findByRole("button", { name: /draw it/i });
    fireEvent.click(draw);

    await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(1));
    expect(harness.describe).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole("button", { name: /put on canvas/i }),
    ).toBeTruthy();
  });

  it("inserts only the sentence from a read-only run", async () => {
    renderDialog(harness);
    fireEvent.click(screen.getByRole("button", { name: /just one line/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /only the sentence/i }),
    );

    await waitFor(() =>
      expect(insertRorschachResultIntoCanvas).toHaveBeenCalledTimes(1),
    );
    expect(
      (insertRorschachResultIntoCanvas as any).mock.calls[0][0].imageOutput,
    ).toBeNull();
  });

  it("keeps the reading and retries only the image when drawing fails", async () => {
    harness.generate.mockRejectedValueOnce(new Error("provider down"));
    renderDialog(harness);
    fireEvent.click(screen.getByRole("button", { name: /what does it see/i }));

    const retry = await screen.findByRole("button", { name: /retry drawing/i });
    expect(screen.getByTestId("rorschach-reading").textContent).toContain(
      READING,
    );

    harness.generate.mockResolvedValueOnce([
      { dataURL: PNG, mimeType: "image/png" },
    ]);
    fireEvent.click(retry);

    await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(2));
    expect(harness.describe).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole("button", { name: /put on canvas/i }),
    ).toBeTruthy();
  });

  it("offers only a reading retry when the answer is malformed", async () => {
    harness.describe.mockResolvedValueOnce({ text: "not json at all" });
    renderDialog(harness);
    fireEvent.click(screen.getByRole("button", { name: /what does it see/i }));

    expect(
      await screen.findByRole("button", { name: /retry reading/i }),
    ).toBeTruthy();
    expect(harness.generate).not.toHaveBeenCalled();
    expect(screen.getByText(/unexpected format/i)).toBeTruthy();
  });

  it("points at AI settings when nothing is configured", async () => {
    harness.resolveTransport.mockRejectedValueOnce(
      new Error("No vision agent is configured yet."),
    );
    renderDialog(harness);
    fireEvent.click(screen.getByRole("button", { name: /what does it see/i }));

    const settings = await screen.findByRole("button", {
      name: /open ai settings/i,
    });
    const listener = vi.fn();
    window.addEventListener("excalidraw:open-ai-settings", listener);
    fireEvent.click(settings);
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener("excalidraw:open-ai-settings", listener);
    expect(harness.describe).not.toHaveBeenCalled();
  });

  it("switches persona without sending a request", async () => {
    renderDialog(harness);
    const mystic = screen.getByRole("button", { name: /mystic master/i });
    fireEvent.click(mystic);

    expect(mystic.getAttribute("aria-pressed")).toBe("true");
    expect(harness.describe).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /just one line/i }));
    await waitFor(() => expect(harness.describe).toHaveBeenCalledTimes(1));
    expect(harness.describe.mock.calls[0][0].systemPrompt).toMatch(/mystic/i);
  });

  it("cancels a running request and drops its late result", async () => {
    let resolveDescribe: (value: { text: string }) => void = () => {};
    harness.describe.mockImplementationOnce(
      () => new Promise((resolve) => (resolveDescribe = resolve)),
    );
    renderDialog(harness);
    fireEvent.click(screen.getByRole("button", { name: /what does it see/i }));

    const cancel = await screen.findByRole("button", { name: /cancel run/i });
    fireEvent.click(cancel);
    expect((await screen.findAllByText(/cancelled/i)).length).toBeGreaterThan(
      0,
    );

    resolveDescribe({
      text: JSON.stringify({ reading: READING, imagePrompt: IMAGE_PROMPT }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.generate).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /put on canvas/i })).toBeNull();
  });
});
