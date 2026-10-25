import { Excalidraw } from "@excalidraw/excalidraw";
import {
  fireEvent,
  render,
  screen,
} from "@excalidraw/excalidraw/tests/test-utils";
import React from "react";

import CollabError from "./CollabError";

describe("CollabError", () => {
  it("is a focusable button named by the error that opens the full message", async () => {
    await render(
      <Excalidraw>
        <CollabError
          collabError={{ message: "Couldn't save to the room.", nonce: 1 }}
        />
      </Excalidraw>,
    );

    const button = await screen.findByRole("button", {
      name: "Couldn't save to the room.",
    });
    button.focus();
    expect(button).toHaveFocus();

    fireEvent.click(button);

    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Couldn't save to the room.",
    );
  });

  it("renders nothing without an error", async () => {
    await render(
      <Excalidraw>
        <CollabError collabError={{ message: null, nonce: 0 }} />
      </Excalidraw>,
    );
    expect(
      document.querySelector(".collab-errors-button"),
    ).not.toBeInTheDocument();
  });
});
