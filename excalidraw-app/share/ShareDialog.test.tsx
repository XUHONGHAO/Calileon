import {
  act,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { vi } from "vitest";

import { Provider, appJotaiStore } from "../app-jotai";
import { activeRoomLinkAtom } from "../collab/Collab";

import { ShareDialog, shareDialogStateAtom } from "./ShareDialog";

import type { CollabAPI } from "../collab/Collab";

const mocks = vi.hoisted(() => ({
  backend: null as any,
  signedIn: true,
  copy: vi.fn(async (_text: string) => {}),
}));

vi.mock("../data/cloud", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../data/cloud")>()),
  getCloudBackend: () => mocks.backend,
}));

vi.mock("../auth/useCloudAuth", () => ({
  useCloudAuth: () => ({ isSignedIn: mocks.signedIn }),
}));

vi.mock("@excalidraw/excalidraw/clipboard", () => ({
  copyTextToSystemClipboard: (text: string) => mocks.copy(text),
}));

vi.mock("@excalidraw/excalidraw/context/ui-appState", () => ({
  useUIAppState: () => ({ openDialog: null }),
}));

vi.mock("./QRCode", () => ({ QRCode: () => null }));

// useI18n reads the editor's isolated jotai store; the real `t` is enough.
vi.mock("@excalidraw/excalidraw/i18n", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@excalidraw/excalidraw/i18n")
  >();
  return { ...actual, useI18n: () => ({ t: actual.t, langCode: "en" }) };
});

vi.mock("@excalidraw/excalidraw/components/Dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
}));

const scene = { id: "scene-1", title: "Roadmap", version: 2, updatedAt: 2 };

const makeBackend = () => ({
  capabilities: { share: true, collabRoomBinding: true },
  encryption: { getKey: vi.fn(() => null) },
  shares: {
    listByScene: vi.fn(async () => []),
    create: vi.fn(async () => ({
      id: "share-1",
      sceneId: "scene-1",
      mode: "read",
      token: "token-1",
      revoked: false,
      expiresAt: null,
      createdAt: 0,
    })),
    revoke: vi.fn(async () => {}),
  },
  collabRooms: {
    getByScene: vi.fn(async () => null),
    createForScene: vi.fn(async () => ({ id: "collab-room-1" })),
    revoke: vi.fn(async () => {}),
  },
});

const makeCollabAPI = (overrides: Partial<CollabAPI> = {}) =>
  ({
    isCollaborating: () => false,
    startCollaboration: vi.fn(async () => null),
    stopCollaboration: vi.fn(async () => true),
    getUsername: () => "Alice",
    setUsername: vi.fn(),
    setCollabError: vi.fn(),
    getInputTargetRoomLink: () => null,
    ...overrides,
  } as unknown as CollabAPI);

const renderDialog = (
  props: Partial<React.ComponentProps<typeof ShareDialog>> = {},
) => {
  appJotaiStore.set(shareDialogStateAtom, { isOpen: true, type: "share" });
  return rtlRender(
    <Provider store={appJotaiStore}>
      <ShareDialog
        collabAPI={makeCollabAPI()}
        onExportToBackend={vi.fn()}
        activeCloudScene={scene}
        {...props}
      />
    </Provider>,
  );
};

