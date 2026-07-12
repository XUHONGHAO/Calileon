import {
  sceneCoordsToViewportCoords,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import {
  isInitializedImageElement,
  newFreeDrawElement,
} from "@excalidraw/element";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { pointFrom } from "@excalidraw/math";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  ExcalidrawFreeDrawElement,
  ExcalidrawImageElement,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type { LocalPoint, Radians } from "@excalidraw/math";

import {
  DEFAULT_MASK_BRUSH_SIZE,
  exportMaskAsFile,
  generateMaskPreview,
  getMaskPreviewCanvasSize,
} from "../ai/maskCanvas";
import {
  appendAIMaskStrokePoint,
  beginAIMaskStroke,
  createAIMaskSession,
  endAIMaskStroke,
  redoAIMaskSession,
  undoAIMaskSession,
} from "../ai/maskSession";
import {
  createMaskSourceGeometryV2,
  getMaskGeometryStrokeScale,
  isValidMaskSourceGeometry,
  legacyDisplayPointToScenePoint,
  normalizedNaturalPointToScenePoint,
  scenePointToLegacyDisplayPoint,
  scenePointToNormalizedNaturalPoint,
} from "../ai/maskGeometry";
import { createMaskViewportGeometry } from "../ai/maskViewportGeometry";

import { AIMaskEditingOverlay } from "./AIMaskEditingOverlay";

import type { AIMaskEditingState, AIMaskReadyPayload } from "../ai/types";
import type { AIMaskSourceGeometry } from "../ai/maskGeometry";

import type { AIMaskEditingTargetBounds } from "./AIMaskEditingOverlay";

const EMPTY_AI_MASK_EDITING_STATE: AIMaskEditingState = {
  mode: null,
  targetImageId: null,
  maskElementIds: [],
  previousState: null,
};

export type AIMaskEditingControllerHandle = {
  requestEnterMaskEditing: (
    imageId: string,
    maskElements?: readonly ExcalidrawFreeDrawElement[],
  ) => void;
};

type AIMaskEditingControllerProps = {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  onMaskReady?: (payload: AIMaskReadyPayload) => void;
};

type PendingMaskEditingRequest = {
  imageId: string;
  maskElements: readonly ExcalidrawFreeDrawElement[];
};

export const AIMaskEditingController = forwardRef<
  AIMaskEditingControllerHandle,
  AIMaskEditingControllerProps
>(({ excalidrawAPI, onMaskReady }, ref) => {
  const [aiMaskEditingState, setAIMaskEditingState] =
    useState<AIMaskEditingState>(EMPTY_AI_MASK_EDITING_STATE);
  const [pendingMaskEditingRequest, setPendingMaskEditingRequest] =
    useState<PendingMaskEditingRequest | null>(null);
  const [aiMaskTargetBounds, setAIMaskTargetBounds] =
    useState<AIMaskEditingTargetBounds | null>(null);
  const [maskEditingZoomValue, setMaskEditingZoomValue] = useState(1);
  const [isMaskErasing, setIsMaskErasing] = useState(false);
  const [maskBrushSize, setMaskBrushSize] = useState(DEFAULT_MASK_BRUSH_SIZE);
  const [maskPreviewDataURL, setMaskPreviewDataURL] = useState<string | null>(
    null,
  );
  const [maskSession, setMaskSession] = useState(createAIMaskSession);
  const maskSessionElementsRef = useRef(maskSession.elements);
  const [isCompletingMask, setIsCompletingMask] = useState(false);
  const isCompletingMaskRef = useRef(false);
  const exitMaskEditingRef = useRef<(cancelled: boolean) => void>(() => {});
  const mountedRef = useRef(true);
  const maskSessionTokenRef = useRef(0);
  const maskExportControllerRef = useRef<AbortController | null>(null);
  const activeTargetImageIdRef = useRef<string | null>(null);
  const activeTargetGeometrySignatureRef = useRef<string | null>(null);
  maskSessionElementsRef.current = maskSession.elements;
  activeTargetImageIdRef.current = aiMaskEditingState.targetImageId;

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      maskSessionTokenRef.current += 1;
      maskExportControllerRef.current?.abort();
      maskExportControllerRef.current = null;
      activeTargetGeometrySignatureRef.current = null;
    };
  }, []);

  const getMaskTargetViewportBounds = useCallback(
    (targetImageId: string): AIMaskEditingTargetBounds | null => {
      if (!excalidrawAPI) {
        return null;
      }

      const targetImage = excalidrawAPI
        .getSceneElements()
        .find((element) => element.id === targetImageId);

      if (!targetImage || !isInitializedImageElement(targetImage)) {
        return null;
      }

      const appState = excalidrawAPI.getAppState();
      const center = sceneCoordsToViewportCoords(
        {
          sceneX: targetImage.x + targetImage.width / 2,
          sceneY: targetImage.y + targetImage.height / 2,
        },
        appState,
      );

      return createMaskViewportGeometry({
        centerX: center.x,
        centerY: center.y,
        width: Math.abs(targetImage.width) * appState.zoom.value,
        height: Math.abs(targetImage.height) * appState.zoom.value,
        angle: targetImage.angle,
      });
    },
    [excalidrawAPI],
  );

  const enterMaskEditing = useCallback(
    (
      imageId: string,
      existingMaskElements: readonly ExcalidrawFreeDrawElement[] = [],
    ) => {
      if (!excalidrawAPI) {
        return;
      }

      const sceneElements = excalidrawAPI.getSceneElements();
      const targetImage = sceneElements.find(
        (element) => element.id === imageId,
      );

      if (!targetImage || !isInitializedImageElement(targetImage)) {
        excalidrawAPI.setToast({
          message: "Select a saved image before editing a mask.",
        });
        return;
      }

      const appState = excalidrawAPI.getAppState();

      const editableMaskElements = cloneMaskElementsForEditing(
        existingMaskElements,
        targetImage,
      );
      const editableMaskElementIds = editableMaskElements.map(
        (element) => element.id,
      );

      const nextMaskEditingState: AIMaskEditingState = {
        mode: "editing",
        targetImageId: imageId,
        maskElementIds: editableMaskElementIds,
        previousState: {
          selectedElementIds: { ...appState.selectedElementIds },
          scrollX: appState.scrollX,
          scrollY: appState.scrollY,
          zoom: { ...appState.zoom },
          activeTool: { ...appState.activeTool },
          currentItemStrokeColor: appState.currentItemStrokeColor,
          currentItemBackgroundColor: appState.currentItemBackgroundColor,
          currentItemStrokeWidth: appState.currentItemStrokeWidth,
          currentItemStrokeStyle: appState.currentItemStrokeStyle,
          currentItemRoughness: appState.currentItemRoughness,
          currentItemOpacity: appState.currentItemOpacity,
        },
      };

      maskSessionTokenRef.current += 1;
      activeTargetGeometrySignatureRef.current =
        getMaskTargetGeometrySignature(targetImage);
      maskExportControllerRef.current?.abort();
      maskExportControllerRef.current = null;
      setMaskSession(createAIMaskSession(editableMaskElements));
      setIsMaskErasing(false);
      setMaskBrushSize(DEFAULT_MASK_BRUSH_SIZE);
      setIsCompletingMask(false);
      isCompletingMaskRef.current = false;
      setAIMaskEditingState(nextMaskEditingState);
      setAIMaskTargetBounds(getMaskTargetViewportBounds(imageId));
      setMaskEditingZoomValue(appState.zoom.value);
    },
    [excalidrawAPI, getMaskTargetViewportBounds],
  );

  const requestEnterMaskEditing = useCallback(
    (
      imageId: string,
      maskElements: readonly ExcalidrawFreeDrawElement[] = [],
    ) => {
      setPendingMaskEditingRequest({ imageId, maskElements });
    },
    [],
  );

  useImperativeHandle(
    ref,
    () => ({
      requestEnterMaskEditing,
    }),
    [requestEnterMaskEditing],
  );

  useEffect(() => {
    if (!pendingMaskEditingRequest) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      enterMaskEditing(
        pendingMaskEditingRequest.imageId,
        pendingMaskEditingRequest.maskElements,
      );
      setPendingMaskEditingRequest(null);
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [enterMaskEditing, pendingMaskEditingRequest]);

  useEffect(() => {
    if (aiMaskEditingState.mode !== "editing") {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const isControlTarget = isMaskEditingControlTarget(event.target);

      if (key === "escape") {
        event.preventDefault();
        event.stopPropagation();
        exitMaskEditingRef.current(true);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && !event.altKey && key === "z") {
        event.preventDefault();
        event.stopPropagation();
        setMaskSession((current) =>
          event.shiftKey
            ? redoAIMaskSession(current)
            : undoAIMaskSession(current),
        );
        return;
      }

      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        key === "y"
      ) {
        event.preventDefault();
        event.stopPropagation();
        setMaskSession(redoAIMaskSession);
        return;
      }

      if (
        key === "e" &&
        !isControlTarget &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        setIsMaskErasing((current) => !current);
        return;
      }

      if (isControlTarget) {
        if (key === "tab") {
          event.preventDefault();
          event.stopPropagation();
          moveMaskEditingFocus(event.shiftKey);
          return;
        }

        if (
          key === "enter" ||
          key === " " ||
          (isMaskEditingRangeTarget(event.target) &&
            MASK_EDITING_RANGE_KEYS.has(key))
        ) {
          event.stopPropagation();
          return;
        }

        if (MASK_EDITING_BLOCKED_EDITOR_KEYS.has(key)) {
          event.preventDefault();
        }
        event.stopPropagation();
        return;
      }

      if (key === "tab") {
        event.preventDefault();
        event.stopPropagation();
        moveMaskEditingFocus(event.shiftKey);
        return;
      }

      if (event.ctrlKey || event.metaKey || event.altKey) {
        event.stopPropagation();
        return;
      }

      if (MASK_EDITING_BLOCKED_EDITOR_KEYS.has(key)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [aiMaskEditingState.mode]);

  const exitMaskEditing = useCallback(
    (_cancelled: boolean) => {
      if (
        !excalidrawAPI ||
        aiMaskEditingState.mode !== "editing" ||
        !aiMaskEditingState.previousState
      ) {
        return;
      }

      setAIMaskEditingState(EMPTY_AI_MASK_EDITING_STATE);
      setMaskSession(createAIMaskSession());
      setAIMaskTargetBounds(null);
      setMaskEditingZoomValue(1);
      setIsMaskErasing(false);
      setMaskBrushSize(DEFAULT_MASK_BRUSH_SIZE);
      setMaskPreviewDataURL(null);
      setIsCompletingMask(false);
      isCompletingMaskRef.current = false;
      maskSessionTokenRef.current += 1;
      maskExportControllerRef.current?.abort();
      maskExportControllerRef.current = null;
      activeTargetGeometrySignatureRef.current = null;
    },
    [aiMaskEditingState, excalidrawAPI],
  );

  exitMaskEditingRef.current = exitMaskEditing;

  const handleMaskEditingDone = useCallback(async () => {
    if (
      !excalidrawAPI ||
      aiMaskEditingState.mode !== "editing" ||
      !aiMaskEditingState.targetImageId ||
      isCompletingMaskRef.current
    ) {
      return;
    }

    isCompletingMaskRef.current = true;
    setIsCompletingMask(true);
    const sessionToken = maskSessionTokenRef.current;
    const targetImageId = aiMaskEditingState.targetImageId;
    const exportController = new AbortController();
    maskExportControllerRef.current?.abort();
    maskExportControllerRef.current = exportController;

    const currentElements = excalidrawAPI.getSceneElements();
    const targetImage = currentElements.find(
      (element) => element.id === targetImageId,
    );

    if (!targetImage || !isInitializedImageElement(targetImage)) {
      excalidrawAPI.setToast({
        message: "The selected image is no longer available.",
      });
      isCompletingMaskRef.current = false;
      setIsCompletingMask(false);
      exitMaskEditing(true);
      return;
    }

    try {
      const maskFile = await exportMaskAsFile(
        targetImage,
        maskSession.elements,
        excalidrawAPI.getFiles(),
        exportController.signal,
      );
      const currentTargetImage = excalidrawAPI
        .getSceneElements()
        .find((element) => element.id === targetImageId);

      if (
        exportController.signal.aborted ||
        !mountedRef.current ||
        maskSessionTokenRef.current !== sessionToken ||
        activeTargetImageIdRef.current !== targetImageId ||
        !currentTargetImage ||
        !isInitializedImageElement(currentTargetImage) ||
        currentTargetImage.fileId !== targetImage.fileId
      ) {
        return;
      }
      const boundMaskElements = bindMaskElementsToImage(
        maskSession.elements,
        currentTargetImage,
      );

      onMaskReady?.({
        imageId: currentTargetImage.id,
        maskFile,
        maskElements: boundMaskElements,
      });

      exitMaskEditing(false);
    } catch (error) {
      if (
        exportController.signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        return;
      }
      console.error("AI mask export failed", error);
      if (
        mountedRef.current &&
        maskSessionTokenRef.current === sessionToken &&
        activeTargetImageIdRef.current === targetImageId
      ) {
        isCompletingMaskRef.current = false;
        setIsCompletingMask(false);
      }
    } finally {
      if (maskExportControllerRef.current === exportController) {
        maskExportControllerRef.current = null;
      }
    }
  }, [
    aiMaskEditingState,
    excalidrawAPI,
    exitMaskEditing,
    maskSession.elements,
    onMaskReady,
  ]);

  useEffect(() => {
    const targetImageId = aiMaskEditingState.targetImageId;

    if (
      !excalidrawAPI ||
      aiMaskEditingState.mode !== "editing" ||
      !targetImageId
    ) {
      return;
    }

    const syncMaskTargetViewportState = () => {
      setAIMaskTargetBounds(getMaskTargetViewportBounds(targetImageId));
      setMaskEditingZoomValue(excalidrawAPI.getAppState().zoom.value);
    };

    const syncMaskEditingState = (
      elements:
        | readonly ExcalidrawElement[]
        | readonly OrderedExcalidrawElement[] = excalidrawAPI.getSceneElements(),
    ) => {
      syncMaskTargetViewportState();

      let targetImage: ExcalidrawElement | OrderedExcalidrawElement | null =
        null;

      for (const element of elements) {
        if (element.id === targetImageId) {
          targetImage = element;
        }
      }

      if (!targetImage || !isInitializedImageElement(targetImage)) {
        exitMaskEditingRef.current(true);
        return;
      }

      if (
        activeTargetGeometrySignatureRef.current !==
        getMaskTargetGeometrySignature(targetImage)
      ) {
        exitMaskEditingRef.current(true);
        return;
      }

      setMaskPreviewDataURL(
        generateMaskPreview(
          targetImage,
          maskSessionElementsRef.current,
          undefined,
          getMaskPreviewCanvasSize(targetImage),
        ),
      );

      setAIMaskEditingState((current) => {
        const nextMaskElementIds = maskSessionElementsRef.current.map(
          (element) => element.id,
        );
        if (areStringArraysEqual(current.maskElementIds, nextMaskElementIds)) {
          return current;
        }

        return {
          ...current,
          maskElementIds: nextMaskElementIds,
        };
      });
    };

    syncMaskEditingState();

    const unsubscribeChange = excalidrawAPI.onChange((elements) => {
      syncMaskEditingState(elements);
    });
    const unsubscribeScroll = excalidrawAPI.onScrollChange(() => {
      syncMaskTargetViewportState();
    });

    return () => {
      unsubscribeChange();
      unsubscribeScroll();
    };
  }, [
    aiMaskEditingState.mode,
    aiMaskEditingState.targetImageId,
    excalidrawAPI,
    getMaskTargetViewportBounds,
  ]);

  useEffect(() => {
    const targetImageId = aiMaskEditingState.targetImageId;

    if (
      !excalidrawAPI ||
      aiMaskEditingState.mode !== "editing" ||
      !targetImageId
    ) {
      return;
    }

    const targetImage = excalidrawAPI
      .getSceneElements()
      .find((element) => element.id === targetImageId);

    if (!targetImage || !isInitializedImageElement(targetImage)) {
      return;
    }

    setMaskPreviewDataURL(
      generateMaskPreview(
        targetImage,
        maskSession.elements,
        undefined,
        getMaskPreviewCanvasSize(targetImage),
      ),
    );
    setAIMaskEditingState((current) => {
      const maskElementIds = maskSession.elements.map((element) => element.id);

      return areStringArraysEqual(current.maskElementIds, maskElementIds)
        ? current
        : { ...current, maskElementIds };
    });
  }, [
    aiMaskEditingState.mode,
    aiMaskEditingState.targetImageId,
    excalidrawAPI,
    maskSession.elements,
  ]);

  const handleMaskPointerDown = useCallback(
    (clientX: number, clientY: number) => {
      if (!excalidrawAPI || isCompletingMaskRef.current) {
        return;
      }

      const { x: sceneX, y: sceneY } = viewportCoordsToSceneCoords(
        { clientX, clientY },
        excalidrawAPI.getAppState(),
      );
      setMaskSession((current) =>
        beginAIMaskStroke(current, {
          sceneX,
          sceneY,
          isErasing: isMaskErasing,
          brushSize: maskBrushSize,
        }),
      );
    },
    [excalidrawAPI, isMaskErasing, maskBrushSize],
  );

  const handleMaskPointerMove = useCallback(
    (clientX: number, clientY: number) => {
      if (!excalidrawAPI || isCompletingMaskRef.current) {
        return;
      }

      const { x: sceneX, y: sceneY } = viewportCoordsToSceneCoords(
        { clientX, clientY },
        excalidrawAPI.getAppState(),
      );
      setMaskSession((current) =>
        appendAIMaskStrokePoint(current, sceneX, sceneY),
      );
    },
    [excalidrawAPI],
  );

  const handleMaskPointerUp = useCallback(() => {
    setMaskSession(endAIMaskStroke);
  }, []);

  if (
    aiMaskEditingState.mode !== "editing" ||
    !aiMaskEditingState.targetImageId
  ) {
    return null;
  }

  return (
    <AIMaskEditingOverlay
      targetImageId={aiMaskEditingState.targetImageId}
      targetBounds={aiMaskTargetBounds}
      isErasing={isMaskErasing}
      brushSize={maskBrushSize}
      zoomValue={maskEditingZoomValue}
      maskPreviewDataURL={maskPreviewDataURL}
      isDonePending={isCompletingMask}
      onBrushSizeChange={setMaskBrushSize}
      onDone={handleMaskEditingDone}
      onCancel={() => exitMaskEditing(true)}
      onMaskPointerDown={handleMaskPointerDown}
      onMaskPointerMove={handleMaskPointerMove}
      onMaskPointerUp={handleMaskPointerUp}
    />
  );
});

AIMaskEditingController.displayName = "AIMaskEditingController";

const cloneMaskElementsForEditing = (
  elements: readonly ExcalidrawFreeDrawElement[],
  targetImage: ExcalidrawElement,
) => {
  return elements.map((element) => {
    const relocatedElement = relocateMaskElementToImage(element, targetImage);

    return newFreeDrawElement({
      type: "freedraw",
      x: relocatedElement.x,
      y: relocatedElement.y,
      width: relocatedElement.width,
      height: relocatedElement.height,
      angle: relocatedElement.angle,
      strokeColor: relocatedElement.strokeColor,
      backgroundColor: relocatedElement.backgroundColor,
      fillStyle: relocatedElement.fillStyle,
      strokeWidth: relocatedElement.strokeWidth,
      strokeStyle: relocatedElement.strokeStyle,
      roughness: relocatedElement.roughness,
      opacity: 0,
      roundness: relocatedElement.roundness,
      groupIds: [...relocatedElement.groupIds],
      frameId: relocatedElement.frameId,
      index: null,
      boundElements: relocatedElement.boundElements
        ? [...relocatedElement.boundElements]
        : null,
      link: relocatedElement.link,
      locked: false,
      points: relocatedElement.points.map((point) =>
        pointFrom<LocalPoint>(point[0], point[1]),
      ),
      pressures: [...relocatedElement.pressures],
      simulatePressure: relocatedElement.simulatePressure,
      customData: relocatedElement.customData
        ? { ...relocatedElement.customData }
        : undefined,
    });
  });
};

const cloneMaskElements = (
  elements: readonly ExcalidrawFreeDrawElement[],
): ExcalidrawFreeDrawElement[] => {
  return elements.map((element) => ({
    ...element,
    groupIds: [...element.groupIds],
    boundElements: element.boundElements ? [...element.boundElements] : null,
    points: element.points.map((point) =>
      pointFrom<LocalPoint>(point[0], point[1]),
    ),
    pressures: [...element.pressures],
    customData: element.customData ? { ...element.customData } : undefined,
  }));
};

const bindMaskElementsToImage = (
  elements: readonly ExcalidrawFreeDrawElement[],
  targetImage: ExcalidrawImageElement,
): ExcalidrawFreeDrawElement[] => {
  const sourceGeometry = createMaskSourceGeometryV2(targetImage);

  return cloneMaskElements(elements).map((element) => ({
    ...element,
    customData: {
      ...element.customData,
      aiMaskSource: sourceGeometry,
    },
  }));
};

const relocateMaskElementToImage = (
  element: ExcalidrawFreeDrawElement,
  targetImage: ExcalidrawElement,
): ExcalidrawFreeDrawElement => {
  if (!isInitializedImageElement(targetImage)) {
    return element;
  }

  const sourceGeometry = getElementMaskSourceGeometry(element, targetImage.id);

  if (!sourceGeometry) {
    return element;
  }

  const targetGeometry = createMaskSourceGeometryV2(targetImage);

  if (
    sourceGeometry.version === 2 &&
    sourceGeometry.fileId !== targetGeometry.fileId
  ) {
    return element;
  }

  const transformedScenePoints = element.points.map((point) => {
    const sourceScenePoint = localPointToScenePoint(element, point);
    if (sourceGeometry.version === 1) {
      return legacyDisplayPointToScenePoint(
        scenePointToLegacyDisplayPoint(sourceScenePoint, sourceGeometry),
        {
          version: 1,
          imageId: targetGeometry.imageId,
          x: targetGeometry.x,
          y: targetGeometry.y,
          width: targetGeometry.width,
          height: targetGeometry.height,
          angle: targetGeometry.angle,
        },
      );
    }

    return normalizedNaturalPointToScenePoint(
      scenePointToNormalizedNaturalPoint(sourceScenePoint, sourceGeometry),
      targetGeometry,
    );
  });

  if (!transformedScenePoints.length) {
    return {
      ...element,
      x: targetGeometry.x,
      y: targetGeometry.y,
      angle: 0 as Radians,
      customData: {
        ...element.customData,
        aiMaskSource: targetGeometry,
      },
    };
  }

  const minX = Math.min(...transformedScenePoints.map((point) => point[0]));
  const minY = Math.min(...transformedScenePoints.map((point) => point[1]));
  const maxX = Math.max(...transformedScenePoints.map((point) => point[0]));
  const maxY = Math.max(...transformedScenePoints.map((point) => point[1]));
  const strokeScale = getMaskGeometryStrokeScale(
    sourceGeometry,
    targetGeometry,
  );

  return {
    ...element,
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    angle: 0 as Radians,
    strokeWidth: element.strokeWidth * strokeScale,
    points: transformedScenePoints.map((point) =>
      pointFrom<LocalPoint>(point[0] - minX, point[1] - minY),
    ),
    customData: {
      ...element.customData,
      aiMaskSource: targetGeometry,
    },
  };
};

const getElementMaskSourceGeometry = (
  element: ExcalidrawFreeDrawElement,
  targetImageId: string,
): AIMaskSourceGeometry | null => {
  const sourceGeometry = element.customData?.aiMaskSource;

  if (!isValidMaskSourceGeometry(sourceGeometry, targetImageId)) {
    return null;
  }

  return sourceGeometry;
};

const localPointToScenePoint = (
  element: ExcalidrawFreeDrawElement,
  point: readonly [number, number],
) => {
  return rotatePoint(
    [element.x + point[0], element.y + point[1]],
    getElementCenter(element),
    element.angle,
  );
};

const getElementCenter = (
  element: Pick<ExcalidrawElement, "x" | "y" | "width" | "height">,
) => [element.x + element.width / 2, element.y + element.height / 2] as const;

const rotatePoint = (
  point: readonly [number, number],
  center: readonly [number, number],
  angle: number,
) => {
  if (!angle) {
    return point;
  }

  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const translatedX = point[0] - center[0];
  const translatedY = point[1] - center[1];

  return [
    translatedX * cos - translatedY * sin + center[0],
    translatedX * sin + translatedY * cos + center[1],
  ] as const;
};

const areStringArraysEqual = (first: string[], second: string[]) => {
  if (first.length !== second.length) {
    return false;
  }

  return first.every((value, index) => value === second[index]);
};

const isMaskEditingControlTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target.isContentEditable ||
    !!target.closest(
      ".AIMaskEditingOverlay__toolbar, .AIMaskEditingOverlay__brushToolbar, .AIMaskEditingOverlay__preview",
    )
  );
};

