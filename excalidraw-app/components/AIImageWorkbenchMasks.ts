import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { DataURL } from "@excalidraw/excalidraw/types";
import type { ExcalidrawFreeDrawElement } from "@excalidraw/element/types";

import { dataURLToFile, fileToDataURL } from "../ai/imageCanvas";
import { getAIWorkbenchMaskManifestKey } from "../ai/workbenchPersistenceScope";
import { AIWorkbenchIndexedDBAdapter } from "../data/AIWorkbenchIndexedDB";

import type { AIImageEditableMask } from "../ai/types";

// Inpaint masks are drawn per canvas image. V2 persists the mask File/Blob
// plus its freedraw strokes, so persistence does not wait for the preview
// dataURL to be generated asynchronously.

// Legacy v1 stored base64 PNGs in localStorage, so its migration-only writer
// retains the historical quota. V2 stores Blob payloads in IndexedDB and must
// not silently drop masks by count or encoded localStorage size.
const MAX_PERSISTED_MASKS = 12;
const MAX_PERSISTED_MASK_STATE_BYTES = 4 * 1024 * 1024;

type PersistedMaskManifestV2 = {
  version: 2;
  revision: string;
  masks: Array<{
    imageId: string;
    updatedAt: number;
    fileName: string;
    mimeType: string;
    payloadKey: string;
  }>;
};

const createRevision = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const readMaskManifest = (key: string): PersistedMaskManifestV2 | null => {
  const rawValue = localStorage.getItem(key);
  if (!rawValue) {
    return null;
  }
  const parsed = JSON.parse(rawValue);
  return parsed?.version === 2 && Array.isArray(parsed.masks)
    ? (parsed as PersistedMaskManifestV2)
    : null;
};

const maskWriteStates = new Map<
  string,
  { latestGeneration: number; chain: Promise<void> }
>();

type PersistedMask = {
  imageId: string;
  dataURL: DataURL;
  elements: readonly ExcalidrawFreeDrawElement[];
  updatedAt: number;
  fileName: string;
  mimeType: string;
};

export const getMaskPersistenceKey = (
  excalidrawAPI: ExcalidrawImperativeAPI,
) => {
  // getName() fabricates a timestamped Untitled name when appState.name is
  // null, which made every persistence read/write use a different key.
  const sceneName = excalidrawAPI.getAppState().name?.trim() || "default";

  return `ai-inpaint-masks-${encodeURIComponent(
    `${window.location.pathname}${window.location.search}:${sceneName}`,
  )}`;
};

export const persistMaskStateV1ForMigrationTests = (
  key: string,
  masksByImageId: Record<string, AIImageEditableMask>,
) => {
  try {
    const entries = Object.entries(masksByImageId)
      // Only masks whose dataURL has landed can be rebuilt on restore; the
      // dataURL is patched in asynchronously right after the mask is created.
      .filter(([, mask]) => typeof mask.dataURL === "string" && !!mask.dataURL)
      // Newest first so the trim loop below discards the oldest under quota.
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, MAX_PERSISTED_MASKS)
      .map(
        ([imageId, mask]): PersistedMask => ({
          imageId,
          dataURL: mask.dataURL as DataURL,
          elements: mask.elements,
          updatedAt: mask.updatedAt,
          fileName: mask.file.name,
          mimeType: mask.file.type || "image/png",
        }),
      );

    if (!entries.length) {
      localStorage.removeItem(key);
      return;
    }

    const payload = { version: 1, masks: entries };
    let serialized = JSON.stringify(payload);

    while (
      serialized.length > MAX_PERSISTED_MASK_STATE_BYTES &&
      payload.masks.length > 0
    ) {
      payload.masks.pop();
      serialized = JSON.stringify(payload);
    }

    localStorage.setItem(key, serialized);
  } catch (error) {
    console.error("Could not persist AI inpaint masks", error);
  }
};

