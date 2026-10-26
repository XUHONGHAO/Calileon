import { dataURLToFile, getDataURL } from "@excalidraw/excalidraw/data/blob";
import { t } from "@excalidraw/excalidraw/i18n";
import {
  isInitializedAudioElement,
  isInitializedFileBackedElement,
  isInitializedImageElement,
  isInitializedVideoElement,
} from "@excalidraw/element";

import type {
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  BinaryFileData,
  BinaryFiles,
  DataURL,
} from "@excalidraw/excalidraw/types";

import type {
  AssetRef,
  AssetType,
  CloudBackend,
  EmbedService,
  ShareService,
} from "./types";

/**
 * Images, audio and video: anything missed here is never uploaded, fetched or
 * kept.
 */
export const getReferencedFileIds = (
  elements: readonly OrderedExcalidrawElement[],
): FileId[] => {
  const seen = new Set<FileId>();
  for (const element of elements) {
    if (!element.isDeleted && isInitializedFileBackedElement(element)) {
      seen.add(element.fileId);
    }
  }
  return [...seen];
};

/**
 * Files a share or embed link may carry. Camera recordings are never
 * published with a link; viewers see the poster only (ADR 0035 §8).
 */
export const getPublishableFileIds = (
  elements: readonly OrderedExcalidrawElement[],
): FileId[] => {
  const videoFileIds = new Set<FileId>();
  for (const element of elements) {
    if (isInitializedVideoElement(element)) {
      videoFileIds.add(element.fileId);
    }
  }
  return getReferencedFileIds(elements).filter(
    (fileId) => !videoFileIds.has(fileId),
  );
};

// Owner uploads skip files already uploaded this session: fileIds are content
// hashes, so the same id always means the same bytes (ADR 0035 §4). Keyed by
// scene + payload kind, since a plain and an encrypted upload differ.
const uploadedFileIds = new Map<string, Set<FileId>>();

const getUploadedSet = (key: string) => {
  let set = uploadedFileIds.get(key);
  if (!set) {
    set = new Set();
    uploadedFileIds.set(key, set);
  }
  return set;
};

/** forget dedupe state, e.g. after the server may have dropped assets */
export const resetUploadedAssetCache = (sceneId?: string) => {
  if (!sceneId) {
    uploadedFileIds.clear();
    return;
  }
  for (const key of uploadedFileIds.keys()) {
    if (key.endsWith(`:${sceneId}`)) {
      uploadedFileIds.delete(key);
    }
  }
};

const getAssetTypeForElement = (
  elements: readonly OrderedExcalidrawElement[],
  fileId: FileId,
): AssetType => {
  if (
    elements.some(
      (candidate) =>
        !candidate.isDeleted &&
        isInitializedVideoElement(candidate) &&
        candidate.fileId === fileId,
    )
  ) {
    return "video";
  }
  if (
    elements.some(
      (candidate) =>
        !candidate.isDeleted &&
        isInitializedAudioElement(candidate) &&
        candidate.fileId === fileId,
    )
  ) {
    return "audio";
  }
  const element = elements.find(
    (candidate) =>
      !candidate.isDeleted &&
      isInitializedImageElement(candidate) &&
      candidate.fileId === fileId,
  );

  return element?.customData?.aiGeneration?.kind === "image"
    ? "ai-output"
    : "image";
};

const createEncryptedBinaryFileBlob = async (
  backend: CloudBackend,
  fileData: BinaryFileData,
  encryptionKey: string,
) =>
  backend.encryption.encryptBlob(
    new Blob(
      [
        JSON.stringify({
          mimeType: fileData.mimeType,
          dataURL: fileData.dataURL,
          created: fileData.created,
        }),
      ],
      { type: "application/json" },
    ),
    encryptionKey,
  );

