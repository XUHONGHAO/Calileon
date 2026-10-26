/**
 * Vault v2 (P4c) W5 attachments.
 *
 * Attachments are not convergent data (ADR 0030 §5): the document only holds
 * an image element's `fileId` and `status` registers. The bytes travel in the
 * ADR 0029 asset envelope, unchanged, through the existing encrypted asset
 * service and the durable P4b attachment queue, scoped to the v2 vaultId and
 * keyed with the v2 root key. The asset RPCs and bucket are protocol-agnostic,
 * so no server change is needed.
 *
 * Flow per editor change:
 *   - new image files → queue (ciphertext persisted before upload, stable
 *     digest, receipt verified) → element status "pending" → "saved"; the
 *     status change is an ordinary register write, so peers learn to fetch;
 *   - "saved" images whose file is not loaded → download (own unacknowledged
 *     uploads render from the local ciphertext) → addFiles.
 * Fetch errors only show in FileStatusStore; they are never written into the
 * shared document.
 */
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { newElementWith } from "@excalidraw/element";

import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";

import type { BinaryFileData, BinaryFiles } from "@excalidraw/excalidraw/types";

import { FileManager, isRealtimeFileBackedElement } from "../../FileManager";
import { FileStatusStore } from "../../fileStatusStore";
import { createVaultAttachmentQueue } from "../attachmentQueue";
import { downloadVaultFileWithReceipt, uploadVaultFile } from "../fileAssets";

import { classifyAttachmentFailures } from "./uiState";

import type { VaultEncryptedAssetService } from "../assets";
import type {
  VaultAttachmentQueue,
  VaultAttachmentQueueState,
} from "../attachmentQueue";
import type { VaultLocalStore } from "../local-store/store";
import type { VaultRole } from "../types";
import type { VaultV2AttachmentFailure } from "./uiState";

/** the slice of the imperative API attachments need */
export type VaultV2AssetEditorApi = {
  getSceneElementsIncludingDeleted(): readonly ExcalidrawElement[];
  getFiles(): BinaryFiles;
  addFiles(files: BinaryFileData[]): void;
  updateScene(scene: {
    elements: readonly ExcalidrawElement[];
    captureUpdate: typeof CaptureUpdateAction.NEVER;
  }): void;
};

export type VaultV2AssetsInput = {
  vaultId: string;
  roomId: string;
  rootKey: string;
  invitationCapability: string;
  role: VaultRole;
  service: VaultEncryptedAssetService;
  /** P4b local store (attachment tasks); editors only */
  store?: VaultLocalStore | null;
  isOnline?: () => boolean;
  onStateChange?: (state: VaultAttachmentQueueState) => void;
  /** W6: whether failed uploads retry by themselves or need the user */
  onFailureChange?: (failure: VaultV2AttachmentFailure) => void;
  onError?: (error: unknown) => void;
  /** coalescing delay between change and sync (tests pass 0) */
  delayMs?: number;
};

export class VaultV2Assets {
  /** durable upload queue (editors with a local store) */
  readonly queue: VaultAttachmentQueue | null;
  private readonly files: FileManager;
  private api: VaultV2AssetEditorApi | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private dirty = false;
  private disposed = false;
  private readonly onOnline = () => this.schedule();

  constructor(private readonly input: VaultV2AssetsInput) {
    this.queue =
      input.role === "editor" && input.store
        ? createVaultAttachmentQueue({
            store: input.store,
            service: input.service,
            vaultId: input.vaultId,
            roomId: input.roomId,
            invitationCapability: input.invitationCapability,
            rootKey: input.rootKey,
            role: input.role,
            isOnline:
              input.isOnline ?? (() => globalThis.navigator?.onLine !== false),
            onStateChange: input.onStateChange,
          })
        : null;
    this.files = new FileManager({
      onFileStatusChange: FileStatusStore.updateStatuses.bind(FileStatusStore),
      getFiles: (ids) => this.fetch(ids),
      saveFiles: ({ addedFiles }) => this.save(addedFiles),
    });
    globalThis.addEventListener?.("online", this.onOnline);
  }

  attach(api: VaultV2AssetEditorApi) {
    this.api = api;
    this.schedule();
  }

