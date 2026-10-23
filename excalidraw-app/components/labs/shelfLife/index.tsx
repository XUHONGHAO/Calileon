import { useEffect, useRef, useState } from "react";
import { MainMenu } from "@excalidraw/excalidraw";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { createIcon } from "@excalidraw/excalidraw/components/icons";
import { getLanguage, t } from "@excalidraw/excalidraw/i18n";
import {
  CaptureUpdateAction,
  getExpiredShelfLife,
  getShelfLifeSelection,
  getShelfLifeData,
  getShelfLifeDeadline,
  getShelfLifeDateDeadline,
  setShelfLifeForSelection,
  planShelfLifeCleanup,
} from "@excalidraw/element";

import type { ShelfLifePreset } from "@excalidraw/element";

import { UiButton, Field, TextInput, Callout, confirmAction } from "../../ui";
import {
  openLabsFeature,
  closeLabsFeature,
  useLabsFeatureOpen,
} from "../labsDialogs";

import "./shelfLife.scss";

import type { LabsHostProps, LabsMenuItemProps } from "../types";

// A note with a folded corner and a clock: drawn on a 24-unit grid, so the
// viewBox and stroke must say so (createIcon defaults to 512 and fill).
const icon = createIcon(
  <>
    <path d="M4 3h16v12l-6 6H4z" />
    <path d="M14 21v-6h6M8 7v4l3 2" />
  </>,
  {
    width: 24,
    height: 24,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
);
export const ShelfLifeMenuItem = (_props: LabsMenuItemProps) => (
  <MainMenu.Item
    icon={icon}
    data-testid="labs-shelfLife-menu-item"
    aria-label={t("labs.shelfLife.title")}
    onSelect={() => openLabsFeature("shelfLife")}
  >
    {t("labs.shelfLife.title")}
  </MainMenu.Item>
);

/** Midnight deadlines read as "until the end of <previous day>". */
const formatValue = (value: number | null | undefined) => {
  if (value === undefined) {
    return t("labs.shelfLife.mixed");
  }
  if (value === null) {
    return t("labs.shelfLife.permanent");
  }
  const at = new Date(value);
  if (at.getHours() === 0 && at.getMinutes() === 0) {
    return t("labs.shelfLife.untilDay", {
      date: new Date(value - 1).toLocaleDateString(getLanguage().code, {
        month: "short",
        day: "numeric",
        weekday: "short",
      }),
    });
  }
  return t("labs.shelfLife.untilTime", {
    date: at.toLocaleString(getLanguage().code, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }),
  });
};

const getExpiredIdentity = (list: ReturnType<typeof getExpiredShelfLife>) =>
  [
    ...list.unlocked.map((el) => el.id).sort(),
    "|",
    ...list.locked.map((el) => el.id).sort(),
  ].join(",");

