import {
  CaptureUpdateAction,
  sceneCoordsToViewportCoords,
} from "@excalidraw/excalidraw";
import {
  getElementAbsoluteCoords,
  isFreeDrawElement,
  isInitializedImageElement,
  newFreeDrawElement,
  syncInvalidIndices,
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

import type {
  AppState,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  ExcalidrawFreeDrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type { LocalPoint, Radians } from "@excalidraw/math";

import {
  DEFAULT_MASK_BRUSH_SIZE,
  exportMaskAsFile,
  generateMaskPreview,
  getMaskDrawingAppState,
  getMaskPreviewCanvasSize,
} from "../ai/maskCanvas";

import { AIMaskEditingOverlay } from "./AIMaskEditingOverlay";

import type { AIMaskEditingState, AIMaskReadyPayload } from "../ai/types";

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

type AIMaskSourceGeometry = {
  version: 1;
  imageId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: Radians;
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
  const maskEditingBaseElementIdsRef = useRef<Set<string>>(new Set());

  const applyMaskDrawingConfig = useCallback(
    (isErasing: boolean, brushSize: number) => {
      if (!excalidrawAPI) {
        return;
      }

      excalidrawAPI.updateScene({
        appState: getMaskDrawingAppState(isErasing, brushSize),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    },
    [excalidrawAPI],
  );

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
      const [x1, y1, x2, y2] = getElementAbsoluteCoords(
        targetImage,
        excalidrawAPI.getSceneElementsMapIncludingDeleted(),
      );
      const topLeft = sceneCoordsToViewportCoords(
        { sceneX: x1, sceneY: y1 },
        appState,
      );
      const bottomRight = sceneCoordsToViewportCoords(
        { sceneX: x2, sceneY: y2 },
        appState,
      );

      return {
        x: Math.min(topLeft.x, bottomRight.x),
        y: Math.min(topLeft.y, bottomRight.y),
        width: Math.abs(bottomRight.x - topLeft.x),
        height: Math.abs(bottomRight.y - topLeft.y),
      };
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

      maskEditingBaseElementIdsRef.current = new Set(
        excalidrawAPI
          .getSceneElementsIncludingDeleted()
          .map((element) => element.id),
      );
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

      excalidrawAPI.setActiveTool({ type: "freedraw" }, true);
      applyMaskDrawingConfig(false, DEFAULT_MASK_BRUSH_SIZE);
      if (editableMaskElements.length) {
        const nextElements = [
          ...excalidrawAPI.getSceneElementsIncludingDeleted(),
          ...editableMaskElements,
        ];

        syncInvalidIndices(nextElements);
        excalidrawAPI.updateScene({
          elements: nextElements,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
      excalidrawAPI.updateScene({
        appState: {
          selectedElementIds: {
            [imageId]: true,
          } as AppState["selectedElementIds"],
          openMenu: null,
          openPopup: null,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      setIsMaskErasing(false);
      setMaskBrushSize(DEFAULT_MASK_BRUSH_SIZE);
      setAIMaskEditingState(nextMaskEditingState);
      setAIMaskTargetBounds(getMaskTargetViewportBounds(imageId));
      setMaskEditingZoomValue(appState.zoom.value);
    },
    [applyMaskDrawingConfig, excalidrawAPI, getMaskTargetViewportBounds],
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

    applyMaskDrawingConfig(isMaskErasing, maskBrushSize);
  }, [
    aiMaskEditingState.mode,
    applyMaskDrawingConfig,
    isMaskErasing,
    maskBrushSize,
  ]);

  useEffect(() => {
    if (aiMaskEditingState.mode !== "editing") {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "e" ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        isEditableEventTarget(event.target)
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setIsMaskErasing((current) => !current);
    };

    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [aiMaskEditingState.mode]);

  const exitMaskEditing = useCallback(
    (cancelled: boolean) => {
      if (
        !excalidrawAPI ||
        aiMaskEditingState.mode !== "editing" ||
        !aiMaskEditingState.previousState
      ) {
        return;
      }

      const { previousState, maskElementIds } = aiMaskEditingState;
      const restoredAppState = {
        selectedElementIds: previousState.selectedElementIds,
        scrollX: previousState.scrollX,
        scrollY: previousState.scrollY,
        zoom: previousState.zoom,
        activeTool: previousState.activeTool,
        currentItemStrokeColor: previousState.currentItemStrokeColor,
        currentItemBackgroundColor: previousState.currentItemBackgroundColor,
        currentItemStrokeWidth: previousState.currentItemStrokeWidth,
        currentItemStrokeStyle: previousState.currentItemStrokeStyle,
        currentItemRoughness: previousState.currentItemRoughness,
        currentItemOpacity: previousState.currentItemOpacity,
      };

      if (cancelled) {
        const currentMaskElements = getMaskElements(
          excalidrawAPI.getSceneElementsIncludingDeleted(),
          maskEditingBaseElementIdsRef.current,
        );
        const maskElementIdsSet = new Set([
          ...maskElementIds,
          ...currentMaskElements.map((element) => element.id),
        ]);
        const elements = excalidrawAPI
          .getSceneElementsIncludingDeleted()
          .filter((element) => !maskElementIdsSet.has(element.id));

        excalidrawAPI.updateScene({
          elements,
          appState: restoredAppState,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      } else {
        excalidrawAPI.updateScene({
          appState: restoredAppState,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
      setAIMaskEditingState(EMPTY_AI_MASK_EDITING_STATE);
      setAIMaskTargetBounds(null);
      setMaskEditingZoomValue(1);
      setIsMaskErasing(false);
      setMaskBrushSize(DEFAULT_MASK_BRUSH_SIZE);
      setMaskPreviewDataURL(null);
      maskEditingBaseElementIdsRef.current = new Set();
    },
    [aiMaskEditingState, excalidrawAPI],
  );

  const handleMaskEditingDone = useCallback(() => {
    if (
      !excalidrawAPI ||
      aiMaskEditingState.mode !== "editing" ||
      !aiMaskEditingState.targetImageId
    ) {
      return;
    }

    const currentElements = excalidrawAPI.getSceneElements();
    const targetImage = currentElements.find(
      (element) => element.id === aiMaskEditingState.targetImageId,
    );

    if (!targetImage || !isInitializedImageElement(targetImage)) {
      excalidrawAPI.setToast({
        message: "The selected image is no longer available.",
      });
      exitMaskEditing(true);
      return;
    }

    const currentMaskElements = getMaskElements(
      currentElements,
      maskEditingBaseElementIdsRef.current,
    );
    const maskFile = exportMaskAsFile(
      targetImage,
      currentMaskElements,
      excalidrawAPI.getFiles(),
    );
    const boundMaskElements = bindMaskElementsToImage(
      currentMaskElements,
      targetImage,
    );

    onMaskReady?.({
      imageId: targetImage.id,
      maskFile,
      maskElements: boundMaskElements,
    });

    const maskElementIdsSet = new Set([
      ...aiMaskEditingState.maskElementIds,
      ...currentMaskElements.map((element) => element.id),
    ]);

    if (maskElementIdsSet.size) {
      excalidrawAPI.updateScene({
        elements: excalidrawAPI
          .getSceneElementsIncludingDeleted()
          .filter((element) => !maskElementIdsSet.has(element.id)),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }

    exitMaskEditing(false);
  }, [aiMaskEditingState, excalidrawAPI, exitMaskEditing, onMaskReady]);

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

      const maskElements = getMaskElements(
        elements,
        maskEditingBaseElementIdsRef.current,
      );
      const nextMaskElementIds = maskElements.map((element) => element.id);

      setMaskPreviewDataURL(
        targetImage && isInitializedImageElement(targetImage)
          ? generateMaskPreview(
              targetImage,
              maskElements,
              undefined,
              getMaskPreviewCanvasSize(targetImage),
            )
          : null,
      );

      setAIMaskEditingState((current) => {
        if (
          current.mode !== "editing" ||
          current.targetImageId !== targetImageId ||
          areStringArraysEqual(current.maskElementIds, nextMaskElementIds)
        ) {
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
      onBrushSizeChange={setMaskBrushSize}
      onDone={handleMaskEditingDone}
      onCancel={() => exitMaskEditing(true)}
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
  targetImage: ExcalidrawElement,
): ExcalidrawFreeDrawElement[] => {
  const sourceGeometry = getImageMaskSourceGeometry(targetImage);

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
  const sourceGeometry = getElementMaskSourceGeometry(element, targetImage.id);

  if (!sourceGeometry) {
    return element;
  }

  const targetGeometry = getImageMaskSourceGeometry(targetImage);
  const transformedScenePoints = element.points.map((point) => {
    const sourceScenePoint = localPointToScenePoint(element, point);
    const sourceLocalPoint = scenePointToImageLocalPoint(
      sourceScenePoint,
      sourceGeometry,
    );

    return imageLocalPointToScenePoint(sourceLocalPoint, targetGeometry);
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
  const strokeScale = getMaskStrokeScale(sourceGeometry, targetGeometry);

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

  if (
    !sourceGeometry ||
    sourceGeometry.version !== 1 ||
    sourceGeometry.imageId !== targetImageId ||
    !isFiniteGeometry(sourceGeometry)
  ) {
    return null;
  }

  return sourceGeometry;
};

const getImageMaskSourceGeometry = (
  image: Pick<
    ExcalidrawElement,
    "id" | "x" | "y" | "width" | "height" | "angle"
  >,
): AIMaskSourceGeometry => ({
  version: 1,
  imageId: image.id,
  x: image.x,
  y: image.y,
  width: image.width,
  height: image.height,
  angle: image.angle,
});

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

const scenePointToImageLocalPoint = (
  point: readonly [number, number],
  image: AIMaskSourceGeometry,
) => {
  const unrotatedPoint = rotatePoint(
    point,
    getElementCenter(image),
    -image.angle,
  );

  return [
    (unrotatedPoint[0] - image.x) / getSafeDimension(image.width),
    (unrotatedPoint[1] - image.y) / getSafeDimension(image.height),
  ] as const;
};

const imageLocalPointToScenePoint = (
  point: readonly [number, number],
  image: AIMaskSourceGeometry,
) => {
  const unrotatedPoint = [
    image.x + point[0] * image.width,
    image.y + point[1] * image.height,
  ] as const;

  return rotatePoint(unrotatedPoint, getElementCenter(image), image.angle);
};

const getMaskStrokeScale = (
  source: AIMaskSourceGeometry,
  target: AIMaskSourceGeometry,
) => {
  const scaleX = Math.abs(target.width) / getSafeDimension(source.width);
  const scaleY = Math.abs(target.height) / getSafeDimension(source.height);

  return Math.max(scaleX, scaleY);
};

const getSafeDimension = (dimension: number) =>
  Math.max(1, Math.abs(dimension));

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

const isFiniteGeometry = (geometry: AIMaskSourceGeometry) =>
  Number.isFinite(geometry.x) &&
  Number.isFinite(geometry.y) &&
  Number.isFinite(geometry.width) &&
  Number.isFinite(geometry.height) &&
  Number.isFinite(geometry.angle);

const areStringArraysEqual = (first: string[], second: string[]) => {
  if (first.length !== second.length) {
    return false;
  }

  return first.every((value, index) => value === second[index]);
};

const getMaskElements = (
  elements: readonly ExcalidrawElement[] | readonly OrderedExcalidrawElement[],
  baseElementIds: Set<string>,
): ExcalidrawFreeDrawElement[] => {
  const maskElements: ExcalidrawFreeDrawElement[] = [];

  for (const element of elements) {
    if (isFreeDrawElement(element) && !baseElementIds.has(element.id)) {
      maskElements.push(element as ExcalidrawFreeDrawElement);
    }
  }

  return maskElements;
};

const isEditableEventTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
};
