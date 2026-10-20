import clsx from "clsx";
import React, { forwardRef } from "react";

import Spinner from "@excalidraw/excalidraw/components/Spinner";

export type UiButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type UiButtonSize = "sm" | "md" | "lg";

export type UiButtonProps = Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "type"
> & {
  /** "submit" keeps native form submission (Enter in a field). */
  type?: "button" | "submit" | "reset";
  variant?: UiButtonVariant;
  size?: UiButtonSize;
  icon?: React.ReactNode;
  /** Square icon-only button; pass `aria-label`. */
  iconOnly?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
};

/**
 * App text/icon button. Unlike the editor's `Button` it sizes to its label on
 * every form factor (the editor's mobile rule forces icon-button squares).
 */
export const UiButton = forwardRef<HTMLButtonElement, UiButtonProps>(
  (
    {
      type = "button",
      variant = "secondary",
      size = "md",
      icon,
      iconOnly = false,
      loading = false,
      fullWidth = false,
      disabled,
      className,
      children,
      ...rest
    },
    ref,
  ) => (
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(
        "UiButton",
        `UiButton--${variant}`,
        `UiButton--${size}`,
        {
          "UiButton--iconOnly": iconOnly,
          "UiButton--fullWidth": fullWidth,
          "UiButton--loading": loading,
        },
        className,
      )}
    >
      {loading ? (
        <span className="UiButton__icon" aria-hidden="true">
          <Spinner />
        </span>
      ) : (
        icon && (
          <span className="UiButton__icon" aria-hidden="true">
            {icon}
          </span>
        )
      )}
      {!iconOnly && children != null && (
        <span className="UiButton__label">{children}</span>
      )}
    </button>
  ),
);
UiButton.displayName = "UiButton";