const loadPersistedMaskStateLegacy = (
  key: string,
): Record<string, AIImageEditableMask> => {
  try {
    const rawValue = localStorage.getItem(key);

    if (!rawValue) {
      return {};
    }

    const parsed = JSON.parse(rawValue);
    const masks = Array.isArray(parsed?.masks) ? parsed.masks : [];
    const restored: Record<string, AIImageEditableMask> = {};

    for (const value of masks) {
      const mask = normalizePersistedMask(value);
      if (mask) {
        restored[mask.imageId] = mask.record;
      }
    }

    return restored;
  } catch (error) {
    console.error("Could not restore AI inpaint masks", error);
    return {};
  }
};

const persistMaskStateRevision = async (
  scopeId: string,
  masksByImageId: Record<string, AIImageEditableMask>,
  legacyKey?: string,
  isLatest: () => boolean = () => true,
) => {
  const manifestKey = getAIWorkbenchMaskManifestKey(scopeId);
  const previousManifest = readMaskManifest(manifestKey);
  const entries = Object.entries(masksByImageId).sort(
    (a, b) => b[1].updatedAt - a[1].updatedAt,
  );

  if (!entries.length) {
    localStorage.removeItem(manifestKey);
    if (legacyKey) {
      localStorage.removeItem(legacyKey);
    }
    if (previousManifest) {
      await AIWorkbenchIndexedDBAdapter.deleteMany(
        previousManifest.masks.map((mask) => mask.payloadKey),
      );
    }
    return;
  }

  const revision = createRevision();
  const payloadKeys = await AIWorkbenchIndexedDBAdapter.setRevisionPayloads(
    { scopeId, revision, kind: "mask" },
    entries.map(([imageId, mask]) => ({
      id: `${imageId}:${mask.updatedAt}`,
      value: { blob: mask.file, elements: mask.elements },
    })),
  );
  let verified: Array<
    | {
        blob: Blob;
        elements: readonly ExcalidrawFreeDrawElement[];
      }
    | undefined
  >;
  try {
    verified = await AIWorkbenchIndexedDBAdapter.getMany<{
      blob: Blob;
      elements: readonly ExcalidrawFreeDrawElement[];
    }>(payloadKeys);
  } catch (error) {
    await AIWorkbenchIndexedDBAdapter.deleteMany(payloadKeys);
    throw error;
  }
  if (verified.some((payload) => !(payload?.blob instanceof Blob))) {
    await AIWorkbenchIndexedDBAdapter.deleteMany(payloadKeys);
    throw new Error("Could not verify AI mask payloads.");
  }
  if (!isLatest()) {
    await AIWorkbenchIndexedDBAdapter.deleteMany(payloadKeys);
    return;
  }

  const manifest: PersistedMaskManifestV2 = {
    version: 2,
    revision,
    masks: entries.map(([imageId, mask], index) => ({
      imageId,
      updatedAt: mask.updatedAt,
      fileName: mask.file.name,
      mimeType: mask.file.type || "image/png",
      payloadKey: payloadKeys[index],
    })),
  };
  try {
    localStorage.setItem(manifestKey, JSON.stringify(manifest));
  } catch (error) {
    await AIWorkbenchIndexedDBAdapter.deleteMany(payloadKeys);
    throw error;
  }
  if (legacyKey && legacyKey !== manifestKey) {
    localStorage.removeItem(legacyKey);
  }
  if (previousManifest) {
    void AIWorkbenchIndexedDBAdapter.deleteMany(
      previousManifest.masks.map((mask) => mask.payloadKey),
    ).catch((error) => console.warn(error));
  }
};