const getMaskTargetGeometrySignature = (image: ExcalidrawImageElement) =>
  JSON.stringify({
    fileId: image.fileId,
    x: image.x,
    y: image.y,
    width: image.width,
    height: image.height,
    angle: image.angle,
    scale: image.scale,
    crop: image.crop,
  });

const isMaskEditingRangeTarget = (target: EventTarget | null) =>
  target instanceof HTMLInputElement && target.type === "range";

const MASK_EDITING_RANGE_KEYS = new Set([
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
]);

const MASK_EDITING_BLOCKED_EDITOR_KEYS = new Set([
  "delete",
  "backspace",
  "enter",
  " ",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "v",
  "r",
  "h",
  "k",
  "d",
  "a",
  "l",
  "p",
  "t",
  "i",
  "o",
  "x",
  "f",
  "w",
  "q",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
]);

const moveMaskEditingFocus = (moveBackward: boolean) => {
  const overlay = document.querySelector<HTMLElement>(".AIMaskEditingOverlay");
  if (!overlay) {
    return;
  }

  const focusable = Array.from(
    overlay.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hidden && element.tabIndex >= 0);
  if (!focusable.length) {
    overlay.focus();
    return;
  }

  const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
  const nextIndex = moveBackward
    ? currentIndex <= 0
      ? focusable.length - 1
      : currentIndex - 1
    : currentIndex < 0 || currentIndex === focusable.length - 1
    ? 0
    : currentIndex + 1;
  focusable[nextIndex].focus();
};