export const uploadSceneAssets = async (input: {
  backend: CloudBackend;
  sceneId: string;
  elements: readonly OrderedExcalidrawElement[];
  files: BinaryFiles;
}): Promise<void> => {
  if (!input.backend.capabilities.assetStorage) {
    return;
  }

  const uploaded = getUploadedSet(`plain:${input.sceneId}`);
  const fileIds = getReferencedFileIds(input.elements);
  await Promise.all(
    fileIds.map(async (fileId) => {
      const fileData = input.files[fileId];
      if (!fileData?.dataURL || uploaded.has(fileId)) {
        return;
      }

      await input.backend.assets.upload({
        blob: dataURLToFile(fileData.dataURL, fileId),
        type: getAssetTypeForElement(input.elements, fileId),
        sceneId: input.sceneId,
        fileId,
        mimeType: fileData.mimeType,
      });
      uploaded.add(fileId);
    }),
  );
};

export const uploadEncryptedSceneAssets = async (input: {
  backend: CloudBackend;
  sceneId: string;
  elements: readonly OrderedExcalidrawElement[];
  files: BinaryFiles;
  encryptionKey: string;
}): Promise<void> => {
  if (
    !input.backend.capabilities.assetStorage ||
    !input.backend.encryption.isAvailable()
  ) {
    return;
  }

  const uploaded = getUploadedSet(`encrypted:${input.sceneId}`);
  const fileIds = getReferencedFileIds(input.elements);
  await Promise.all(
    fileIds.map(async (fileId) => {
      const fileData = input.files[fileId];
      if (!fileData?.dataURL || uploaded.has(fileId)) {
        return;
      }

      const encryptedBlob = await createEncryptedBinaryFileBlob(
        input.backend,
        fileData,
        input.encryptionKey,
      );

      await input.backend.assets.upload({
        blob: encryptedBlob,
        type: getAssetTypeForElement(input.elements, fileId),
        sceneId: input.sceneId,
        fileId,
        mimeType: "application/octet-stream",
      });
      uploaded.add(fileId);
    }),
  );
};

export const uploadSharedSceneAssets = async (input: {
  shares: ShareService;
  token: string;
  sceneId: string;
  elements: readonly OrderedExcalidrawElement[];
  files: BinaryFiles;
}): Promise<void> => {
  const fileIds = getPublishableFileIds(input.elements);
  await Promise.all(
    fileIds.map(async (fileId) => {
      const fileData = input.files[fileId];
      if (!fileData?.dataURL) {
        return;
      }

      await input.shares.uploadAsset({
        token: input.token,
        blob: dataURLToFile(fileData.dataURL, fileId),
        type: getAssetTypeForElement(input.elements, fileId),
        sceneId: input.sceneId,
        fileId,
        mimeType: fileData.mimeType,
      });
    }),
  );
};

export const uploadEncryptedSharedSceneAssets = async (input: {
  backend: CloudBackend;
  shares: ShareService;
  token: string;
  sceneId: string;
  elements: readonly OrderedExcalidrawElement[];
  files: BinaryFiles;
  encryptionKey: string;
}): Promise<void> => {
  if (!input.backend.encryption.isAvailable()) {
    return;
  }

  const fileIds = getPublishableFileIds(input.elements);
  await Promise.all(
    fileIds.map(async (fileId) => {
      const fileData = input.files[fileId];
      if (!fileData?.dataURL) {
        return;
      }

      await input.shares.uploadAsset({
        token: input.token,
        blob: await createEncryptedBinaryFileBlob(
          input.backend,
          fileData,
          input.encryptionKey,
        ),
        type: getAssetTypeForElement(input.elements, fileId),
        sceneId: input.sceneId,
        fileId,
        mimeType: "application/octet-stream",
      });
    }),
  );
};

export const uploadEmbeddedSceneAssets = async (input: {
  embed: EmbedService;
  token: string;
  origin: string;
  sceneId: string;
  elements: readonly OrderedExcalidrawElement[];
  files: BinaryFiles;
}): Promise<void> => {
  const fileIds = getPublishableFileIds(input.elements);
  await Promise.all(
    fileIds.map(async (fileId) => {
      const fileData = input.files[fileId];
      if (!fileData?.dataURL) {
        return;
      }

      await input.embed.uploadAsset({
        token: input.token,
        origin: input.origin,
        blob: dataURLToFile(fileData.dataURL, fileId),
        type: getAssetTypeForElement(input.elements, fileId),
        sceneId: input.sceneId,
        fileId,
        mimeType: fileData.mimeType,
      });
    }),
  );
};

