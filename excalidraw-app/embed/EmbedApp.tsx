import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  Excalidraw,
  MainMenu,
  MIME_TYPES,
  exportToBlob,
  exportToSvg,
  serializeAsJSON,
} from "@excalidraw/excalidraw";

import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/element/types";

import { useAtom } from "../app-jotai";
import Collab, { collabAPIAtom, isCollaboratingAtom } from "../collab/Collab";

import {
  DEFAULT_EMBED_CAPABILITIES,
  EMBED_MAX_COMMAND_BYTES,
  EMBED_MAX_RESPONSE_BYTES,
  createEmbedErrorResponse,
  createEmbedEvent,
  createEmbedSuccessResponse,
  getEmbedMessageByteSize,
  isEmbedProtocolMessage,
  type EmbedCommandMessage,
  type EmbedCommandPayloadMap,
  type EmbedErrorCode,
  type EmbedEventName,
  type EmbedEventPayloadMap,
  type EmbedMode,
  type EmbedProtocolError,
  type EmbedUIPreset,
} from "./protocol";
import { loadEmbedSource, type EmbedRoomLinkData } from "./sceneLoader";

class EmbedCommandError extends Error {
  constructor(public readonly code: EmbedErrorCode, message: string) {
    super(message);
    this.name = "EmbedCommandError";
  }
}

const toProtocolError = (error: unknown): EmbedProtocolError => {
  if (error instanceof EmbedCommandError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { code: "INTERNAL_ERROR", message: error.message };
  }
  return { code: "INTERNAL_ERROR", message: "Unknown embed error" };
};

const toDataURL = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

const query = new URLSearchParams(window.location.search);
const initialMode: EmbedMode = query.get("mode") === "edit" ? "edit" : "view";
const initialPreset: EmbedUIPreset =
  query.get("preset") === "compact" || query.get("preset") === "presentation"
    ? (query.get("preset") as EmbedUIPreset)
    : "full";
const initialLangCode = query.get("lang") ?? undefined;

