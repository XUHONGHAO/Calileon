export type SingleFileSaveResult = {
  mode: "overwrite" | "saveAs" | "download";
  handle: FileSystemFileHandle | null;
};

type PickerWindow = Window & {
  showOpenFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle>;
};

const HTML_PICKER_OPTIONS = {
  types: [
    {
      description: "Calileon single-file board",
      accept: { "text/html": [".html"] },
    },
  ],
  excludeAcceptAllOption: false,
};

const writeHandle = async (
  handle: FileSystemFileHandle,
  blob: Blob,
): Promise<void> => {
  const permissionHandle = handle as FileSystemFileHandle & {
    queryPermission: (options: {
      mode: "readwrite";
    }) => Promise<PermissionState>;
    requestPermission: (options: {
      mode: "readwrite";
    }) => Promise<PermissionState>;
  };
  const permission = await permissionHandle.queryPermission({
    mode: "readwrite",
  });
  if (
    permission !== "granted" &&
    (await permissionHandle.requestPermission({ mode: "readwrite" })) !==
      "granted"
  ) {
    throw new DOMException(
      "Write permission was not granted",
      "NotAllowedError",
    );
  }

  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    await writable.abort?.().catch(() => undefined);
    throw error;
  }
};

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

export const saveSingleFileAs = async ({
  blob,
  filename,
  pickerWindow = window as PickerWindow,
}: {
  blob: Blob;
  filename: string;
  pickerWindow?: PickerWindow;
}): Promise<SingleFileSaveResult> => {
  if (pickerWindow.showSaveFilePicker) {
    try {
      const handle = await pickerWindow.showSaveFilePicker({
        ...HTML_PICKER_OPTIONS,
        suggestedName: filename,
      });
      await writeHandle(handle, blob);
      return { mode: "saveAs", handle: null };
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== "AbortError") {
        downloadBlob(blob, filename);
        return { mode: "download", handle: null };
      }
      throw error;
    }
  }

  downloadBlob(blob, filename);
  return { mode: "download", handle: null };
};

export const saveSingleFile = async ({
  blob,
  filename,
  currentHandle,
  confirmFirstOverwrite,
  pickerWindow = window as PickerWindow,
}: {
  blob: Blob;
  filename: string;
  currentHandle: FileSystemFileHandle | null;
  confirmFirstOverwrite: () => boolean | Promise<boolean>;
  pickerWindow?: PickerWindow;
}): Promise<SingleFileSaveResult> => {
  if (currentHandle) {
    try {
      await writeHandle(currentHandle, blob);
      return { mode: "overwrite", handle: currentHandle };
    } catch {
      return saveSingleFileAs({ blob, filename, pickerWindow });
    }
  }

  if (pickerWindow.showOpenFilePicker && (await confirmFirstOverwrite())) {
    try {
      const [handle] = await pickerWindow.showOpenFilePicker({
        ...HTML_PICKER_OPTIONS,
        multiple: false,
      });
      if (handle) {
        await writeHandle(handle, blob);
        return { mode: "overwrite", handle };
      }
    } catch {
      return saveSingleFileAs({ blob, filename, pickerWindow });
    }
  }

  return saveSingleFileAs({ blob, filename, pickerWindow });
};
