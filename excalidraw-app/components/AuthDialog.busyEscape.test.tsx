import { Excalidraw } from "@excalidraw/excalidraw";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@excalidraw/excalidraw/tests/test-utils";
import React from "react";
import { vi } from "vitest";

import { Provider, appJotaiStore } from "../app-jotai";
import { __resetCloudAuthForTests } from "../auth/useCloudAuth";

import { AuthDialog } from "./AuthDialog";

// 71ae#8: the editor Dialog moved focus back to the page *before* asking to
// close, so Escape on a busy dialog left it open with focus behind it. This
// runs against the real editor Dialog (no mock) to cover AppDialog's guard.

let mockBackend: any;

vi.mock("../data/cloud", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../data/cloud")>()),
  getCloudBackend: () => mockBackend,
}));

describe("AuthDialog busy Escape (real Dialog)", () => {
  beforeEach(() => {
    __resetCloudAuthForTests();
    mockBackend = {
      capabilities: { auth: true },
      auth: {
        getCurrentUser: vi.fn(async () => null),
        // Never settles: the dialog stays busy.
        signIn: vi.fn(() => new Promise(() => {})),
        signOut: vi.fn(),
        onAuthStateChange: vi.fn(() => () => {}),
      },
    };
  });

  it("stays open and keeps focus inside while signing in", async () => {
    const onClose = vi.fn();
    await render(
      <Provider store={appJotaiStore}>
        <Excalidraw>
          <AuthDialog open={true} onClose={onClose} />
        </Excalidraw>
      </Provider>,
    );

    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "secret123" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    });
    await waitFor(() => expect(screen.getByLabelText("Email")).toBeDisabled());

    const dialog = screen.getByRole("dialog");
    // With every control disabled, the dialog surface holds focus.
    const surface = dialog.querySelector<HTMLElement>(".AppDialog__surface")!;
    surface.focus();
    fireEvent.keyDown(surface, { key: "Escape" });
    // Escape from inside the content as well.
    fireEvent.keyDown(screen.getByLabelText("Email"), { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