export const EmbedApp = () => {
  const instanceId = query.get("instanceId") ?? "embed";
  const parentOrigin = query.get("parentOrigin") ?? "";
  const messageTarget =
    window.parent !== window ? window.parent : window.opener ?? null;
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const maximumMode: EmbedMode =
    initialPreset === "presentation" ? "view" : initialMode;
  const [mode, setMode] = useState(maximumMode);
  const [collabAPI] = useAtom(collabAPIAtom);
  const [isCollaborating] = useAtom(isCollaboratingAtom);
  const [pendingRoom, setPendingRoom] = useState<EmbedRoomLinkData | null>(
    null,
  );
  const subscriptions = useRef(new Set<EmbedEventName>());
  const revision = useRef(0);
  const lastSelection = useRef("");
  const sceneChangeTimer = useRef<number | null>(null);
  const pendingElementCount = useRef(0);

  const post = useCallback(
    (message: unknown) => {
      if (
        parentOrigin &&
        getEmbedMessageByteSize(message) <= EMBED_MAX_RESPONSE_BYTES
      ) {
        messageTarget?.postMessage(message, parentOrigin);
      }
    },
    [messageTarget, parentOrigin],
  );

  const emit = useCallback(
    <Name extends EmbedEventName>(
      name: Name,
      payload: EmbedEventPayloadMap[Name],
      force = false,
    ) => {
      if (!force && !subscriptions.current.has(name)) {
        return;
      }
      post(
        createEmbedEvent({
          instanceId,
          requestId: `event:${Date.now()}`,
          name,
          payload,
        }),
      );
    },
    [instanceId, post],
  );

  useEffect(() => {
    if (api && pendingRoom && collabAPI) {
      void collabAPI
        .startCollaboration(pendingRoom)
        .then(() => setPendingRoom(null));
    }
  }, [api, collabAPI, pendingRoom]);

  const execute = useCallback(
    async (message: EmbedCommandMessage) => {
      if (!api) {
        throw new EmbedCommandError("INTERNAL_ERROR", "Editor is not ready");
      }
      switch (message.name) {
        case "loadScene": {
          const payload =
            message.payload as EmbedCommandPayloadMap["loadScene"];
          const loaded = await loadEmbedSource(payload.source);
          if (collabAPI?.isCollaborating()) {
            collabAPI.stopCollaboration(false);
          }
          if (loaded.room) {
            setPendingRoom(loaded.room);
          } else {
            api.updateScene({
              elements: loaded.scene.elements,
              appState: loaded.scene.appState
                ? ({
                    ...api.getAppState(),
                    ...loaded.scene.appState,
                  } as AppState)
                : undefined,
              captureUpdate: "NEVER",
            });
            if (loaded.scene.files) {
              api.addFiles(Object.values(loaded.scene.files));
            }
          }
          return { loaded: true };
        }
        case "setMode":
          if (
            (message.payload as EmbedCommandPayloadMap["setMode"]).mode ===
              "edit" &&
            maximumMode !== "edit"
          ) {
            throw new EmbedCommandError(
              "READ_ONLY",
              "This embed instance is read-only",
            );
          }
          setMode((message.payload as EmbedCommandPayloadMap["setMode"]).mode);
          return {
            mode: (message.payload as EmbedCommandPayloadMap["setMode"]).mode,
          };
        case "scrollToContent":
          api.scrollToContent(
            undefined,
            message.payload as EmbedCommandPayloadMap["scrollToContent"],
          );
          return { scrolled: true };
        case "scrollToElement": {
          const payload =
            message.payload as EmbedCommandPayloadMap["scrollToElement"];
          const exists = api
            .getSceneElements()
            .some((element) => element.id === payload.elementId);
          if (!exists) {
            throw new EmbedCommandError("NOT_FOUND", "Element not found");
          }
          api.scrollToContent(payload.elementId, payload);
          return { scrolled: true };
        }
        case "getScene":
          return {
            scene: {
              elements: api.getSceneElements(),
              appState: api.getAppState(),
              files: api.getFiles(),
            },
          };
        case "export": {
          const payload = message.payload as EmbedCommandPayloadMap["export"];
          const elements = api.getSceneElements();
          const appState = {
            ...api.getAppState(),
            exportBackground:
              payload.exportBackground ?? api.getAppState().exportBackground,
            exportScale: payload.exportScale ?? api.getAppState().exportScale,
          };
          const files = api.getFiles();
          if (payload.format === "json") {
            return {
              format: "json",
              mimeType: MIME_TYPES.excalidraw,
              data: serializeAsJSON(elements, appState, files, "local"),
            };
          }
          if (payload.format === "svg") {
            const svg = await exportToSvg({
              elements,
              appState,
              files,
              exportPadding: payload.exportPadding,
            });
            return {
              format: "svg",
              mimeType: MIME_TYPES.svg,
              data: new XMLSerializer().serializeToString(svg),
            };
          }
          const blob = await exportToBlob({
            elements,
            appState,
            files,
            mimeType: MIME_TYPES.png,
            exportPadding: payload.exportPadding,
          });
          return {
            format: "png",
            mimeType: MIME_TYPES.png,
            data: await toDataURL(blob),
          };
        }
        case "subscribe":
          (
            message.payload as EmbedCommandPayloadMap["subscribe"]
          ).events.forEach((event) => subscriptions.current.add(event));
          return { events: [...subscriptions.current] };
        case "unsubscribe":
          (
            message.payload as EmbedCommandPayloadMap["unsubscribe"]
          ).events.forEach((event) => subscriptions.current.delete(event));
          return { events: [...subscriptions.current] };
        default:
          throw new EmbedCommandError(
            "UNSUPPORTED_COMMAND",
            "Unsupported command",
          );
      }
    },
    [api, collabAPI, maximumMode],
  );

  useEffect(() => {
    if (!api || !parentOrigin) {
      return;
    }
    const onMessage = (event: MessageEvent) => {
      if (
        event.source !== messageTarget ||
        event.origin !== parentOrigin ||
        !isEmbedProtocolMessage(event.data) ||
        event.data.kind !== "command" ||
        event.data.instanceId !== instanceId
      ) {
        return;
      }
      const message = event.data;
      if (getEmbedMessageByteSize(message) > EMBED_MAX_COMMAND_BYTES) {
        return;
      }
      void execute(message)
        .then((payload) =>
          post(
            createEmbedSuccessResponse({
              instanceId,
              requestId: message.requestId,
              name: message.name,
              payload: payload as never,
            }),
          ),
        )
        .catch((error: unknown) =>
          post(
            createEmbedErrorResponse({
              instanceId,
              requestId: message.requestId,
              name: message.name,
              error: toProtocolError(error),
            }),
          ),
        );
    };
    window.addEventListener("message", onMessage);
    emit(
      "ready",
      { mode, preset: initialPreset, capabilities: DEFAULT_EMBED_CAPABILITIES },
      true,
    );
    return () => window.removeEventListener("message", onMessage);
  }, [api, emit, execute, instanceId, messageTarget, mode, parentOrigin, post]);

  useEffect(
    () => () => {
      if (sceneChangeTimer.current !== null) {
        window.clearTimeout(sceneChangeTimer.current);
      }
    },
    [],
  );

  const onChange = useCallback(
    (
      elements: readonly OrderedExcalidrawElement[],
      appState: AppState,
      _files: BinaryFiles,
    ) => {
      revision.current += 1;
      pendingElementCount.current = elements.filter(
        (element) => !element.isDeleted,
      ).length;
      if (sceneChangeTimer.current === null) {
        sceneChangeTimer.current = window.setTimeout(() => {
          sceneChangeTimer.current = null;
          emit("sceneChange", {
            revision: revision.current,
            elementCount: pendingElementCount.current,
          });
        }, 100);
      }
      const selection = Object.keys(appState.selectedElementIds).sort();
      const key = selection.join("\0");
      if (key !== lastSelection.current) {
        lastSelection.current = key;
        emit("selectionChange", { selectedElementIds: selection });
      }
    },
    [emit],
  );

  const uiOptions = useMemo(
    () => ({
      canvasActions:
        initialPreset === "full"
          ? {}
          : {
              loadScene: false,
              export: false as const,
              saveAsImage: false,
              clearCanvas: false,
              saveToActiveFile: false,
            },
    }),
    [],
  );

  return (
    <div
      className={`embed-app embed-app--${initialPreset}`}
      style={{ width: "100vw", height: "100vh" }}
    >
      <Excalidraw
        onExcalidrawAPI={setApi}
        langCode={initialLangCode}
        onChange={onChange}
        viewModeEnabled={mode === "view"}
        zenModeEnabled={initialPreset !== "full"}
        UIOptions={uiOptions}
        aiEnabled={false}
        isCollaborating={isCollaborating}
        onPointerUpdate={collabAPI?.onPointerUpdate}
      >
        {initialPreset === "full" && (
          <MainMenu>
            <MainMenu.DefaultItems.LoadScene />
            <MainMenu.DefaultItems.Export />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.Separator />
            <MainMenu.DefaultItems.ToggleTheme allowSystemTheme={false} />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
          </MainMenu>
        )}
      </Excalidraw>
      {api && <Collab excalidrawAPI={api} />}
    </div>
  );
};

export default EmbedApp;
