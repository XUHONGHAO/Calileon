import { vi } from "vitest";

import { saveSingleFile, saveSingleFileAs } from "./saveSingleFile";

const createHandle = ({
  permission = "granted" as PermissionState,
  requestedPermission = "granted" as PermissionState,
  writeError,
}: {
  permission?: PermissionState;
  requestedPermission?: PermissionState;
  writeError?: Error;
} = {}) => {
  const writable = {
    write: writeError
      ? vi.fn().mockRejectedValue(writeError)
      : vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
  };
  const handle = {
    name: "board.html",
    kind: "file",
    queryPermission: vi.fn().mockResolvedValue(permission),
    requestPermission: vi.fn().mockResolvedValue(requestedPermission),
    createWritable: vi.fn().mockResolvedValue(writable),
  } as unknown as FileSystemFileHandle;

  return { handle, writable };
};

describe("single-file saving", () => {
  const blob = new Blob(["offline board"], { type: "text/html" });
  let anchorClick: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:single-file"),
      revokeObjectURL: vi.fn(),
    });
    anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    anchorClick.mockRestore();
  });

  it("overwrites an existing authorized handle without prompting", async () => {
    const { handle, writable } = createHandle();
    const confirmFirstOverwrite = vi.fn();
    const showOpenFilePicker = vi.fn();

    const result = await saveSingleFile({
      blob,
      filename: "board.html",
      currentHandle: handle,
      confirmFirstOverwrite,
      pickerWindow: { showOpenFilePicker } as any,
    });

    expect(result).toEqual({ mode: "overwrite", handle });
    expect(confirmFirstOverwrite).not.toHaveBeenCalled();
    expect(showOpenFilePicker).not.toHaveBeenCalled();
    expect(writable.write).toHaveBeenCalledWith(blob);
    expect(writable.close).toHaveBeenCalledTimes(1);
    expect(anchorClick).not.toHaveBeenCalled();
  });

  it("requires confirmation and explicit selection before the first overwrite", async () => {
    const { handle, writable } = createHandle({ permission: "prompt" });
    const confirmFirstOverwrite = vi.fn().mockResolvedValue(true);
    const showOpenFilePicker = vi.fn().mockResolvedValue([handle]);

    const result = await saveSingleFile({
      blob,
      filename: "board.html",
      currentHandle: null,
      confirmFirstOverwrite,
      pickerWindow: { showOpenFilePicker } as any,
    });

    expect(confirmFirstOverwrite).toHaveBeenCalledTimes(1);
    expect(showOpenFilePicker).toHaveBeenCalledWith(
      expect.objectContaining({ multiple: false }),
    );
    expect((handle as any).requestPermission).toHaveBeenCalledWith({
      mode: "readwrite",
    });
    expect(writable.write).toHaveBeenCalledWith(blob);
    expect(result).toEqual({ mode: "overwrite", handle });
  });

  it("downloads a copy when the File System Access API is unsupported", async () => {
    const result = await saveSingleFile({
      blob,
      filename: "fallback.html",
      currentHandle: null,
      confirmFirstOverwrite: vi.fn(),
      pickerWindow: {} as any,
    });

    expect(result).toEqual({ mode: "download", handle: null });
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
  });

  it("falls back to Save as when first-overwrite selection is denied", async () => {
    const { handle: saveAsHandle, writable } = createHandle();
    const showOpenFilePicker = vi
      .fn()
      .mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    const showSaveFilePicker = vi.fn().mockResolvedValue(saveAsHandle);

    const result = await saveSingleFile({
      blob,
      filename: "fallback.html",
      currentHandle: null,
      confirmFirstOverwrite: vi.fn().mockReturnValue(true),
      pickerWindow: { showOpenFilePicker, showSaveFilePicker } as any,
    });

    expect(showSaveFilePicker).toHaveBeenCalledTimes(1);
    expect(writable.write).toHaveBeenCalledWith(blob);
    expect(result).toEqual({ mode: "saveAs", handle: null });
  });

  it("falls back to Save as when overwriting the current handle fails", async () => {
    const { handle: currentHandle, writable: failedWritable } = createHandle({
      writeError: new Error("disk full"),
    });
    const { handle: saveAsHandle, writable: saveAsWritable } = createHandle();
    const showSaveFilePicker = vi.fn().mockResolvedValue(saveAsHandle);

    const result = await saveSingleFile({
      blob,
      filename: "fallback.html",
      currentHandle,
      confirmFirstOverwrite: vi.fn(),
      pickerWindow: { showSaveFilePicker } as any,
    });

    expect(failedWritable.abort).toHaveBeenCalledTimes(1);
    expect(showSaveFilePicker).toHaveBeenCalledTimes(1);
    expect(saveAsWritable.write).toHaveBeenCalledWith(blob);
    expect(result).toEqual({ mode: "saveAs", handle: null });
  });

  it("keeps explicit Save as independent from any current handle", async () => {
    const { handle, writable } = createHandle();
    const showSaveFilePicker = vi.fn().mockResolvedValue(handle);

    const result = await saveSingleFileAs({
      blob,
      filename: "copy.html",
      pickerWindow: { showSaveFilePicker } as any,
    });

    expect(showSaveFilePicker).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: "copy.html" }),
    );
    expect(writable.write).toHaveBeenCalledWith(blob);
    expect(result).toEqual({ mode: "saveAs", handle: null });
  });
});
