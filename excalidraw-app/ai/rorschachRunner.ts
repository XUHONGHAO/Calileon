import { t } from "@excalidraw/excalidraw/i18n";
import { getSelectedElements } from "@excalidraw/element";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import {
  DEFAULT_AI_REFERENCE_EXPORT_OPTIONS,
  exportSelectionToReferenceSource,
} from "./canvasExport";
import { loadAIImageConfig } from "./config";
import { getDefaultVisionAgent, loadAIAgentConfig } from "./agentConfig";
import { getManagedRouteForCapability } from "./requestTransport";
import { loadAIProxyConfig } from "./proxyConfig";
import { runRorschachImage } from "./rorschachImage";
import { describeImageWithVisionAgent } from "./visionAgentAdapter";
import { generateImagesWithOpenAIAdapter } from "./openAIImageAdapter";
import {
  buildRorschachReadingSystemPrompt,
  buildRorschachReadingUserPrompt,
  buildRorschachImagePrompt,
  RORSCHACH_HISTORY_LIMIT,
  getRorschachPersona,
} from "./rorschachPersonas";
import { parseRorschachReading } from "./rorschachReading";
import {
  createRorschachAttempt,
  describeErrorMessage,
  isAbortError,
  patchRorschachAttempt,
  pushRorschachHistory,
  runRorschachReading,
} from "./rorschachSession";

import type { AIImageModel, AIAgent } from "./types";
import type {
  RorschachAttempt,
  RorschachImageOutput,
  RorschachPersonaId,
  RorschachReading,
  RorschachRunMode,
  RorschachSession,
} from "./rorschachTypes";

/**
 * Single-session runner for G6. Every network stage is guarded by both an
 * AbortSignal and a monotonically increasing run id, so cancelled or stale
 * work can never mutate the dialog or the canvas.
 */

export type RorschachAvailability = {
  visionAgent: AIAgent | null;
  imageModel: AIImageModel | null;
  managed: boolean;
  /** True when the current transport cannot run the requested stage. */
  visionUnavailableReason: "missing" | "route" | null;
  imageUnavailableReason: "missing" | "route" | null;
};

export const resolveRorschachAvailability = ({
  needsImage,
}: {
  needsImage: boolean;
}): RorschachAvailability => {
  const transport = loadAIProxyConfig();
  const managed = transport.mode === "managed-gateway";

  if (managed) {
    const visionRouteId = transport.managedRoutes["vision-agent"];
    const imageRouteId = transport.managedRoutes["image-generation"];
    return {
      visionAgent: null,
      imageModel: null,
      managed,
      visionUnavailableReason: visionRouteId ? null : "route",
      imageUnavailableReason: !needsImage || imageRouteId ? null : "route",
    };
  }

  const agentConfig = loadAIAgentConfig();
  const visionAgent = getDefaultVisionAgent(agentConfig);
  const usableAgent =
    visionAgent && visionAgent.baseURL.trim() && visionAgent.model.trim()
      ? visionAgent
      : null;
  const imageConfig = loadAIImageConfig();
  const imageModel =
    imageConfig.models.find(
      (model) =>
        model.mediaType === "image" &&
        model.capabilities.includes("image-to-image"),
    ) || null;

  return {
    visionAgent: usableAgent,
    imageModel,
    managed,
    visionUnavailableReason: usableAgent ? null : "missing",
    imageUnavailableReason: !needsImage || imageModel ? null : "missing",
  };
};

/**
 * Managed mode resolves the image route eagerly before paying for a reading,
 * so a missing image route never leaves the user with a paid reading and no
 * way to draw it.
 */
export const assertRorschachTransportReady = async ({
  needsImage,
}: {
  needsImage: boolean;
}) => {
  const availability = resolveRorschachAvailability({ needsImage });
  if (availability.visionUnavailableReason === "missing") {
    throw new Error(t("labs.rorschach.noVisionAgent"));
  }
  const transport = loadAIProxyConfig();
  if (transport.mode === "managed-gateway") {
    await getManagedRouteForCapability("vision-agent", { config: transport });
    if (needsImage) {
      await getManagedRouteForCapability("image-generation", {
        config: transport,
      });
    }
    return availability;
  }
  if (needsImage && availability.imageUnavailableReason === "missing") {
    throw new Error(t("labs.rorschach.noImageModel"));
  }
  return availability;
};

/**
 * Stage boundaries injected for tests. Production always uses the real
 * implementations; the dialog passes nothing.
 */
export type RorschachRunnerDeps = {
  capture?: typeof captureRorschachSelection;
  resolveAvailability?: typeof resolveRorschachAvailability;
  resolveTransport?: typeof assertRorschachTransportReady;
  describe?: typeof describeImageWithVisionAgent;
  generate?: typeof generateImagesWithOpenAIAdapter;
};