export const uploadEncryptedEmbeddedSceneAssets = async (input: {
  backend: CloudBackend;
  embed: EmbedService;
  token: string;
  origin: string;
  sceneId: string;
  elements: readonly OrderedExcalidrawElement[];
  files: BinaryFiles;
  encryptionKey: string;
}): Promise<void> => {
  if (!input.backend.encryption.isAvailable()) {
    return;
  }

  const fileIds = getPublishableFileIds(input.elements);
  await Promise.all(
    fileIds.map(async (fileId) => {
      const fileData = input.files[fileId];
      if (!fileData?.dataURL) {
        return;
      }

      await input.embed.uploadAsset({
        token: input.token,
        origin: input.origin,
        blob: await createEncryptedBinaryFileBlob(
          input.backend,
          fileData,
          input.encryptionKey,
        ),
        type: getAssetTypeForElement(input.elements, fileId),
        sceneId: input.sceneId,
        fileId,
        mimeType: "application/octet-stream",
      });
    }),
  );
};

const fetchAssetAsBinaryFile = async (
  asset: AssetRef,
): Promise<BinaryFileData> => {
  const fileId = asset.fileId || asset.id;
  const response = await fetch(asset.url);
  if (!response.ok) {
    throw new Error(t("cloud.scenes.assetLoadFailed"));
  }
  const blob = await response.blob();
  const dataURL = (await getDataURL(blob)) as DataURL;
  return {
    id: fileId as FileId,
    mimeType: (asset.mimeType ||
      blob.type ||
      "application/octet-stream") as BinaryFileData["mimeType"],
    dataURL,
    created: asset.createdAt || Date.now(),
    lastRetrieved: Date.now(),
  };
};

const readBlobAsText = async (blob: Blob): Promise<string> => {
  if (typeof blob.text === "function") {
    return blob.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsText(blob);
  });
};

const fetchEncryptedAssetAsBinaryFile = async (
  backend: CloudBackend,
  asset: AssetRef,
  encryptionKey: string,
): Promise<BinaryFileData> => {
  const fileId = asset.fileId || asset.id;
  const response = await fetch(asset.url);
  if (!response.ok) {
    throw new Error(t("cloud.scenes.assetLoadFailed"));
  }
  const decryptedBlob = await backend.encryption.decryptBlob(
    await response.blob(),
    encryptionKey,
  );
  const encryptedAsset = JSON.parse(await readBlobAsText(decryptedBlob)) as {
    mimeType?: BinaryFileData["mimeType"];
    dataURL?: DataURL;
    created?: number;
  };
  if (!encryptedAsset.dataURL) {
    throw new Error(t("cloud.scenes.assetLoadFailed"));
  }

  return {
    id: fileId as FileId,
    mimeType:
      encryptedAsset.mimeType ||
      ("application/octet-stream" as BinaryFileData["mimeType"]),
    dataURL: encryptedAsset.dataURL,
    created: encryptedAsset.created || Date.now(),
    lastRetrieved: Date.now(),
  };
};

export const loadSceneAssets = async (input: {
  backend: CloudBackend;
  sceneId: string;
  elements: readonly OrderedExcalidrawElement[];
}): Promise<{
  loadedFiles: BinaryFileData[];
  erroredFiles: Map<FileId, true>;
}> => {
  const neededFileIds = new Set(getReferencedFileIds(input.elements));
  if (!input.backend.capabilities.assetStorage || neededFileIds.size === 0) {
    return { loadedFiles: [], erroredFiles: new Map() };
  }

  const assets = await input.backend.assets.listByScene(input.sceneId);
  const relevantAssets = assets.filter(
    (asset) => asset.fileId && neededFileIds.has(asset.fileId as FileId),
  );
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    relevantAssets.map(async (asset) => {
      const fileId = asset.fileId as FileId;
      try {
        loadedFiles.push(await fetchAssetAsBinaryFile(asset));
      } catch {
        erroredFiles.set(fileId, true);
      }
    }),
  );

  for (const fileId of neededFileIds) {
    if (!relevantAssets.some((asset) => asset.fileId === fileId)) {
      erroredFiles.set(fileId, true);
    }
  }

  return { loadedFiles, erroredFiles };
};