  /** after every editor change, local or remote (coalesced) */
  schedule() {
    if (this.disposed) {
      return;
    }
    this.dirty = true;
    if (this.timer === null && !this.running) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.run();
      }, this.input.delayMs ?? 300);
    }
  }

  /** runs one sync now (and again if changes arrived meanwhile) */
  run = async (): Promise<void> => {
    if (this.running) {
      return this.running;
    }
    this.running = (async () => {
      while (this.dirty && !this.disposed) {
        this.dirty = false;
        try {
          await this.sync();
        } catch (error) {
          this.input.onError?.(error);
        }
      }
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  };

  dispose() {
    this.disposed = true;
    globalThis.removeEventListener?.("online", this.onOnline);
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.queue?.dispose();
    this.files.reset();
    this.api = null;
  }

  private async sync() {
    const api = this.api;
    if (!api) {
      return;
    }
    if (this.input.role === "editor") {
      await this.files.saveFiles({
        elements: api.getSceneElementsIncludingDeleted(),
        files: api.getFiles(),
      });
      let changed = false;
      const next = api.getSceneElementsIncludingDeleted().map((element) => {
        if (this.files.shouldUpdateImageElementStatus(element)) {
          changed = true;
          // an ordinary register write: tells peers the file is on the server
          return newElementWith(element, { status: "saved" });
        }
        return element;
      });
      if (changed && !this.disposed) {
        api.updateScene({
          elements: next,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
    }
    const loaded = api.getFiles();
    const missing = new Set<FileId>();
    for (const element of api.getSceneElementsIncludingDeleted()) {
      if (
        // audio too, or peers see a saved voice bubble that cannot play;
        // never camera recordings (ADR 0035 §7)
        isRealtimeFileBackedElement(element) &&
        !element.isDeleted &&
        element.status === "saved" &&
        !loaded[element.fileId] &&
        !this.files.isFileTracked(element.fileId)
      ) {
        missing.add(element.fileId);
      }
    }
    if (missing.size > 0) {
      const { loadedFiles } = await this.files.getFiles([...missing]);
      if (loadedFiles.length > 0 && !this.disposed) {
        api.addFiles(loadedFiles);
      }
    }
  }

  private async fetch(ids: FileId[]) {
    const loadedFiles: BinaryFileData[] = [];
    const erroredFiles = new Map<FileId, true>();
    for (const fileId of ids) {
      try {
        // our own upload that the server has not acknowledged yet
        const local = await this.queue?.readUnacknowledgedFile(fileId);
        if (local) {
          loadedFiles.push(local);
          continue;
        }
        const downloaded = await downloadVaultFileWithReceipt({
          service: this.input.service,
          vaultId: this.input.vaultId,
          invitationCapability: this.input.invitationCapability,
          rootKey: this.input.rootKey,
          fileId,
        });
        await this.queue?.verifyDownloadedFile({
          fileId,
          encryptedDigest: downloaded.encryptedDigest,
          ciphertextBytes: downloaded.ciphertextBytes,
        });
        loadedFiles.push(downloaded.file);
      } catch (error) {
        erroredFiles.set(fileId, true);
        this.input.onError?.(error);
      }
    }
    return { loadedFiles, erroredFiles };
  }

  /**
   * A file counts as saved only once the server has it (receipt verified):
   * that is what "saved" promises peers. Queued-but-unsent files stay
   * pending and are retried on the next change / `online`.
   */
  private async save(addedFiles: Map<FileId, BinaryFileData>) {
    const savedFiles = new Map<FileId, BinaryFileData>();
    const erroredFiles = new Map<FileId, BinaryFileData>();
    if (addedFiles.size === 0) {
      return { savedFiles, erroredFiles };
    }
    const queue = this.queue;
    if (!queue) {
      // no local store: upload directly (still the 0029 envelope + receipt)
      for (const [fileId, file] of addedFiles) {
        try {
          await uploadVaultFile({
            service: this.input.service,
            vaultId: this.input.vaultId,
            invitationCapability: this.input.invitationCapability,
            rootKey: this.input.rootKey,
            file,
          });
          savedFiles.set(fileId, file);
        } catch (error) {
          erroredFiles.set(fileId, file);
          this.input.onError?.(error);
        }
      }
      return { savedFiles, erroredFiles };
    }
    for (const [fileId, file] of addedFiles) {
      try {
        await queue.enqueue({ fileId, file });
      } catch (error) {
        erroredFiles.set(fileId, file);
        this.input.onError?.(error);
      }
    }
    await queue.drain();
    const list = await queue.listTasks();
    this.input.onFailureChange?.(classifyAttachmentFailures(list));
    const tasks = new Map(list.map((task) => [task.fileId, task]));
    for (const [fileId, file] of addedFiles) {
      if (erroredFiles.has(fileId)) {
        continue;
      }
      if (tasks.get(fileId)?.status === "complete") {
        savedFiles.set(fileId, file);
      } else {
        // pending/offline/failed: not saved yet; the next save retries
        erroredFiles.set(fileId, file);
      }
    }
    return { savedFiles, erroredFiles };
  }
}
