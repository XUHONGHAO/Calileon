import clsx from "clsx";
import React from "react";

import { t } from "@excalidraw/excalidraw/i18n";

import {
  uiDangerIcon,
  uiInfoIcon,
  uiSuccessIcon,
  uiWarningIcon,
} from "./icons";

export type UiTone = "info" | "success" | "warning" | "danger" | "neutral";

const TONE_ICON: Record<UiTone, React.ReactNode> = {
  info: uiInfoIcon,
  success: uiSuccessIcon,
  warning: uiWarningIcon,
  danger: uiDangerIcon,
  neutral: uiInfoIcon,
};

/**
 * Inline message box. Danger callouts are announced as alerts; the others as
 * polite status updates. `details` holds technical text (error codes) that is
 * collapsed by default.
 */
export const Callout = ({
  tone = "info",
  title,
  children,
  details,
  action,
  icon,
  className,
  live = true,
}: {
  tone?: UiTone;
  title?: React.ReactNode;
  children?: React.ReactNode;
  details?: React.ReactNode;
  action?: React.ReactNode;
  /** `false` hides the icon. */
  icon?: React.ReactNode | false;
  className?: string;
  /** Set to false for static explanatory boxes that should not be announced. */
  live?: boolean;
}) => (
  <div
    className={clsx("UiCallout", `UiCallout--${tone}`, className)}
    role={live ? (tone === "danger" ? "alert" : "status") : undefined}
  >
    {icon !== false && (
      <span className="UiCallout__icon" aria-hidden="true">
        {icon ?? TONE_ICON[tone]}
      </span>
    )}
    <div className="UiCallout__body">
      {title && <p className="UiCallout__title">{title}</p>}
      {children && <div className="UiCallout__text">{children}</div>}
      {details && (
        <details className="UiCallout__details">
          <summary>{t("ui.details")}</summary>
          <code>{details}</code>
        </details>
      )}
    </div>
    {action && <div className="UiCallout__action">{action}</div>}
  </div>
);

/** Small pill label ("Current", "Revoked", "Beta"...). */
export const Badge = ({
  tone = "neutral",
  children,
  className,
}: {
  tone?: UiTone;
  children: React.ReactNode;
  className?: string;
}) => (
  <span className={clsx("UiBadge", `UiBadge--${tone}`, className)}>
    {children}
  </span>
);

/**
 * Compact status indicator for toolbars. With `compact` only the dot/icon is
 * shown and the label moves to the tooltip / accessible name.
 */
export const StatusPill = ({
  tone = "neutral",
  label,
  detail,
  icon,
  compact = false,
  action,
  className,
  title,
}: {
  tone?: UiTone;
  label: string;
  detail?: string;
  icon?: React.ReactNode;
  compact?: boolean;
  action?: React.ReactNode;
  className?: string;
  title?: string;
}) => {
  const accessibleName = detail ? `${label} · ${detail}` : label;
  return (
    <span
      className={clsx(
        "UiStatusPill",
        `UiStatusPill--${tone}`,
        { "UiStatusPill--compact": compact },
        className,
      )}
      role="status"
      title={title ?? (compact ? accessibleName : undefined)}
      aria-label={compact ? accessibleName : undefined}
    >
      <span className="UiStatusPill__mark" aria-hidden="true">
        {icon ?? <span className="UiStatusPill__dot" />}
      </span>
      {!compact && (
        <span className="UiStatusPill__text">
          <span className="UiStatusPill__label">{label}</span>
          {detail && <span className="UiStatusPill__detail">{detail}</span>}
        </span>
      )}
      {!compact && action}
    </span>
  );
};