export type RorschachRunnerCallbacks = {
  onSession: (session: RorschachSession) => void;
  onReading: (reading: RorschachReading) => void;
  onImage: (output: RorschachImageOutput) => void;
  onError: (message: string, stage: "reading" | "image" | "input") => void;
};

const getSelectionBounds = (elements: readonly ExcalidrawElement[]) => {
  const visible = elements.filter((element) => !element.isDeleted);
  if (!visible.length) {
    return null;
  }
  const minX = Math.min(...visible.map((element) => element.x));
  const minY = Math.min(...visible.map((element) => element.y));
  const maxX = Math.max(...visible.map((element) => element.x + element.width));
  const maxY = Math.max(
    ...visible.map((element) => element.y + element.height),
  );
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

export const captureRorschachSelection = async ({
  excalidrawAPI,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI;
}) => {
  const elements = excalidrawAPI.getSceneElements();
  const appState = excalidrawAPI.getAppState();
  const selected = getSelectedElements(elements, appState);
  if (!selected.length) {
    throw new Error(t("labs.rorschach.selectFirst"));
  }
  const { source } = await exportSelectionToReferenceSource({
    elements: selected,
    appState,
    files: excalidrawAPI.getFiles(),
    options: DEFAULT_AI_REFERENCE_EXPORT_OPTIONS,
    index: 0,
  });
  return {
    dataURL: source.dataURL,
    width: source.width,
    height: source.height,
    sourceElementIds: source.elementIds || [source.elementId],
    bounds: getSelectionBounds(selected),
  };
};

export class RorschachRunner {
  private abortController: AbortController | null = null;
  private runId = 0;
  private disposed = false;
  private listeners: RorschachRunnerCallbacks;
  private session: RorschachSession;
  private deps: Required<RorschachRunnerDeps>;

  constructor({
    session,
    listeners,
    deps,
  }: {
    session: RorschachSession;
    listeners: RorschachRunnerCallbacks;
    deps?: RorschachRunnerDeps;
  }) {
    this.session = session;
    this.listeners = listeners;
    this.deps = {
      capture: deps?.capture || captureRorschachSelection,
      resolveAvailability:
        deps?.resolveAvailability || resolveRorschachAvailability,
      resolveTransport: deps?.resolveTransport || assertRorschachTransportReady,
      describe: deps?.describe || describeImageWithVisionAgent,
      generate: deps?.generate || generateImagesWithOpenAIAdapter,
    };
  }

  getDeps() {
    return this.deps;
  }

  getSession() {
    return this.session;
  }

  isRunning() {
    return !!this.session.attempts.find(
      (attempt) =>
        attempt.readingStatus === "running" ||
        attempt.imageStatus === "running",
    );
  }

  private emit() {
    if (!this.disposed) {
      this.listeners.onSession(this.session);
    }
  }

  private patch(attemptId: string, patch: Partial<RorschachAttempt>) {
    this.session = patchRorschachAttempt(this.session, attemptId, patch);
    this.emit();
  }

  private isCurrent(runId: number) {
    return !this.disposed && this.runId === runId;
  }

  updateSession(patch: Partial<RorschachSession>) {
    this.session = { ...this.session, ...patch };
    this.emit();
  }

  cancel() {
    this.runId += 1;
    this.abortController?.abort();
    this.abortController = null;
    this.session = {
      ...this.session,
      attempts: this.session.attempts.map((attempt) =>
        attempt.readingStatus === "running" || attempt.imageStatus === "running"
          ? {
              ...attempt,
              readingStatus:
                attempt.readingStatus === "running"
                  ? "cancelled"
                  : attempt.readingStatus,
              imageStatus:
                attempt.imageStatus === "running"
                  ? "cancelled"
                  : attempt.imageStatus,
              readingError:
                attempt.readingStatus === "running"
                  ? t("labs.rorschach.errors.cancelled")
                  : attempt.readingError,
              imageError:
                attempt.imageStatus === "running"
                  ? t("labs.rorschach.errors.cancelled")
                  : attempt.imageError,
            }
          : attempt,
      ),
    };
    this.emit();
  }

  dispose() {
    this.disposed = true;
    this.runId += 1;
    this.abortController?.abort();
    this.abortController = null;
  }

  /**
   * Starts a new attempt. `mode` decides whether the image stage follows the
   * reading automatically.
   */
  async start({
    image,
    personaId,
    locale,
    mode,
  }: {
    image: Awaited<ReturnType<typeof captureRorschachSelection>>;
    personaId: RorschachPersonaId;
    locale: string;
    mode: RorschachRunMode;
  }) {
    this.cancel();
    const runId = ++this.runId;
    const abortController = new AbortController();
    this.abortController = abortController;

    const persona = getRorschachPersona(personaId);
    const attempt = createRorschachAttempt({
      sequence: this.session.attempts.length + 1,
      mode,
      personaId,
      image: image.dataURL,
    });

    this.session = {
      ...this.session,
      input: {
        dataURL: image.dataURL,
        width: image.width ?? 0,
        height: image.height ?? 0,
        sourceElementIds: image.sourceElementIds,
        bounds: image.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
        locale,
      },
      personaId,
      runMode: mode,
      activeAttemptId: attempt.id,
      attempts: [...this.session.attempts, attempt],
    };
    this.emit();

    let availability: RorschachAvailability;
    try {
      availability = await this.deps.resolveTransport({
        needsImage: mode === "read-and-draw",
      });
    } catch (error) {
      if (!this.isCurrent(runId)) {
        return;
      }
      // The reading stage error is rendered by the dialog; the settings hint
      // is derived from the same failure, so no extra banner is needed here.
      this.patch(attempt.id, {
        readingStatus: "failed",
        readingError: describeErrorMessage(error),
      });
      return;
    }
    if (!this.isCurrent(runId)) {
      return;
    }

    const reading = await runRorschachReading({
      session: this.session,
      attempt,
      agent: availability.visionAgent,
      systemPrompt: buildRorschachReadingSystemPrompt({ persona, locale }),
      userPrompt: buildRorschachReadingUserPrompt({
        history: this.session.history,
      }),
      locale,
      signal: abortController.signal,
      parse: parseRorschachReading,
      deps: { describe: this.deps.describe },
      isCurrent: () => this.isCurrent(runId),
      onPatch: (attemptId, patch) => {
        if (this.isCurrent(runId)) {
          this.patch(attemptId, patch);
        }
      },
    });

    if (!reading || !this.isCurrent(runId)) {
      return;
    }

    this.session = {
      ...this.session,
      history: pushRorschachHistory(
        this.session.history,
        reading.reading,
        RORSCHACH_HISTORY_LIMIT,
      ),
    };
    this.emit();
    this.listeners.onReading(reading);

    if (mode === "read-only") {
      return;
    }

    await this.draw({
      attemptId: attempt.id,
      externalRunId: runId,
      availability,
    });
  }

  /** Draw stage. Reuses the attempt's reading and image; never re-reads. */
  async draw({
    attemptId,
    externalRunId,
    availability,
  }: {
    attemptId: string;
    externalRunId?: number;
    availability?: RorschachAvailability;
  }) {
    const attempt = this.session.attempts.find((item) => item.id === attemptId);
    if (!attempt?.result) {
      return;
    }
    const effectiveRunId = externalRunId ?? ++this.runId;
    if (externalRunId === undefined) {
      this.abortController = new AbortController();
    }
    const abortController = this.abortController;
    if (!abortController) {
      return;
    }

    let resolved = availability;
    if (!resolved) {
      try {
        resolved = await this.deps.resolveTransport({ needsImage: true });
      } catch (error) {
        if (this.isCurrent(effectiveRunId)) {
          this.patch(attemptId, {
            imageStatus: "failed",
            imageError: describeErrorMessage(error),
          });
        }
        return;
      }
    }
    if (!this.isCurrent(effectiveRunId)) {
      return;
    }

    const imageModel = resolved.imageModel;
    const managed = resolved.managed;
    if (!managed && !imageModel) {
      this.patch(attemptId, {
        imageStatus: "failed",
        imageError: t("labs.rorschach.noImageModel"),
      });
      return;
    }

    const persona = getRorschachPersona(attempt.personaId);
    const imageConfig = loadAIImageConfig();
    // In managed mode the adapter resolves the route and ignores local keys;
    // it still needs a model card to describe the request shape.
    const model: AIImageModel =
      imageModel ||
      ({
        id: "rorschach-managed",
        siteName: "managed",
        baseURL: "",
        apiKey: "",
        model: "rorschach-managed",
        label: "managed",
        mediaType: "image",
        capabilities: ["image-to-image"],
        endpoints: {},
        requestTimeoutSeconds: 600,
      } as unknown as AIImageModel);

    const output = await runRorschachImage({
      attempt,
      imageDataURL: attempt.image,
      imagePrompt: buildRorschachImagePrompt({
        imagePrompt: attempt.result.imagePrompt,
        persona,
      }),
      persona,
      model,
      config: imageConfig,
      signal: abortController.signal,
      isCurrent: () => this.isCurrent(effectiveRunId),
      onPatch: (targetId, patch) => {
        if (this.isCurrent(effectiveRunId)) {
          this.patch(targetId, patch);
        }
      },
      deps: { generate: this.deps.generate },
    });

    if (output && this.isCurrent(effectiveRunId)) {
      this.listeners.onImage(output);
    }
  }
}

export const isRorschachAbortError = isAbortError;
