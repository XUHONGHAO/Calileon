import {
  loadFromBlob,
  restoreAppState,
  restoreElements,
} from "@excalidraw/excalidraw";

import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

import { importFromBackend } from "../data";
import { getCloudBackend, shareLink } from "../data/cloud";
import {
  loadAssetRefsForElements,
  loadEncryptedAssetRefsForElements,
} from "../data/cloud/cloudAssets";
import { getCloudShareAccessFromUrl } from "../data/cloud/cloudShareLinks";
import { isEncryptedScenePayloadV1 } from "../data/cloud/CloudEncryptionService";
import { isSingleFilePayload } from "../single-file/payload";
import { SINGLE_FILE_PAYLOAD_SCRIPT_ID } from "../single-file/types";

import type { EmbedContentSource, EmbedSceneData } from "./protocol";

export type EmbedRoomLinkData = {
  roomId: string;
  roomKey: string;
};

export type LoadedEmbedSource = {
  scene: ExcalidrawInitialDataState;
  room?: EmbedRoomLinkData;
};

const normalizeScene = (scene: EmbedSceneData): ExcalidrawInitialDataState => ({
  elements: restoreElements(scene.elements as any, null, {
    repairBindings: true,
    deleteInvisibleElements: true,
  }),
  appState: restoreAppState(scene.appState as any, null),
  files: (scene.files ?? {}) as ExcalidrawInitialDataState["files"],
});

const loadP1Payload = async (payload: unknown): Promise<LoadedEmbedSource> => {
  let candidate = payload;
  if (typeof payload === "string") {
    const response = await fetch(payload);
    if (!response.ok) {
      throw new Error(`Unable to load P1 document (${response.status})`);
    }
    const text = await response.text();
    if (text.trimStart().startsWith("{")) {
      candidate = JSON.parse(text);
    } else {
      const document = new DOMParser().parseFromString(text, "text/html");
      const node = document.getElementById(SINGLE_FILE_PAYLOAD_SCRIPT_ID);
      candidate = node?.textContent ? JSON.parse(node.textContent) : null;
    }
  }
  if (!isSingleFilePayload(candidate)) {
    throw new Error("Invalid P1 single-file payload");
  }
  return { scene: normalizeScene(candidate.scene) };
};

const loadShareUrl = async (urlString: string): Promise<LoadedEmbedSource> => {
  const url = new URL(urlString, window.location.href);
  const room = shareLink.getCollaborationLinkData(url.toString());
  if (room) {
    return {
      scene: {},
      room: { roomId: room.roomId, roomKey: room.roomKey },
    };
  }

  const cloudShare = getCloudShareAccessFromUrl(url.toString());
  if (cloudShare) {
    const backend = getCloudBackend();
    const shared = await backend.shares.loadScene(cloudShare.token);
    let payload = shared.scene.payload as EmbedSceneData;
    let encryptionKey: string | null = null;
    if (shared.scene.payloadKind === "encrypted") {
      if (!isEncryptedScenePayloadV1(shared.scene.payload)) {
        throw new Error("Invalid encrypted shared scene");
      }
      encryptionKey =
        cloudShare.key ??
        (shared.scene.id
          ? backend.encryption.getKey(shared.scene.id)?.key ?? null
          : null);
      if (!encryptionKey) {
        throw new Error("The shared scene encryption key is missing");
      }
      payload = (await backend.encryption.decryptScenePayload(
        shared.scene.payload,
        encryptionKey,
      )) as EmbedSceneData;
    }
    const elements = restoreElements(payload.elements as any, null, {
      repairBindings: true,
      deleteInvisibleElements: true,
    });
    const assetResult = encryptionKey
      ? await loadEncryptedAssetRefsForElements({
          backend,
          assets: shared.assets,
          elements,
          encryptionKey,
        })
      : await loadAssetRefsForElements({
          assets: shared.assets,
          elements,
        });
    const files = assetResult.loadedFiles.reduce((result, file) => {
      result[file.id] = file;
      return result;
    }, {} as BinaryFiles);
    return {
      scene: {
        elements,
        appState: restoreAppState(payload.appState as any, null),
        files,
      },
    };
  }

  const legacy = url.hash.match(/^#json=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)$/);
  if (legacy) {
    const imported = await importFromBackend(legacy[1], legacy[2]);
    return {
      scene: normalizeScene({
        elements: imported.elements ?? undefined,
        appState: imported.appState as Record<string, unknown> | undefined,
        files: imported.files as Record<string, unknown> | undefined,
      }),
    };
  }

  const external = url.hash.match(/^#url=(.*)$/);
  if (external) {
    const response = await fetch(window.decodeURIComponent(external[1]));
    if (!response.ok) {
      throw new Error(`Unable to load shared scene (${response.status})`);
    }
    return { scene: await loadFromBlob(await response.blob(), null, null) };
  }

  throw new Error("Unsupported share URL");
};

export const loadEmbedSource = async (
  source: EmbedContentSource,
): Promise<LoadedEmbedSource> => {
  if (source.type === "scene") {
    return { scene: normalizeScene(source.scene) };
  }
  if (source.type === "p1") {
    return loadP1Payload(source.payload);
  }
  return loadShareUrl(source.url);
};
