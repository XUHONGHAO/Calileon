import { Excalidraw } from "@excalidraw/excalidraw";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@excalidraw/excalidraw/tests/test-utils";
import React, { useState } from "react";
import { vi } from "vitest";

import { AppDialog } from "./AppDialog";

const Harness = ({
  busy = false,
  onBeforeClose,
  onClose = vi.fn(),
}: {
  busy?: boolean;
  onBeforeClose?: () => boolean | Promise<boolean>;
  onClose?: () => void;
}) => {
  const [open, setOpen] = useState(true);
  return (
    <Excalidraw>
      {open && (
        <AppDialog
          title="Settings"
          busy={busy}
          onBeforeClose={onBeforeClose}
          onCloseRequest={() => {
            onClose();
            setOpen(false);
          }}
        >
          <button type="button">Inside</button>
        </AppDialog>
      )}
    </Excalidraw>
  );
};

describe("AppDialog", () => {
  it("renders a close button and closes through it", async () => {
    const onClose = vi.fn();
    await render(<Harness onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape from inside the content", async () => {
    const onClose = vi.fn();
    await render(<Harness onClose={onClose} />);
    fireEvent.keyDown(await screen.findByRole("button", { name: "Inside" }), {
      key: "Escape",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open while busy", async () => {
    const onClose = vi.fn();
    await render(<Harness busy onClose={onClose} />);
    const close = await screen.findByRole("button", { name: "Close" });
    expect(close).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("button", { name: "Inside" }), {
      key: "Escape",
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("lets onBeforeClose veto the close", async () => {
    const onClose = vi.fn();
    const onBeforeClose = vi.fn().mockResolvedValue(false);
    await render(<Harness onBeforeClose={onBeforeClose} onClose={onClose} />);
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    });
    expect(onBeforeClose).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("is named by its title", async () => {
    await render(<Harness />);
    expect(
      await screen.findByRole("dialog", { name: "Settings" }),
    ).toBeInTheDocument();
  });

  it("takes ariaLabel as its name when it has no visible title", async () => {
    await render(
      <Excalidraw>
        <AppDialog title={false} ariaLabel="Share" onCloseRequest={vi.fn()}>
          <p>Body</p>
        </AppDialog>
      </Excalidraw>,
    );
    expect(
      await screen.findByRole("dialog", { name: "Share" }),
    ).toBeInTheDocument();
  });

  it("focuses the dialog surface, not a control, on open", async () => {
    await render(<Harness />);
    await screen.findByRole("button", { name: "Inside" });
    await waitFor(() =>
      expect(document.activeElement).toHaveClass("AppDialog__surface"),
    );
  });
});
