import clsx from "clsx";
import React from "react";

/**
 * Footer row for dialog actions. Put secondary buttons first and the primary
 * one last: it then sits at the far right on wide screens and on top when the
 * row stacks on phones. `leading` content (e.g. a destructive action or a
 * hint) is pushed to the far left.
 */
export const DialogActions = ({
  children,
  leading,
  className,
  align = "end",
}: {
  children: React.ReactNode;
  leading?: React.ReactNode;
  className?: string;
  align?: "end" | "between" | "stretch";
}) => (
  <div
    className={clsx("UiDialogActions", `UiDialogActions--${align}`, className)}
  >
    {leading && <div className="UiDialogActions__leading">{leading}</div>}
    <div className="UiDialogActions__main">{children}</div>
  </div>
);

/** Titled block inside a dialog or panel. */
export const DialogSection = ({
  title,
  description,
  actions,
  children,
  className,
  headingLevel = 3,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Small controls aligned with the title (e.g. "Add"). */
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  headingLevel?: 3 | 4;
}) => {
  const Heading = `h${headingLevel}` as "h3" | "h4";
  return (
    <section className={clsx("UiSection", className)}>
      {(title || actions) && (
        <div className="UiSection__header">
          {title && <Heading className="UiSection__title">{title}</Heading>}
          {actions && <div className="UiSection__actions">{actions}</div>}
        </div>
      )}
      {description && <p className="UiSection__description">{description}</p>}
      {children}
    </section>
  );
};