describe("ShareDialog", () => {
  beforeEach(() => {
    mocks.backend = makeBackend();
    mocks.signedIn = true;
    mocks.copy.mockReset().mockResolvedValue(undefined);
    appJotaiStore.set(activeRoomLinkAtom, null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    appJotaiStore.set(shareDialogStateAtom, { isOpen: false });
    appJotaiStore.set(activeRoomLinkAtom, null);
  });

  it("checks the start blocker before creating a room binding", async () => {
    const onStartCollabRoom = vi.fn();
    renderDialog({
      onStartCollabRoom,
      getCollabRoomStartBlocker: () => "Remove the AI video first.",
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Start session" }),
    );

    expect(
      await screen.findByText("Remove the AI video first."),
    ).toBeInTheDocument();
    expect(mocks.backend.collabRooms.createForScene).not.toHaveBeenCalled();
    expect(onStartCollabRoom).not.toHaveBeenCalled();
  });

  it("revokes the new binding when the session fails to start", async () => {
    renderDialog({
      onStartCollabRoom: vi.fn(async () => {
        throw new Error("Room server unreachable");
      }),
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Start session" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Room server unreachable",
    );
    expect(mocks.backend.collabRooms.revoke).toHaveBeenCalledWith(
      "collab-room-1",
    );
    expect(mocks.copy).not.toHaveBeenCalled();
  });

  it("keeps a created share link and refreshes the list when copying fails", async () => {
    mocks.copy.mockRejectedValue(new Error("denied"));
    renderDialog();

    fireEvent.click(
      await screen.findByRole("button", { name: "Create read link" }),
    );

    expect(
      await screen.findByText(/The link was created but could not be copied/),
    ).toBeInTheDocument();
    expect(mocks.backend.shares.listByScene).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("explains a signed-out share card instead of disabled buttons", async () => {
    mocks.signedIn = false;
    const onSignIn = vi.fn();
    renderDialog({ onSignIn });

    expect(
      await screen.findByText(
        "Sign in to create and manage cloud share links.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create read link" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("No share links yet.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(appJotaiStore.get(shareDialogStateAtom)).toEqual({ isOpen: false });
  });

  it("shows a failed share-list load instead of an empty list", async () => {
    mocks.backend.shares.listByScene.mockRejectedValue(
      new Error("Share service is down"),
    );
    renderDialog();

    expect(
      await screen.findByText("Share service is down"),
    ).toBeInTheDocument();
    expect(screen.queryByText("No share links yet.")).not.toBeInTheDocument();
  });

  it("shows a failed room lookup instead of 'no room binding'", async () => {
    mocks.backend.collabRooms.getByScene.mockRejectedValue(
      new Error("Room lookup failed"),
    );
    renderDialog();

    expect(await screen.findByText("Room lookup failed")).toBeInTheDocument();
    expect(screen.queryByText("No room binding")).not.toBeInTheDocument();
  });

  it("starts a plain session only once on a double click", async () => {
    let finish: () => void = () => {};
    const startCollaboration = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          finish = () => resolve(null);
        }),
    );
    renderDialog({
      activeCloudScene: null,
      collabAPI: makeCollabAPI({ startCollaboration } as never),
    });

    const start = await screen.findByRole("button", { name: "Start session" });
    fireEvent.click(start);
    fireEvent.click(start);

    expect(startCollaboration).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  it("keeps the dialog open when Enter is pressed in the name field", async () => {
    appJotaiStore.set(activeRoomLinkAtom, "http://localhost/#room=abc,def");
    renderDialog();

    // The upstream TextField label isn't tied to its input.
    const name = await screen.findByPlaceholderText("Your name");
    fireEvent.keyDown(name, { key: "Enter" });

    expect(appJotaiStore.get(shareDialogStateAtom)).toEqual({
      isOpen: true,
      type: "share",
    });
  });

  it("only closes after the stop prompt is confirmed", async () => {
    appJotaiStore.set(activeRoomLinkAtom, "http://localhost/#room=abc,def");
    const stopCollaboration = vi.fn(async () => false);
    renderDialog({
      collabAPI: makeCollabAPI({
        stopCollaboration,
        // Still collaborating: the user cancelled the prompt.
        isCollaborating: () => true,
      } as never),
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Stop session" }),
    );

    await waitFor(() => expect(stopCollaboration).toHaveBeenCalledTimes(1));
    expect(appJotaiStore.get(shareDialogStateAtom)).toEqual({
      isOpen: true,
      type: "share",
    });
  });
});
