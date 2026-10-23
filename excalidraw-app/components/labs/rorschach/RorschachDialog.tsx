import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { t } from "@excalidraw/excalidraw/i18n";
import { getSelectedElements } from "@excalidraw/element";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { createAIOpenSettingsEvent } from "../../../ai/workflowEvents";
import {
  resolveRorschachAvailability,
  RorschachRunner,
} from "../../../ai/rorschachRunner";
import {
  RORSCHACH_DEFAULT_PERSONA_ID,
  RORSCHACH_PERSONAS,
  getRorschachPersona,
} from "../../../ai/rorschachPersonas";
import { createRorschachSession } from "../../../ai/rorschachSession";
import { insertRorschachResultIntoCanvas } from "../../../ai/rorschachCanvas";

import { Badge, Callout, DialogActions, UiButton } from "../../ui";

import { RORSCHACH_PERSONA_ICONS, RorschachIcon } from "./icons";

import "./RorschachDialog.scss";

import type { RorschachRunnerDeps } from "../../../ai/rorschachRunner";
import type {
  RorschachAttempt,
  RorschachPersonaId,
  RorschachRunMode,
  RorschachSession,
  RorschachTranslationKey,
} from "../../../ai/rorschachTypes";
import type { UiTone } from "../../ui";

type Props = {
  open: boolean;
  onClose: () => void;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  /** Vault mode: no outbound AI, so the host unmounts the dialog. */
  externalFeaturesDisabled: boolean;
  /** Test seam for the stage boundaries; production omits it. */
  runnerDeps?: RorschachRunnerDeps;
};

const STATUS_LABEL: Record<string, RorschachTranslationKey> = {
  idle: "labs.rorschach.status.idle",
  running: "labs.rorschach.status.running",
  succeeded: "labs.rorschach.status.succeeded",
  failed: "labs.rorschach.status.failed",
  cancelled: "labs.rorschach.status.cancelled",
};

const statusLabel = (status: string | undefined) =>
  STATUS_LABEL[status || "idle"] || STATUS_LABEL.idle;

const resolveLocale = () => {
  const fromDocument =
    typeof document !== "undefined" ? document.documentElement.lang : "";
  return (
    fromDocument ||
    (typeof navigator !== "undefined" ? navigator.language : "") ||
    "en"
  );
};

type SettingsIssue = "vision" | "image" | "route" | null;

/** Maps the runner's per-stage failure reason onto the settings hint. */
const toSettingsIssue = (
  reason: "missing" | "route" | null,
  stage: "vision" | "image",
): SettingsIssue => {
  if (reason === "route") {
    return "route";
  }
  if (reason === "missing") {
    return stage;
  }
  return null;
};

const STATUS_TONE: Record<string, UiTone> = {
  idle: "neutral",
  running: "info",
  succeeded: "success",
  failed: "danger",
  cancelled: "neutral",
};

