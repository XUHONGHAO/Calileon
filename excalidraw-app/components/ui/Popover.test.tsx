import { act, fireEvent, render, screen } from "@testing-library/react";
import React, { useRef, useState } from "react";
import { vi } from "vitest";

import { Popover } from "./Popover";

const MenuHarness = ({ onPick = vi.fn() }: { onPick?: () => void }) => {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="excalidraw">
      <button
        ref={anchorRef}
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Agent
      </button>
      <button type="button">Elsewhere</button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        role="menu"
        aria-label="Agents"
      >
        <button type="button" role="menuitemradio" aria-checked={false}>
          First
        </button>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={true}
          onClick={() => {
            onPick();
            setOpen(false);
          }}
        >
          Second
        </button>
        <button type="button" role="menuitemradio" aria-checked={false}>
          Third
        </button>
      </Popover>
    </div>
  );
};

const DialogHarness = () => {
  const [open, setOpen] = useState(true);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  return (
    <div className="excalidraw">
      <button ref={anchorRef} type="button">
        History
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        role="dialog"
        aria-label="Recent chats"
        initialFocusRef={searchRef}
      >
        <input ref={searchRef} aria-label="Search" />
        <button type="button">Chat</button>
      </Popover>
    </div>
  );
};

const flushFrames = () =>
  act(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve(undefined)),
      ),
  );

describe("Popover", () => {
  it("opens a labelled menu and focuses the checked item", () => {
    render(<MenuHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    const menu = screen.getByRole("menu", { name: "Agents" });
    expect(menu).toHaveClass("UiPopover");
    expect(document.activeElement).toBe(
      screen.getByRole("menuitemradio", { name: "Second" }),
    );
  });

  it("moves between items with the arrow keys and wraps", () => {
    render(<MenuHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toHaveTextContent("Third");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toHaveTextContent("First");
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toHaveTextContent("Third");
  });

  it("closes on Escape without letting it bubble, and refocuses the anchor", () => {
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    try {
      render(<MenuHarness />);
      const anchor = screen.getByRole("button", { name: "Agent" });
      fireEvent.click(anchor);
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(document.activeElement).toBe(anchor);
      expect(outer).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", outer);
    }
  });

  it("closes on an outside pointerdown but not on the anchor itself", () => {
    render(<MenuHarness />);
    const anchor = screen.getByRole("button", { name: "Agent" });
    fireEvent.click(anchor);
    fireEvent.pointerDown(anchor);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("returns focus to the anchor when a picked item closes the menu", async () => {
    const onPick = vi.fn();
    render(<MenuHarness onPick={onPick} />);
    const anchor = screen.getByRole("button", { name: "Agent" });
    fireEvent.click(anchor);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Second" }));
    expect(onPick).toHaveBeenCalled();
    await flushFrames();
    expect(document.activeElement).toBe(anchor);
  });

  it("focuses the dialog's initial target and closes when tabbing past the end", () => {
    render(<DialogHarness />);
    const search = screen.getByRole("textbox", { name: "Search" });
    expect(document.activeElement).toBe(search);
    // Tab inside the popup is left to the browser.
    fireEvent.keyDown(search, { key: "Tab" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const chat = screen.getByRole("button", { name: "Chat" });
    chat.focus();
    fireEvent.keyDown(chat, { key: "Tab" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "History" }),
    );
  });
});
