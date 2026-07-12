import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import {
  generateIdFromFile,
  getDataURL,
} from "@excalidraw/excalidraw/data/blob";
import {
  getCommonBounds,
  getSelectedElements,
  getVisibleSceneBounds,
  isInitializedImageElement,
  newElementWith,
  newImageElement,
  syncInvalidIndices,
} from "@excalidraw/element";

import type {
  BinaryFileData,
  DataURL,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  InitializedExcalidrawImageElement,
  NonDeleted,
} from "@excalidraw/element/types";

import type {
  ManyMindsAssetRef,
  ManyMindsPortableRelation,
  ManyMindsTask,
} from "./manyMindsTypes";

const GRID_GAP = 24;
const GRID_INSERT_GAP = 64;
const MAX_PREVIEW_SIZE = 360;

export type ResolvedManyMindsAsset = ManyMindsAssetRef & {
  blob?: Blob;
  dataURL?: DataURL;
  mimeType?: string;
  width?: number;
  height?: number;
};

export type ManyMindsCanvasItem = {
  task: Pick<ManyMindsTask, "id">;
  asset: ResolvedManyMindsAsset;
  relation: ManyMindsPortableRelation;
};

type InsertManyMindsCanvasOptions = {
  excalidrawAPI: ExcalidrawImperativeAPI;
  items: readonly ManyMindsCanvasItem[];
  sourceElementIds?: readonly string[];
};

type ReplaceManyMindsImageOptions = {
  excalidrawAPI: ExcalidrawImperativeAPI;
  item: ManyMindsCanvasItem;
  sourceElementId: string;
};

type PreparedImage = {
  file: BinaryFileData;
  width: number;
  height: number;
  relation: ManyMindsPortableRelation;
};

/** Inserts a single result through the same atomic path used by grid inserts. */
export const insertManyMindsTaskIntoCanvas = (
  options: Omit<InsertManyMindsCanvasOptions, "items"> & {
    item: ManyMindsCanvasItem;
  },
) =>
  insertManyMindsTasksIntoCanvas({
    ...options,
    items: [options.item],
  });

/**
 * Inserts any selected subset (or the whole successful batch) in one scene
 * update. A single history entry keeps multi/all insertion undoable as a unit.
 */
export const insertManyMindsTasksIntoCanvas = async ({
  excalidrawAPI,
  items,
  sourceElementIds = [],
}: InsertManyMindsCanvasOptions) => {
  if (!items.length) {
    return [];
  }

  const prepared = await Promise.all(items.map(prepareImage));
  const sceneElements = excalidrawAPI.getSceneElements();
  const appState = excalidrawAPI.getAppState();
  const origin = getManyMindsGridOrigin({
    sceneElements,
    selectedElements: getSelectedElements(sceneElements, appState),
    sourceElementIds,
    appState,
  });
  const columns = getManyMindsGridColumnCount(prepared.length);
  const columnWidths = Array.from({ length: columns }, () => 0);
  const rowCount = Math.ceil(prepared.length / columns);
  const rowHeights = Array.from({ length: rowCount }, () => 0);

  prepared.forEach((image, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    columnWidths[column] = Math.max(columnWidths[column], image.width);
    rowHeights[row] = Math.max(rowHeights[row], image.height);
  });

  const columnOffsets = getOffsets(columnWidths);
  const rowOffsets = getOffsets(rowHeights);
  const insertedElements = prepared.map((image, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);

    return newImageElement({
      type: "image",
      x: origin.x + columnOffsets[column],
      y: origin.y + rowOffsets[row],
      width: image.width,
      height: image.height,
      status: "saved",
      fileId: image.file.id,
      customData: {
        manyMinds: image.relation,
      },
    }) as NonDeleted<InitializedExcalidrawImageElement>;
  });
  const nextElements = [...sceneElements, ...insertedElements];

  syncInvalidIndices(nextElements);
  excalidrawAPI.addFiles(prepared.map((image) => image.file));
  excalidrawAPI.updateScene({
    elements: nextElements,
    appState: {
      selectedElementIds: Object.fromEntries(
        insertedElements.map((element) => [element.id, true]),
      ),
    },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });

  return insertedElements;
};

/** Semantic alias used by the "insert all" batch action. */
export const insertManyMindsGroupIntoCanvas = insertManyMindsTasksIntoCanvas;

/**
 * Replaces the source image payload while preserving its position, size, crop,
 * bindings, index, and all other geometry. The immediate capture is required
 * so the replacement can be undone through normal Excalidraw history.
 */
export const replaceManyMindsSourceImage = async ({
  excalidrawAPI,
  item,
  sourceElementId,
}: ReplaceManyMindsImageOptions) => {
  const prepared = await prepareImage(item);
  const sceneElements = excalidrawAPI.getSceneElements();
  const source = sceneElements.find(
    (element) => element.id === sourceElementId && !element.isDeleted,
  );

  if (!source || !isInitializedImageElement(source)) {
    throw new Error("Many Minds can only replace an available image element.");
  }

  const replacement = newElementWith(source, {
    fileId: prepared.file.id,
    status: "saved",
    customData: {
      ...source.customData,
      manyMinds: prepared.relation,
    },
  });
  const nextElements = sceneElements.map((element) =>
    element.id === source.id ? replacement : element,
  );

  excalidrawAPI.addFiles([prepared.file]);
  excalidrawAPI.updateScene({
    elements: nextElements,
    appState: {
      selectedElementIds: { [replacement.id]: true },
    },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });

  return replacement;
};

