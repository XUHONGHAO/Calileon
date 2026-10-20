import clsx from "clsx";
import React, { forwardRef, useId } from "react";

type FieldControlProps = {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: React.AriaAttributes["aria-invalid"];
};

/**
 * Label + control + hint/error. The single child control receives `id`,
 * `aria-describedby` and `aria-invalid`, so any input/select/textarea works
 * (the editor's TextField only accepts text/search).
 */
export const Field = ({
  label,
  hint,
  error,
  children,
  className,
  inline = false,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  children: React.ReactElement<FieldControlProps>;
  className?: string;
  /** Label and control on one row (checkboxes, switches, short selects). */
  inline?: boolean;
}) => {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy =
    [children.props["aria-describedby"], hintId, errorId]
      .filter(Boolean)
      .join(" ") || undefined;
  const control = React.cloneElement(children, {
    id: children.props.id ?? id,
    "aria-describedby": describedBy,
    "aria-invalid": error ? true : children.props["aria-invalid"],
  });
  return (
    <div className={clsx("UiField", { "UiField--inline": inline }, className)}>
      <label className="UiField__label" htmlFor={children.props.id ?? id}>
        {label}
      </label>
      {control}
      {hint && (
        <p className="UiField__hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="UiField__error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
};

export const TextInput = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...rest }, ref) => (
  <input ref={ref} {...rest} className={clsx("UiInput", className)} />
));
TextInput.displayName = "TextInput";

export const TextArea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...rest }, ref) => (
  <textarea
    ref={ref}
    {...rest}
    className={clsx("UiInput", "UiInput--textarea", className)}
  />
));
TextArea.displayName = "TextArea";

export const Select = forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...rest }, ref) => (
  <select
    ref={ref}
    {...rest}
    className={clsx("UiInput", "UiInput--select", className)}
  />
));
Select.displayName = "Select";
