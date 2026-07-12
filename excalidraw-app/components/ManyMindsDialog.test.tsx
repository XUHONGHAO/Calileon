import { fireEvent, render, screen } from "@testing-library/react";

import { beforeEach, describe, expect, it, vi } from "vitest";

import React from "react";

import { ManyMindsDialog } from "./ManyMindsDialog";

vi.mock("@excalidraw/excalidraw/components/Dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("../ai/config", () => ({
  loadAIImageConfig: () => ({
    baseURL: "",
    apiKey: "",
    defaultModel: "model-1",
    models: [
      {
        id: "model-card-1",
        siteName: "Test",
        baseURL: "https://example.test/v1",
        apiKey: "local-only-key",
        model: "model-1",
        label: "Model One",
        mediaType: "image",
        capabilities: ["text-to-image", "image-to-image"],
        endpoints: {},
        requestTimeoutSeconds: 60,
      },
    ],
  }),
}));

vi.mock("../ai/manyMindsPersistence", () => ({
  listManyMindsBatches: vi.fn(async () => []),
  loadManyMindsAsset: vi.fn(async () => null),
  saveManyMindsAsset: vi.fn(),
  saveManyMindsBatch: vi.fn(),
  deleteManyMindsAsset: vi.fn(),
}));

vi.mock("../ai/openAIImageAdapter", () => ({
  generateImagesWithOpenAIAdapter: vi.fn(),
}));

describe("ManyMindsDialog", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to four tasks and exposes all MVP grid sizes", () => {
    render(
      <ManyMindsDialog
        open
        onClose={vi.fn()}
        excalidrawAPI={null}
        persistenceScopeId="local:test"
      />,
    );

    const count = screen.getByLabelText("Views") as HTMLSelectElement;
    expect(count.value).toBe("4");
    expect(Array.from(count.options).map((option) => option.value)).toEqual([
      "2",
      "4",
      "6",
      "9",
    ]);
    expect(screen.getAllByLabelText(/Perspective \d/)).toHaveLength(4);

    fireEvent.change(count, { target: { value: "9" } });
    expect(screen.getAllByLabelText(/Perspective \d/)).toHaveLength(9);
  });

  it("disables generation without a stable persistence scope", () => {
    render(
      <ManyMindsDialog
        open
        onClose={vi.fn()}
        excalidrawAPI={null}
        persistenceScopeId={null}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Generate 4 views" }),
    ).toBeDisabled();
  });
});
