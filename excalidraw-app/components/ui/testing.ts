import { fireEvent, screen, within } from "@testing-library/react";

/**
 * Test helper for the app `Select` (a combobox button plus a portalled
 * listbox, not a native `<select>`): open it and click the option with the
 * given accessible name.
 */
export const chooseSelectOption = (
  trigger: HTMLElement,
  optionName: string | RegExp,
) => {
  if (trigger.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(trigger);
  }
  const listbox = screen.getByRole("listbox");
  fireEvent.click(within(listbox).getByRole("option", { name: optionName }));
};

/** Visible option labels of an app `Select`, in order. Leaves it closed. */
export const getSelectOptionLabels = (trigger: HTMLElement) => {
  fireEvent.click(trigger);
  const labels = within(screen.getByRole("listbox"))
    .getAllByRole("option")
    .map((option) => option.textContent?.trim() ?? "");
  fireEvent.keyDown(trigger, { key: "Escape" });
  return labels;
};