export const RorschachDialog = ({
  open,
  onClose,
  excalidrawAPI,
  externalFeaturesDisabled,
  runnerDeps,
}: Props) => {
  const [session, setSession] = useState<RorschachSession>(() =>
    createRorschachSession(RORSCHACH_DEFAULT_PERSONA_ID),
  );
  const [personaId, setPersonaId] = useState<RorschachPersonaId>(
    RORSCHACH_DEFAULT_PERSONA_ID,
  );
  const [selectionCount, setSelectionCount] = useState(0);
  const [inputError, setInputError] = useState("");
  const [insertNotice, setInsertNotice] = useState("");
  const [needsSettings, setNeedsSettings] = useState<SettingsIssue>(null);
  const runnerRef = useRef<RorschachRunner | null>(null);
  const activePersonaRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    // Wait a frame: the closing main menu restores focus on its way out.
    const frame = requestAnimationFrame(() =>
      activePersonaRef.current?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [open]);
  const [busy, setBusy] = useState(false);
  /** Guards against a double click inserting the same result twice. */
  const [inserting, setInserting] = useState(false);

  // Recomputed on each open and whenever a stage reports a configuration
  // problem, because AI settings may have been changed in another tab.
  const availability = useMemo(
    () => (open ? resolveRorschachAvailability({ needsImage: true }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, needsSettings],
  );

  const ensureRunner = useCallback(() => {
    if (!runnerRef.current) {
      runnerRef.current = new RorschachRunner({
        session: createRorschachSession(personaId),
        deps: runnerDeps,
        listeners: {
          onSession: (next: RorschachSession) => setSession(next),
          onReading: () => setInsertNotice(""),
          onImage: () => setInsertNotice(""),
          onError: (message: string) => {
            // Stage failures already render next to their stage; only
            // input-level problems need the shared message slot.
            setInputError(message);
          },
        },
      });
    }
    return runnerRef.current;
  }, [personaId, runnerDeps]);

  const runner = runnerRef.current;
  useEffect(() => {
    setBusy(!!runner?.isRunning());
  }, [runner, session]);

  // Selection tracking: the dialog never sends anything the user did not
  // explicitly select, and says so before the first request.
  useEffect(() => {
    if (!open || !excalidrawAPI) {
      setSelectionCount(0);
      return;
    }
    const update = () => {
      const elements = excalidrawAPI.getSceneElements();
      const selected = getSelectedElements(
        elements,
        excalidrawAPI.getAppState(),
      );
      setSelectionCount(selected.length);
    };
    update();
    const unsubscribe = excalidrawAPI.onChange(update);
    return () => unsubscribe();
  }, [excalidrawAPI, open]);

  // Vault mode (or closing) must abort immediately and drop late results.
  useEffect(() => {
    if (open && !externalFeaturesDisabled) {
      return;
    }
    runnerRef.current?.dispose();
    runnerRef.current = null;
    setSession(createRorschachSession(personaId));
    setInsertNotice("");
    setInputError("");
    setBusy(false);
  }, [externalFeaturesDisabled, open, personaId]);

  useEffect(() => {
    return () => {
      runnerRef.current?.dispose();
      runnerRef.current = null;
    };
  }, []);

  const locale = useMemo(() => resolveLocale(), []);

  const beginRun = useCallback(
    async (mode: RorschachRunMode) => {
      if (!excalidrawAPI) {
        return;
      }
      setInputError("");
      setInsertNotice("");
      setNeedsSettings(null);
      const active = ensureRunner();
      active.updateSession({ personaId });
      const capture = active.getDeps().capture;
      let snapshot;
      try {
        snapshot = await capture({ excalidrawAPI });
      } catch (error) {
        setInputError(
          error instanceof Error
            ? error.message
            : t("labs.rorschach.errors.selectionExport"),
        );
        return;
      }
      setBusy(true);
      await active.start({
        image: snapshot,
        personaId,
        locale,
        mode,
      });
      setBusy(active.isRunning());
      const current = active.getSession();
      const latest = current.attempts[current.attempts.length - 1];
      if (!latest) {
        return;
      }
      if (latest.readingStatus === "failed") {
        setNeedsSettings(
          toSettingsIssue(
            availability?.visionUnavailableReason || null,
            "vision",
          ),
        );
      } else if (latest.imageStatus === "failed") {
        setNeedsSettings(
          toSettingsIssue(
            availability?.imageUnavailableReason || null,
            "image",
          ),
        );
      }
    },
    [availability, ensureRunner, excalidrawAPI, locale, personaId],
  );

  const retryReading = useCallback(() => {
    void beginRun(session.runMode);
  }, [beginRun, session.runMode]);

  const retryImage = useCallback(() => {
    const active = runnerRef.current;
    const attempt = session.attempts[session.attempts.length - 1];
    if (!active || !attempt || !attempt.result) {
      return;
    }
    setBusy(true);
    void active.draw({ attemptId: attempt.id }).finally(() => {
      setBusy(!!runnerRef.current?.isRunning());
    });
  }, [session.attempts]);

  const drawNow = useCallback(() => {
    const active = runnerRef.current;
    const attempt = session.attempts[session.attempts.length - 1];
    if (!active || !attempt?.result) {
      return;
    }
    setBusy(true);
    void active.draw({ attemptId: attempt.id }).finally(() => {
      setBusy(!!runnerRef.current?.isRunning());
    });
  }, [session.attempts]);

  const insert = useCallback(
    async (mode: "image-and-text" | "text-only") => {
      if (!excalidrawAPI) {
        return;
      }
      const attempt: RorschachAttempt | undefined =
        session.attempts[session.attempts.length - 1];
      if (!attempt?.result || inserting) {
        return;
      }
      setInserting(true);
      try {
        const result = await insertRorschachResultIntoCanvas({
          excalidrawAPI,
          relation: {
            persona: attempt.personaId,
            reading: attempt.result.reading,
            sourceElementIds: session.input?.sourceElementIds || [],
            batchId: session.batchId,
          },
          imageOutput:
            mode === "image-and-text" && attempt.imageOutput
              ? attempt.imageOutput
              : null,
          reading: attempt.result.reading,
          sourceBounds: session.input?.bounds || null,
        });
        if (!result) {
          setInputError(t("labs.rorschach.errors.insertFailed"));
          return;
        }
        setInsertNotice(
          mode === "text-only"
            ? t("labs.rorschach.insertedTextOnly")
            : t("labs.rorschach.inserted"),
        );
      } catch {
        setInputError(t("labs.rorschach.errors.insertFailed"));
      } finally {
        setInserting(false);
      }
    },
    [excalidrawAPI, inserting, session],
  );

  const openSettings = useCallback(() => {
    window.dispatchEvent(createAIOpenSettingsEvent({ tab: "models" }));
  }, []);

  if (!open || externalFeaturesDisabled) {
    return null;
  }

  const persona = getRorschachPersona(personaId);
  const attempt = session.attempts[session.attempts.length - 1];
  const reading = attempt?.result?.reading || "";
  const image = attempt?.imageOutput;
  const running =
    attempt?.readingStatus === "running" || attempt?.imageStatus === "running";
  const showDuplicate =
    attempt?.readingStatus === "succeeded" &&
    session.history.filter((entry) => entry === reading).length > 1;

  return (
    <Dialog
      className="RorschachDialog"
      title={
        <span className="RorschachDialog__title">
          <span className="RorschachDialog__titleIcon" aria-hidden="true">
            {RorschachIcon}
          </span>
          {t("labs.rorschach.title")}
        </span>
      }
      size="regular"
      onCloseRequest={onClose}
      // Dialog focuses its 2nd focusable (assuming a close button), which
      // lit up the 2nd persona as if selected. Focus the active one instead.
      autofocus={false}
    >
      <div className="Rorschach" aria-label={t("labs.rorschach.title")}>
        <p className="Rorschach__intro">{t("labs.rorschach.intro")}</p>

        <p className="Rorschach__personaLabel" id="rorschach-persona-label">
          {t("labs.rorschach.persona")}
        </p>
        <div
          className="Rorschach__personaRow"
          role="group"
          aria-labelledby="rorschach-persona-label"
        >
          {RORSCHACH_PERSONAS.map((item) => {
            const Icon = RORSCHACH_PERSONA_ICONS[item.id];
            const active = item.id === personaId;
            return (
              <button
                key={item.id}
                type="button"
                className={`Rorschach__persona${active ? " is-active" : ""}`}
                aria-pressed={active}
                ref={active ? activePersonaRef : undefined}
                disabled={running}
                onClick={() => setPersonaId(item.id)}
              >
                <span className="Rorschach__personaIcon" aria-hidden="true">
                  {Icon}
                </span>
                <span className="Rorschach__personaName">
                  {t(item.nameKey)}
                </span>
              </button>
            );
          })}
        </div>
        <p className="Rorschach__personaHint">{t(persona.promptKey)}</p>

        {!selectionCount && (
          <Callout tone="warning" live={false}>
            {t("labs.rorschach.selectFirst")}
          </Callout>
        )}

        {(attempt || inputError || insertNotice) && (
          <section className="Rorschach__result">
            <div className="Rorschach__stage">
              <h3 className="Rorschach__stageTitle">
                {t("labs.rorschach.readingTitle")}
              </h3>
              <Badge tone={STATUS_TONE[attempt?.readingStatus || "idle"]}>
                {t(statusLabel(attempt?.readingStatus))}
              </Badge>
              <p
                className="Rorschach__reading"
                aria-live="polite"
                data-testid="rorschach-reading"
              >
                {reading ||
                  (attempt?.readingStatus === "failed" ||
                  attempt?.readingStatus === "cancelled"
                    ? "—"
                    : t("labs.rorschach.readingPlaceholder"))}
              </p>
              {attempt?.readingError && (
                <Callout tone="danger">{attempt.readingError}</Callout>
              )}
              {showDuplicate && (
                <Callout tone="info" live={false}>
                  {t("labs.rorschach.duplicateReading")}
                </Callout>
              )}
            </div>

            <div className="Rorschach__stage">
              <h3 className="Rorschach__stageTitle">
                {t("labs.rorschach.previewTitle")}
              </h3>
              <Badge tone={STATUS_TONE[attempt?.imageStatus || "idle"]}>
                {t(statusLabel(attempt?.imageStatus))}
              </Badge>
              {image ? (
                <img
                  className="Rorschach__preview"
                  src={image.dataURL}
                  alt={reading || t("labs.rorschach.previewTitle")}
                />
              ) : (
                <p className="Rorschach__placeholder">
                  {attempt?.imageStatus === "failed" ||
                  attempt?.imageStatus === "cancelled"
                    ? "—"
                    : t("labs.rorschach.imagePlaceholder")}
                </p>
              )}
              {attempt?.imageError && (
                <Callout tone="danger">{attempt.imageError}</Callout>
              )}
            </div>
          </section>
        )}

        {inputError && <Callout tone="danger">{inputError}</Callout>}
        {insertNotice && <Callout tone="success">{insertNotice}</Callout>}

        {needsSettings && !busy && (
          <Callout
            tone="info"
            action={
              <UiButton size="sm" onClick={openSettings}>
                {t("labs.rorschach.openSettings")}
              </UiButton>
            }
          >
            {needsSettings === "vision"
              ? t("labs.rorschach.settingsHintVision")
              : needsSettings === "image"
              ? t("labs.rorschach.settingsHintImage")
              : t("labs.rorschach.settingsHintRoute")}
          </Callout>
        )}

        <div className="Rorschach__actions">
          <div className="Rorschach__actionGroup">
            <UiButton
              variant="primary"
              onClick={() => void beginRun("read-and-draw")}
              disabled={!selectionCount || running}
              loading={running && session.runMode === "read-and-draw"}
            >
              {t("labs.rorschach.actionReadAndDraw")}
            </UiButton>
            <span className="Rorschach__cost">
              {t("labs.rorschach.costReadAndDraw")}
            </span>
          </div>
          <div className="Rorschach__actionGroup">
            <UiButton
              onClick={() => void beginRun("read-only")}
              disabled={!selectionCount || running}
              loading={running && session.runMode === "read-only"}
            >
              {t("labs.rorschach.actionReadOnly")}
            </UiButton>
            <span className="Rorschach__cost">
              {t("labs.rorschach.costReadOnly")}
            </span>
          </div>
          {running && (
            <UiButton
              variant="ghost"
              onClick={() => {
                runnerRef.current?.cancel();
                setBusy(false);
              }}
            >
              {t("labs.rorschach.cancel")}
            </UiButton>
          )}
        </div>

        {attempt && (
          <DialogActions>
            {attempt.readingStatus === "failed" && (
              <UiButton onClick={retryReading} disabled={running}>
                {t("labs.rorschach.retryReading")}
              </UiButton>
            )}
            {attempt.readingStatus === "succeeded" && (
              <>
                <UiButton
                  variant="ghost"
                  onClick={() => void beginRun(session.runMode)}
                  disabled={running}
                >
                  {t("labs.rorschach.readAgain")}
                </UiButton>
                {attempt.imageStatus === "failed" && (
                  <UiButton onClick={retryImage} disabled={running}>
                    {t("labs.rorschach.retryImage")}
                  </UiButton>
                )}
                {session.runMode === "read-only" && !attempt.imageOutput && (
                  <UiButton onClick={drawNow} disabled={running}>
                    {t("labs.rorschach.drawNow")}
                  </UiButton>
                )}
                <UiButton
                  variant="ghost"
                  onClick={() => void insert("text-only")}
                  disabled={running || inserting}
                >
                  {t("labs.rorschach.textOnly")}
                </UiButton>
                {attempt.imageOutput && (
                  <UiButton
                    variant="primary"
                    onClick={() => void insert("image-and-text")}
                    disabled={running || inserting}
                    loading={inserting}
                  >
                    {t("labs.rorschach.insertImage")}
                  </UiButton>
                )}
              </>
            )}
          </DialogActions>
        )}

        <p className="Rorschach__footer">
          <span className="Rorschach__session">
            {t("labs.rorschach.sessionNotice")}
          </span>
          <span className="Rorschach__disclaimer">
            {t("labs.rorschach.disclaimer")}
          </span>
        </p>
      </div>
    </Dialog>
  );
};
