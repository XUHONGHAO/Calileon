import { fireEvent, render, screen, within } from "@testing-library/react";
import React, { useState } from "react";
import { vi } from "vitest";

import { Select } from "./Select";

const Controlled = ({
  onChange,
  initial = "b",
}: {
  onChange?: (value: string) => void;
  initial?: string;
}) => {
  const [value, setValue] = useState(initial);
  return (
    <div className="excalidraw">
      <label htmlFor="fruit">Fruit</label>
      <Select
        id="fruit"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          onChange?.(event.target.value);
        }}
      >
        <option value="a">Apple</option>
        <>
          <option value="b">Banana</option>
          {["c"].map((v) => (
            <option key={v} value={v}>
              Cherry
            </option>
          ))}
        </>
        <option value="d" disabled>
          Durian
        </option>
      </Select>
    </div>
  );
};

describe("Select", () => {
  it("is a labelled combobox showing the selected option", () => {
    render(<Controlled />);
    const trigger = screen.getByLabelText("Fruit");
    expect(trigger).toHaveAttribute("role", "combobox");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveTextContent("Banana");
    expect(trigger).toHaveAttribute("data-value", "b");
  });

  it("opens a listbox with every option, nested ones included", () => {
    render(<Controlled />);
    fireEvent.click(screen.getByLabelText("Fruit"));
    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Apple",
      "Banana",
      "Cherry",
      "Durian",
    ]);
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(options[3]).toHaveAttribute("aria-disabled", "true");
  });

  it("selects by click with a native-like change event", () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Fruit"));
    fireEvent.click(screen.getByRole("option", { name: "Cherry" }));
    expect(onChange).toHaveBeenCalledWith("c");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByLabelText("Fruit")).toHaveTextContent("Cherry");
  });

  it("ignores disabled options and does not re-fire for the current value", () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Fruit"));
    fireEvent.click(screen.getByRole("option", { name: "Durian" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option", { name: "Banana" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("supports keyboard navigation, skipping disabled options", () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    const trigger = screen.getByLabelText("Fruit");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    // Opens on the selected option (Banana), then moves.
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" }); // Durian is skipped
    const active = trigger.getAttribute("aria-activedescendant");
    expect(document.getElementById(active!)).toHaveTextContent("Cherry");
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("c");
  });

  it("closes on Escape without letting it reach a surrounding dialog", () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <Controlled />
      </div>,
    );
    const trigger = screen.getByLabelText("Fruit");
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(outer).not.toHaveBeenCalled();
  });

  it("selects by typeahead while closed", () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    fireEvent.keyDown(screen.getByLabelText("Fruit"), { key: "a" });
    expect(onChange).toHaveBeenCalledWith("a");
  });

  it("shows <option title> as the option tooltip and on the trigger", () => {
    render(
      <div className="excalidraw">
        <label htmlFor="model">Model</label>
        <Select id="model" value="a" onChange={() => {}}>
          <option value="a" title="cheap, 1K only">
            fast
          </option>
          <option value="b">pro</option>
        </Select>
      </div>,
    );
    const trigger = screen.getByLabelText("Model");
    expect(trigger).toHaveAttribute("title", "fast\ncheap, 1K only");

    fireEvent.click(trigger);
    const [fast, pro] = within(screen.getByRole("listbox")).getAllByRole(
      "option",
    );
    expect(fast).toHaveAttribute("title", "cheap, 1K only");
    expect(pro).not.toHaveAttribute("title");
  });

  it("shows the placeholder and an empty hint without options", () => {
    render(
      <div className="excalidraw">
        <Select
          aria-label="Model"
          value=""
          placeholder="No model"
          emptyText="Add a model first"
        />
      </div>,
    );
    const trigger = screen.getByRole("combobox", { name: "Model" });
    expect(trigger).toHaveTextContent("No model");
    fireEvent.click(trigger);
    expect(screen.getByRole("listbox")).toHaveTextContent("Add a model first");
  });
});