export const getManyMindsGridColumnCount = (count: number) => {
  if (count <= 1) {
    return 1;
  }
  if (count <= 4) {
    return 2;
  }
  return 3;
};

export const sanitizeManyMindsPortableRelation = (
  relation: ManyMindsPortableRelation,
): ManyMindsPortableRelation => {
  const candidate = relation as unknown as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  const safeStringFields = [
    "batchId",
    "taskId",
    "parentTaskId",
    "perspectiveId",
    "outputAssetId",
  ];

  for (const field of safeStringFields) {
    const value = candidate[field];
    if (typeof value === "string" && !looksSensitive(value)) {
      sanitized[field] = value.slice(0, 600);
    }
  }
  if (typeof candidate.version === "number") {
    sanitized.version = candidate.version;
  }
  if (Array.isArray(candidate.inputAssetIds)) {
    sanitized.inputAssetIds = candidate.inputAssetIds
      .filter((value): value is string => typeof value === "string")
      .slice(0, 64)
      .map((value) => value.slice(0, 200));
  }

  return sanitized as unknown as ManyMindsPortableRelation;
};

const prepareImage = async ({
  asset,
  relation,
}: ManyMindsCanvasItem): Promise<PreparedImage> => {
  const dataURL =
    asset.dataURL || (asset.blob && (await getDataURL(asset.blob)));
  if (!dataURL || !dataURL.startsWith("data:image/")) {
    throw new Error("Many Minds output asset is unavailable.");
  }

  const mimeType =
    asset.mimeType || asset.blob?.type || readMimeType(dataURL) || "image/png";
  const file = dataURLToFile(dataURL as DataURL, mimeType);
  const fileId = await generateIdFromFile(file);
  const intrinsic =
    asset.width && asset.height
      ? { width: asset.width, height: asset.height }
      : await getImageDimensions(dataURL as DataURL);
  const dimensions = fitDimensions(intrinsic);

  return {
    file: {
      id: fileId,
      dataURL: dataURL as DataURL,
      mimeType: mimeType as BinaryFileData["mimeType"],
      created: Date.now(),
      lastRetrieved: Date.now(),
    },
    ...dimensions,
    relation: sanitizeManyMindsPortableRelation(relation),
  };
};

const getManyMindsGridOrigin = ({
  sceneElements,
  selectedElements,
  sourceElementIds,
  appState,
}: {
  sceneElements: readonly ExcalidrawElement[];
  selectedElements: readonly ExcalidrawElement[];
  sourceElementIds: readonly string[];
  appState: ReturnType<ExcalidrawImperativeAPI["getAppState"]>;
}) => {
  const visibleElements = sceneElements.filter((element) => !element.isDeleted);
  const sourceIds = new Set(sourceElementIds);
  const sourceElements = visibleElements.filter((element) =>
    sourceIds.has(element.id),
  );
  const verticalAnchor = sourceElements.length
    ? sourceElements
    : selectedElements.length
    ? selectedElements
    : visibleElements;

  if (visibleElements.length) {
    const [, fallbackY, sceneMaxX] = getCommonBounds(visibleElements);
    const [, anchorY] = verticalAnchor.length
      ? getCommonBounds(verticalAnchor)
      : [0, fallbackY, 0, 0];
    return { x: sceneMaxX + GRID_INSERT_GAP, y: anchorY };
  }

  const [minX, minY, maxX] = getVisibleSceneBounds(appState);
  return {
    x: minX + (maxX - minX) / 2,
    y: minY + GRID_INSERT_GAP,
  };
};

const getOffsets = (sizes: readonly number[]) => {
  const offsets: number[] = [];
  let current = 0;
  for (const size of sizes) {
    offsets.push(current);
    current += size + GRID_GAP;
  }
  return offsets;
};

const getImageDimensions = (dataURL: DataURL) =>
  new Promise<{ width: number; height: number }>((resolve) => {
    const image = new Image();
    image.onload = () =>
      resolve({
        width: image.naturalWidth || image.width || MAX_PREVIEW_SIZE,
        height: image.naturalHeight || image.height || MAX_PREVIEW_SIZE,
      });
    image.onerror = () =>
      resolve({ width: MAX_PREVIEW_SIZE, height: MAX_PREVIEW_SIZE });
    image.src = dataURL;
  });

const fitDimensions = ({
  width,
  height,
}: {
  width: number;
  height: number;
}) => {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const scale = Math.min(1, MAX_PREVIEW_SIZE / Math.max(safeWidth, safeHeight));
  return {
    width: Math.round(safeWidth * scale),
    height: Math.round(safeHeight * scale),
  };
};

const dataURLToFile = (dataURL: DataURL, mimeType: string) => {
  const [metadata, encoded = ""] = dataURL.split(",", 2);
  const binary = metadata.includes(";base64")
    ? atob(encoded)
    : decodeURIComponent(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], `many-minds-output.${extensionFor(mimeType)}`, {
    type: mimeType,
  });
};

const readMimeType = (dataURL: string) =>
  dataURL.match(/^data:([^;,]+)/)?.[1] || undefined;

const extensionFor = (mimeType: string) => {
  if (mimeType === "image/jpeg") {
    return "jpg";
  }
  if (mimeType === "image/webp") {
    return "webp";
  }
  return "png";
};

const looksSensitive = (value: string) =>
  /(?:api[-_ ]?key|authorization|bearer\s+|token\s*[:=]|https?:\/\/)/i.test(
    value,
  );