export const loadEncryptedSceneAssets = async (input: {
  backend: CloudBackend;
  sceneId: string;
  elements: readonly OrderedExcalidrawElement[];
  encryptionKey: string;
}): Promise<{
  loadedFiles: BinaryFileData[];
  erroredFiles: Map<FileId, true>;
}> => {
  const neededFileIds = new Set(getReferencedFileIds(input.elements));
  if (
    !input.backend.capabilities.assetStorage ||
    !input.backend.encryption.isAvailable() ||
    neededFileIds.size === 0
  ) {
    return { loadedFiles: [], erroredFiles: new Map() };
  }

  const assets = await input.backend.assets.listByScene(input.sceneId);
  const relevantAssets = assets.filter(
    (asset) => asset.fileId && neededFileIds.has(asset.fileId as FileId),
  );
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    relevantAssets.map(async (asset) => {
      const fileId = asset.fileId as FileId;
      try {
        loadedFiles.push(
          await fetchEncryptedAssetAsBinaryFile(
            input.backend,
            asset,
            input.encryptionKey,
          ),
        );
      } catch {
        erroredFiles.set(fileId, true);
      }
    }),
  );

  for (const fileId of neededFileIds) {
    if (!relevantAssets.some((asset) => asset.fileId === fileId)) {
      erroredFiles.set(fileId, true);
    }
  }

  return { loadedFiles, erroredFiles };
};

export const loadEncryptedAssetRefsForElements = async (input: {
  backend: CloudBackend;
  assets: AssetRef[];
  elements: readonly OrderedExcalidrawElement[];
  encryptionKey: string;
}): Promise<{
  loadedFiles: BinaryFileData[];
  erroredFiles: Map<FileId, true>;
}> => {
  const neededFileIds = new Set(getPublishableFileIds(input.elements));
  if (!input.backend.encryption.isAvailable() || neededFileIds.size === 0) {
    return { loadedFiles: [], erroredFiles: new Map() };
  }

  const relevantAssets = input.assets.filter(
    (asset) => asset.fileId && neededFileIds.has(asset.fileId as FileId),
  );
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    relevantAssets.map(async (asset) => {
      const fileId = asset.fileId as FileId;
      try {
        loadedFiles.push(
          await fetchEncryptedAssetAsBinaryFile(
            input.backend,
            asset,
            input.encryptionKey,
          ),
        );
      } catch {
        erroredFiles.set(fileId, true);
      }
    }),
  );

  for (const fileId of neededFileIds) {
    if (!relevantAssets.some((asset) => asset.fileId === fileId)) {
      erroredFiles.set(fileId, true);
    }
  }

  return { loadedFiles, erroredFiles };
};

export const loadAssetRefsForElements = async (input: {
  assets: AssetRef[];
  elements: readonly OrderedExcalidrawElement[];
}): Promise<{
  loadedFiles: BinaryFileData[];
  erroredFiles: Map<FileId, true>;
}> => {
  const neededFileIds = new Set(getPublishableFileIds(input.elements));
  if (neededFileIds.size === 0) {
    return { loadedFiles: [], erroredFiles: new Map() };
  }

  const relevantAssets = input.assets.filter(
    (asset) => asset.fileId && neededFileIds.has(asset.fileId as FileId),
  );
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    relevantAssets.map(async (asset) => {
      const fileId = asset.fileId as FileId;
      try {
        loadedFiles.push(await fetchAssetAsBinaryFile(asset));
      } catch {
        erroredFiles.set(fileId, true);
      }
    }),
  );

  for (const fileId of neededFileIds) {
    if (!relevantAssets.some((asset) => asset.fileId === fileId)) {
      erroredFiles.set(fileId, true);
    }
  }

  return { loadedFiles, erroredFiles };
};
