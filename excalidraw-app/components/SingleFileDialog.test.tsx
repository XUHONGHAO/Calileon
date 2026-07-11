import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { vi } from "vitest";

import {
  createSingleFileBlob,
  fetchSingleFileRuntimeTemplate,
  normalizeSingleFileName,
} from "../single-file/exportSingleFile";
import { createSingleFilePayload } from "../single-file/payload";
import { saveSingleFileAs } from "../single-file/saveSingleFile";

import { SingleFileDialog } from "./SingleFileDialog";

vi.mock("@excalidraw/excalidraw/components/Dialog", () => ({
  Dialog: ({
    children,
    title,
  }: {
    children: React.ReactNode;
    title: React.ReactNode;
  }) => (
    <div role="dialog" aria-label={String(title)}>
      {children}
    </div>
  ),
}));

vi.mock("@excalidraw/excalidraw/components/FilledButton", () => ({
  FilledButton: ({
    label,
    onClick,
    disabled,
  }: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {label}
    </button>
  ),
}));

vi.mock("@excalidraw/excalidraw/i18n", () => ({
  t: (key: string) =>
    ({
      "singleFile.title": "Single-file board",
      "singleFile.description": "Offline editable HTML",
      "singleFile.support": "AI and cloud are unavailable",
      "singleFile.browserSupportTitle": "Browser support",
      "singleFile.browserSupport": "Modern browsers can open the file",
      "singleFile.overwriteSupported": "Overwrite supported",
      "singleFile.overwriteUnsupported": "Overwrite unsupported",
      "singleFile.fileBoundaryTitle": "File contents and limits",
      "singleFile.fileBoundary": "Secrets are excluded",
      "singleFile.export": "Export single file",
      "singleFile.exporting": "Exporting...",
      "singleFile.errors.exportFailed": "Export failed",
      "singleFile.success.exported": "Single-file board exported.",
    }[key] ?? key),
}));

vi.mock("../single-file/exportSingleFile", () => ({
  SINGLE_FILE_WARNING_BYTES: 32 * 1024 * 1024,
  createSingleFileBlob: vi.fn(),
  fetchSingleFileRuntimeTemplate: vi.fn(),
  normalizeSingleFileName: vi.fn(),
}));

vi.mock("../single-file/payload", () => ({
  createSingleFilePayload: vi.fn(),
}));

vi.mock("../single-file/saveSingleFile", () => ({
  saveSingleFileAs: vi.fn(),
}));

describe("SingleFileDialog", () => {
  const blob = new Blob(["runtime"], { type: "text/html" });
  const payload = { version: 1 } as any;

  beforeEach(() => {
    vi.mocked(fetchSingleFileRuntimeTemplate).mockResolvedValue("template");
    vi.mocked(createSingleFilePayload).mockReturnValue(payload);
    vi.mocked(createSingleFileBlob).mockReturnValue(blob);
    vi.mocked(normalizeSingleFileName).mockReturnValue("Board.html");
    vi.mocked(saveSingleFileAs).mockResolvedValue({
      mode: "download",
      handle: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <SingleFileDialog open={false} onClose={vi.fn()} excalidrawAPI={null} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("renders support boundaries and disables export without an editor API", () => {
    vi.mocked(fetchSingleFileRuntimeTemplate).mockReturnValue(
      new Promise<string>(() => undefined),
    );

    render(
      <SingleFileDialog open={true} onClose={vi.fn()} excalidrawAPI={null} />,
    );

    expect(
      screen.getByRole("dialog", { name: "Single-file board" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("AI and cloud are unavailable"),
    ).toBeInTheDocument();
    expect(screen.getByText("Secrets are excluded")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Export single file" }),
    ).toBeDisabled();
  });

  it("exports the current scene and closes after saving", async () => {
    const onClose = vi.fn();
    const setToast = vi.fn();
    const elements = [{ id: "element" }];
    const appState = { theme: "dark" };
    const files = { image: { id: "image" } };
    const excalidrawAPI = {
      getName: vi.fn(() => "Board"),
      getSceneElements: vi.fn(() => elements),
      getAppState: vi.fn(() => appState),
      getFiles: vi.fn(() => files),
      setToast,
    } as any;

    render(
      <SingleFileDialog
        open={true}
        onClose={onClose}
        excalidrawAPI={excalidrawAPI}
      />,
    );

    const exportButton = screen.getByRole("button", {
      name: "Export single file",
    });
    expect(exportButton).toBeDisabled();
    await waitFor(() => expect(exportButton).toBeEnabled());

    fireEvent.click(exportButton);

    await waitFor(() => {
      expect(saveSingleFileAs).toHaveBeenCalledWith({
        blob,
        filename: "Board.html",
      });
    });
    expect(fetchSingleFileRuntimeTemplate).toHaveBeenCalledTimes(1);
    expect(createSingleFilePayload).toHaveBeenCalledWith(
      expect.objectContaining({
        elements,
        appState,
        files,
        name: "Board",
      }),
    );
    expect(createSingleFileBlob).toHaveBeenCalledWith("template", payload);
    expect(setToast).toHaveBeenCalledWith({
      message: "Single-file board exported.",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
