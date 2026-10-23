import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { t } from "@excalidraw/excalidraw/i18n";

import {
  addDays,
  composeDeadline,
  DeadlinePicker,
  getMonthGrid,
  splitDeadline,
  startOfDay,
} from "./DeadlinePicker";

describe("deadline math", () => {
  const day = new Date(2026, 9, 28).getTime();

  it("round-trips whole days and exact times", () => {
    const whole = composeDeadline(day, true, 0);
    expect(whole).toBe(new Date(2026, 9, 29).getTime());
    expect(splitDeadline(whole)).toMatchObject({ day, allDay: true });

    const timed = composeDeadline(day, false, 14 * 60 + 30);
    expect(timed).toBe(new Date(2026, 9, 28, 14, 30).getTime());
    expect(splitDeadline(timed)).toEqual({
      day,
      allDay: false,
      minutes: 14 * 60 + 30,
    });
  });

  it("builds six local weeks from the locale's first weekday", () => {
    const grid = getMonthGrid(day, 1);
    // Constant six weeks, even for a 4-week February.
    expect(grid).toHaveLength(42);
    expect(getMonthGrid(new Date(2026, 1, 1).getTime(), 0)).toHaveLength(42);
    expect(new Date(grid[0]).getDay()).toBe(1);
    expect(grid).toContain(new Date(2026, 9, 1).getTime());
    // Calendar steps, not 24h steps: every cell is a local midnight.
    expect(grid.every((d) => startOfDay(d) === d)).toBe(true);
    expect(addDays(day, 7)).toBe(new Date(2026, 10, 4).getTime());
  });
});

describe("DeadlinePicker", () => {
  const setup = () => {
    const onApply = vi.fn();
    const onDialogKey = vi.fn();
    render(
      <div className="excalidraw" onKeyDown={onDialogKey}>
        <DeadlinePicker
          value={null}
          display="pick"
          onApply={onApply}
          aria-describedby="x"
        />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "pick" }));
    const picker = screen.getByRole("dialog", {
      name: t("labs.shelfLife.pickerTitle"),
    });
    return { onApply, onDialogKey, picker };
  };

  it("picks a later day with the keyboard and applies a whole day", () => {
    const { onApply, picker } = setup();
    const today = startOfDay(Date.now());
    const cursor = picker.querySelector<HTMLButtonElement>(
      ".shelf-life-picker__day[tabindex='0']",
    )!;
    fireEvent.keyDown(cursor, { key: "ArrowRight" });
    // The roving stop moved to tomorrow; past days are disabled.
    const tomorrow = new Date(addDays(today, 1)).getDate();
    const next = picker.querySelector<HTMLButtonElement>(
      ".shelf-life-picker__day[tabindex='0']",
    )!;
    expect(next.textContent).toBe(`${tomorrow}`);
    fireEvent.click(next);
    fireEvent.click(
      within(picker).getByRole("button", { name: t("labs.shelfLife.apply") }),
    );
    expect(onApply).toHaveBeenCalledWith(addDays(today, 2));
  });

  it("applies an exact time from the quick chips", () => {
    const { onApply, picker } = setup();
    fireEvent.click(
      within(picker).getByRole("radio", { name: t("labs.shelfLife.atTime") }),
    );
    fireEvent.click(within(picker).getByRole("button", { name: "21:00" }));
    fireEvent.click(
      within(picker).getByRole("button", { name: t("labs.shelfLife.apply") }),
    );
    const at = new Date(onApply.mock.calls[0][0]);
    expect([at.getHours(), at.getMinutes()]).toEqual([21, 0]);
  });

  it("closes on Escape without closing the surrounding dialog", () => {
    const { onApply, onDialogKey, picker } = setup();
    fireEvent.keyDown(picker, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: t("labs.shelfLife.pickerTitle") }),
    ).toBeNull();
    expect(onDialogKey).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "pick" }),
    );
  });
});
