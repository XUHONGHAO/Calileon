import {
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { vi } from "vitest";

import { Provider, appJotaiStore } from "../app-jotai";
import { __resetCloudAuthForTests } from "../auth/useCloudAuth";

import { AuthDialog } from "./AuthDialog";

import type { AuthDialogProps } from "./AuthDialog";

let mockBackend: any;

vi.mock("../data/cloud", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../data/cloud")>()),
  getCloudBackend: () => mockBackend,
}));

// Same passthrough as CloudAuthButton.test: the editor Dialog needs the
// whole editor context; the flows under test live in AuthDialog itself.
vi.mock("@excalidraw/excalidraw/components/Dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
}));

const user = {
  id: "u1",
  email: "me@example.com",
  displayName: null,
  avatarUrl: null,
  createdAt: 0,
  lastSignInAt: null,
};

const makeBackend = () => ({
  capabilities: {
    auth: true,
    sceneStorage: true,
    aiTasks: true,
    cast: false,
    embed: false,
    collabPersistence: true,
    collabRoomBinding: true,
    encryptedCloudStorage: false,
  },
  auth: {
    getCurrentUser: vi.fn(async () => user),
    signIn: vi.fn(),
    signOut: vi.fn(async () => {}),
    onAuthStateChange: vi.fn(() => () => {}),
  },
  scenes: { list: vi.fn(async () => []) },
  aiTasks: { list: vi.fn(async () => []) },
  collabRooms: {
    getByScene: vi.fn(async () => null),
    createForScene: vi.fn(async ({ sceneId, roomId }: any) => ({
      id: "collab-room-1",
      ownerId: "u1",
      sceneId,
      roomId,
      status: "active",
      createdAt: 0,
      updatedAt: 0,
      revokedAt: null,
    })),
    revoke: vi.fn(async () => {}),
  },
  encryption: { isAvailable: vi.fn(() => false) },
});

const scene = { id: "scene-1", title: "Roadmap", version: 2, updatedAt: 2 };

const renderDialog = (props: Partial<AuthDialogProps> = {}) =>
  rtlRender(
    <Provider store={appJotaiStore}>
      <AuthDialog
        open={true}
        onClose={vi.fn()}
        activeCloudScene={scene}
        {...props}
      />
    </Provider>,
  );

const openWhiteboardTab = async () =>
  fireEvent.click(await screen.findByRole("tab", { name: "This whiteboard" }));

const clickCreateRoom = async () => {
  await openWhiteboardTab();
  fireEvent.click(
    await screen.findByRole("button", { name: "Create room link" }),
  );
};

describe("AuthDialog cloud flows", () => {
  beforeEach(() => {
    __resetCloudAuthForTests();
    mockBackend = makeBackend();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("checks the start blocker before creating a room binding", async () => {
    const onStartCollabRoom = vi.fn();
    renderDialog({
      onStartCollabRoom,
      getCollabRoomStartBlocker: () => "Stop the live session first.",
    });

    await clickCreateRoom();

    expect(
      await screen.findByText("Stop the live session first."),
    ).toBeInTheDocument();
    expect(mockBackend.collabRooms.createForScene).not.toHaveBeenCalled();
    expect(onStartCollabRoom).not.toHaveBeenCalled();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("revokes the new binding when the session fails to start", async () => {
    const onCollabRoomChanged = vi.fn();
    renderDialog({
      onCollabRoomChanged,
      onStartCollabRoom: vi.fn(async () => {
        throw new Error("Room server unreachable");
      }),
    });

    await clickCreateRoom();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Room server unreachable",
    );
    expect(mockBackend.collabRooms.revoke).toHaveBeenCalledWith(
      "collab-room-1",
    );
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(onCollabRoomChanged).not.toHaveBeenCalled();
  });

  it("treats a clipboard failure after create as created, and still refreshes", async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValue(
      new Error("denied"),
    );
    const onCollabRoomChanged = vi.fn();
    renderDialog({ onStartCollabRoom: vi.fn(), onCollabRoomChanged });

    await clickCreateRoom();

    expect(
      await screen.findByText(/the link could not be copied/),
    ).toBeInTheDocument();
    await waitFor(() => expect(onCollabRoomChanged).toHaveBeenCalledTimes(1));
    expect(mockBackend.collabRooms.revoke).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a failed save inside the dialog", async () => {
    renderDialog({
      onSaveCloudScene: vi.fn(async () => {
        throw new Error("Cloud save failed. Local data is preserved.");
      }),
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Save to cloud" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Cloud save failed. Local data is preserved.",
    );
  });

  it("groups the panel into account, whiteboard and deployment tabs", async () => {
    renderDialog();

    const accountTab = await screen.findByRole("tab", { name: "Account" });
    expect(accountTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("me@example.com")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sign out" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Save AI settings to my account" }),
    ).toBeDisabled();
    expect(screen.getByText("Not enabled on this deployment.")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Create room link" }),
    ).toBeNull();

    await openWhiteboardTab();
    expect(
      screen.getByRole("tabpanel", { name: "This whiteboard" }),
    ).toHaveTextContent("Roadmap");

    fireEvent.click(screen.getByRole("tab", { name: "Deployment" }));
    expect(
      screen.getByRole("tabpanel", { name: "Deployment" }),
    ).toHaveTextContent("Supabase");
    // the sign-out header and save footer stay on every tab
    expect(
      screen.getByRole("button", { name: "Sign out" }),
    ).toBeInTheDocument();
  });

  it("explains the whiteboard tab when the canvas isn't a cloud whiteboard", async () => {
    renderDialog({ activeCloudScene: null });
    await openWhiteboardTab();
    expect(
      screen.getByText(/isn't saved to your account yet/),
    ).toBeInTheDocument();
  });

  it("explains why saving is disabled during live collaboration", async () => {
    renderDialog({ onSaveCloudScene: vi.fn(), isCollaborationActive: true });

    const save = await screen.findByRole("button", { name: "Save to cloud" });
    expect(save).toBeDisabled();
    expect(save).toHaveAccessibleDescription(
      "Cloud save is paused during live collaboration.",
    );
  });
});