export const persistMaskState = (
  scopeId: string,
  masksByImageId: Record<string, AIImageEditableMask>,
  legacyKey?: string,
) => {
  const writeState = maskWriteStates.get(scopeId) || {
    latestGeneration: 0,
    chain: Promise.resolve(),
  };
  writeState.latestGeneration += 1;
  const generation = writeState.latestGeneration;
  const run = writeState.chain
    .catch(() => undefined)
    .then(async () => {
      if (generation !== writeState.latestGeneration) {
        return;
      }
      await persistMaskStateRevision(
        scopeId,
        masksByImageId,
        legacyKey,
        () => generation === writeState.latestGeneration,
      );
    });
  writeState.chain = run;
  maskWriteStates.set(scopeId, writeState);
  return run;
};

export const loadPersistedMaskState = async (
  scopeId: string,
  legacyKey?: string,
  getCurrentSceneImageIds?: () => ReadonlySet<string>,
): Promise<Record<string, AIImageEditableMask>> => {
  try {
    const manifest = readMaskManifest(getAIWorkbenchMaskManifestKey(scopeId));
    if (manifest) {
      const payloads = await AIWorkbenchIndexedDBAdapter.getMany<{
        blob: Blob;
        elements: readonly ExcalidrawFreeDrawElement[];
      }>(manifest.masks.map((mask) => mask.payloadKey));
      if (payloads.some((payload) => !(payload?.blob instanceof Blob))) {
        throw new Error("AI mask payloads are incomplete.");
      }
      const restored: Record<string, AIImageEditableMask> = {};
      await Promise.all(
        manifest.masks.map(async (mask, index) => {
          const payload = payloads[index];
          if (!(payload?.blob instanceof Blob)) {
            return;
          }
          const file =
            payload.blob instanceof File
              ? payload.blob
              : new File([payload.blob], mask.fileName, {
                  type: mask.mimeType,
                });
          restored[mask.imageId] = {
            file,
            dataURL: await fileToDataURL(file),
            elements: payload.elements,
            updatedAt: mask.updatedAt,
          };
        }),
      );
      return filterMasksForCurrentScene(restored, getCurrentSceneImageIds);
    }

    if (!legacyKey) {
      return {};
    }
    const restored = loadPersistedMaskStateLegacy(legacyKey);
    if (Object.keys(restored).length) {
      try {
        await persistMaskState(scopeId, restored, legacyKey);
      } catch (error) {
        console.error("Could not migrate AI inpaint masks", error);
      }
    }
    return filterMasksForCurrentScene(restored, getCurrentSceneImageIds);
  } catch (error) {
    console.error("Could not restore AI inpaint masks", error);
    throw error;
  }
};

const filterMasksForCurrentScene = (
  masksByImageId: Record<string, AIImageEditableMask>,
  getCurrentSceneImageIds?: () => ReadonlySet<string>,
) => {
  if (!getCurrentSceneImageIds) {
    return masksByImageId;
  }

  const currentSceneImageIds = getCurrentSceneImageIds();
  return Object.fromEntries(
    Object.entries(masksByImageId).filter(([imageId]) =>
      currentSceneImageIds.has(imageId),
    ),
  );
};

const normalizePersistedMask = (
  value: unknown,
): { imageId: string; record: AIImageEditableMask } | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const imageId =
    typeof candidate.imageId === "string" ? candidate.imageId : "";
  const dataURL =
    typeof candidate.dataURL === "string" ? (candidate.dataURL as DataURL) : "";

  if (!imageId || !dataURL) {
    return null;
  }

  const elements = Array.isArray(candidate.elements)
    ? (candidate.elements as readonly ExcalidrawFreeDrawElement[])
    : [];
  const updatedAt =
    typeof candidate.updatedAt === "number" ? candidate.updatedAt : Date.now();
  const fileName =
    typeof candidate.fileName === "string"
      ? candidate.fileName
      : `mask-${imageId}.png`;
  const mimeType =
    typeof candidate.mimeType === "string" ? candidate.mimeType : "image/png";

  return {
    imageId,
    record: {
      file: dataURLToFile(dataURL, fileName, mimeType),
      dataURL,
      elements,
      updatedAt,
    },
  };
};