export const ShelfLifeHost = ({ excalidrawAPI: api }: LabsHostProps) => {
  const open = useLabsFeatureOpen("shelfLife");
  const [, refresh] = useState(0);
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [animation, setAnimation] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    // Wait a frame: the closing main menu restores focus on its way out.
    const frame = requestAnimationFrame(() =>
      panelRef.current?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [open]);
  useEffect(() => {
    if (!open || !api) {
      return;
    }
    const update = () => refresh((n) => n + 1);
    const unsubscribe = api.onChange(update);
    let timer: ReturnType<typeof setInterval> | undefined;
    const visible = () => {
      if (timer) {
        clearInterval(timer);
      }
      if (!document.hidden) {
        update();
        timer = setInterval(update, 60_000);
      }
    };
    visible();
    document.addEventListener("visibilitychange", visible);
    return () => {
      unsubscribe();
      if (timer) {
        clearInterval(timer);
      }
      document.removeEventListener("visibilitychange", visible);
    };
  }, [open, api]);
  if (!open || !api) {
    return null;
  }
  const elements = api.getSceneElementsIncludingDeleted();
  const state = api.getAppState();
  const readOnly = state.viewModeEnabled;
  const selected = getShelfLifeSelection(elements, state.selectedElementIds);
  const expired = getExpiredShelfLife(elements);
  const deadline = getShelfLifeDateDeadline(date);
  const values = new Set(
    selected.map((el) => getShelfLifeData(el)?.expiresAt ?? null),
  );
  const value = values.size === 1 ? [...values][0] : undefined;
  const apply = (expiresAt: number | null) => {
    if (readOnly) {
      return;
    }
    const current = api.getSceneElementsIncludingDeleted();
    const next = setShelfLifeForSelection(
      current,
      api.getAppState().selectedElementIds,
      expiresAt === null ? null : { version: 1, expiresAt, setAt: Date.now() },
    );
    if (next.some((el, i) => el !== current[i])) {
      api.updateScene({
        elements: next,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    }
  };
  const cleanup = async () => {
    if (busy || readOnly) {
      return;
    }
    setBusy(true);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const preview = getExpiredShelfLife(
          api.getSceneElementsIncludingDeleted(),
        );
        if (!preview.unlocked.length) {
          setMessage(
            t("labs.shelfLife.locked", { count: preview.locked.length }),
          );
          return;
        }
        const accepted = await confirmAction(
          `${t("labs.shelfLife.confirm", {
            count: preview.unlocked.length,
          })}\n${t("labs.shelfLife.locked", { count: preview.locked.length })}`,
          {
            title: t("labs.shelfLife.title"),
            confirmLabel: t("labs.shelfLife.tear"),
            danger: true,
          },
        );
        if (!accepted || api.isDestroyed || api.getAppState().viewModeEnabled) {
          return;
        }
        if (
          getExpiredIdentity(
            getExpiredShelfLife(api.getSceneElementsIncludingDeleted()),
          ) !== getExpiredIdentity(preview)
        ) {
          // the scene changed while confirming: never delete unconfirmed notes
          continue;
        }
        const plan = planShelfLifeCleanup(
          api.getSceneElementsIncludingDeleted(),
        );
        const selectedElementIds = Object.fromEntries(
          Object.entries(api.getAppState().selectedElementIds).filter(
            ([id]) => !plan.deletedIds.has(id),
          ),
        );
        api.updateScene({
          elements: plan.elements,
          appState: {
            selectedElementIds,
            selectedGroupIds: {},
            editingGroupId: null,
          },
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
        setMessage(
          plan.lockedCount
            ? `${t("labs.shelfLife.done", { count: plan.count })} ${t(
                "labs.shelfLife.locked",
                { count: plan.lockedCount },
              )}`
            : t("labs.shelfLife.done", { count: plan.count }),
        );
        setAnimation((n) => n + 1);
        return;
      }
    } finally {
      setBusy(false);
    }
  };
  const disabled = !selected.length || readOnly || busy;
  const presets: ShelfLifePreset[] = [
    "today",
    "week",
    "threeDays",
    "sevenDays",
  ];
  return (
    <Dialog
      title={t("labs.shelfLife.title")}
      onCloseRequest={() => closeLabsFeature("shelfLife")}
      size="small"
      // Dialog would focus the 2nd focusable (it assumes a close button);
      // focus the panel itself so Esc works even when every button is off.
      autofocus={false}
    >
      <div
        className="shelf-life"
        data-testid="shelf-life-panel"
        tabIndex={-1}
        ref={panelRef}
      >
        <p className="shelf-life__intro">{t("labs.shelfLife.description")}</p>
        <section className="shelf-life__section">
          <h3 className="shelf-life__heading">
            {t("labs.shelfLife.setTitle")}
          </h3>
          {selected.length ? (
            <p className="shelf-life__status">
              {t("labs.shelfLife.selection", { count: selected.length })}
              {" · "}
              <strong>{formatValue(value)}</strong>
            </p>
          ) : (
            <Callout tone="info" live={false}>
              {t("labs.shelfLife.noSelection")}
            </Callout>
          )}
          <div className="shelf-life__presets">
            {presets.map((preset) => (
              <UiButton
                key={preset}
                size="sm"
                disabled={disabled}
                onClick={() => apply(getShelfLifeDeadline(preset))}
              >
                {t(`labs.shelfLife.${preset}`)}
              </UiButton>
            ))}
          </div>
          <div className="shelf-life__dateRow">
            <Field label={t("labs.shelfLife.customDate")}>
              <TextInput
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                disabled={disabled}
              />
            </Field>
            <UiButton
              disabled={disabled || deadline === null}
              onClick={() => apply(deadline)}
            >
              {t("labs.shelfLife.apply")}
            </UiButton>
          </div>
          {deadline !== null && deadline <= Date.now() && (
            <Callout tone="warning">{t("labs.shelfLife.immediate")}</Callout>
          )}
          <p className="shelf-life__hint">{t("labs.shelfLife.inheritance")}</p>
          <UiButton
            variant="ghost"
            size="sm"
            disabled={disabled || value === null}
            onClick={() => apply(null)}
          >
            {t("labs.shelfLife.remove")}
          </UiButton>
        </section>
        <section className="shelf-life__section">
          <h3 className="shelf-life__heading">
            {t("labs.shelfLife.cleanupTitle")}
          </h3>
          <p className="shelf-life__status">
            {t("labs.shelfLife.expired", { count: expired.unlocked.length })}
          </p>
          {!!expired.locked.length && (
            <p className="shelf-life__hint">
              {t("labs.shelfLife.locked", { count: expired.locked.length })}
            </p>
          )}
          <UiButton
            variant="danger"
            loading={busy}
            disabled={readOnly || !expired.unlocked.length}
            onClick={cleanup}
          >
            {t("labs.shelfLife.tear")}
          </UiButton>
        </section>
        {message && (
          <div key={animation} className="shelf-life__feedback" role="status">
            <span aria-hidden="true" className="shelf-life__scraps">
              ▱ ▱ ▱
            </span>
            {message}
          </div>
        )}
      </div>
    </Dialog>
  );
};
