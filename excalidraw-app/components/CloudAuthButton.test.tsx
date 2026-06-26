import {
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import React from "react";
import { vi } from "vitest";

import { Provider, appJotaiStore } from "../app-jotai";
import { BackendError } from "../data/cloud";

import { __resetCloudAuthForTests } from "../auth/useCloudAuth";

import { CloudAuthButton } from "./CloudAuthButton";

// The app wires jotai to `appJotaiStore`; the hook writes there too. Mirror
// that in tests so `useAtom` reads the same store the hook updates.
const render = (ui: React.ReactElement) =>
  rtlRender(<Provider store={appJotaiStore}>{ui}</Provider>);

// —— Mock the frozen CloudBackend contract (never Supabase directly) ——
// Each test rebuilds the backend shape via `setBackend`.
let mockBackend: any;
const setBackend = (backend: any) => {
  mockBackend = backend;
};

vi.mock("../data/cloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/cloud")>();
  return {
    ...actual,
    getCloudBackend: () => mockBackend,
  };
});

// The editor `Dialog` is tightly coupled to the Excalidraw editor context
// (isolated jotai scope + appState). For a focused auth-flow test we stub it
// with a minimal passthrough; the dialog's own plumbing is covered upstream.
vi.mock("@excalidraw/excalidraw/components/Dialog", () => ({
  Dialog: ({
    children,
    title,
  }: {
    children: React.ReactNode;
    title: React.ReactNode;
  }) => (
    <div
      role="dialog"
      aria-label={typeof title === "string" ? title : undefined}
    >
      {children}
    </div>
  ),
}));

const makeBackend = (
  overrides: {
    auth?: boolean;
    currentUser?: any;
    signIn?: (m: any) => Promise<any>;
    signOut?: () => Promise<void>;
    sceneSummaries?: any[];
    aiTasks?: any[];
    cast?: boolean;
    castSessions?: any[];
    castExports?: any[];
    embed?: boolean;
    embeds?: any[];
    collabRoomBinding?: boolean;
    collabRoom?: any;
    encryptedCloudStorage?: boolean;
  } = {},
) => {
  const listeners: Array<(u: any) => void> = [];
  return {
    capabilities: {
      auth: overrides.auth ?? true,
      sceneStorage: true,
      aiTasks: true,
      cast: overrides.cast ?? true,
      embed: overrides.embed ?? true,
      collabPersistence: true,
      collabRoomBinding: overrides.collabRoomBinding ?? true,
      encryptedCloudStorage: overrides.encryptedCloudStorage ?? false,
    },
    auth: {
      getCurrentUser: vi.fn(async () => overrides.currentUser ?? null),
      signIn:
        overrides.signIn ??
        vi.fn(async () => ({
          id: "u1",
          email: "user@example.com",
          displayName: null,
          avatarUrl: null,
          createdAt: 0,
          lastSignInAt: null,
        })),
      signOut: overrides.signOut ?? vi.fn(async () => {}),
      onAuthStateChange: vi.fn((cb: (u: any) => void) => {
        listeners.push(cb);
        return () => {};
      }),
    },
    scenes: {
      list: vi.fn(
        async () =>
          overrides.sceneSummaries ?? [
            {
              id: "scene-1",
              title: "Roadmap",
              version: 2,
              updatedAt: 2,
            },
          ],
      ),
    },
    aiTasks: {
      list: vi.fn(async () => overrides.aiTasks ?? []),
    },
    cast: {
      listByScene: vi.fn(async () => overrides.castSessions ?? []),
      listExportsByScene: vi.fn(async () => overrides.castExports ?? []),
    },
    embed: {
      listByScene: vi.fn(async () => overrides.embeds ?? []),
    },
    collabRooms: {
      getByScene: vi.fn(async () => overrides.collabRoom ?? null),
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
      touch: vi.fn(async () => overrides.collabRoom),
    },
    encryption: {
      isAvailable: vi.fn(() => overrides.encryptedCloudStorage ?? false),
      removeKey: vi.fn(),
    },
    __emit: (u: any) => listeners.forEach((l) => l(u)),
  };
};

describe("CloudAuthButton (standalone cloud auth entry)", () => {
  beforeEach(() => {
    __resetCloudAuthForTests();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(async () => {}),
      },
    });
  });

  it("renders nothing in pure-local mode (auth capability false)", async () => {
    setBackend(makeBackend({ auth: false }));
    const { container } = render(<CloudAuthButton />);
    // Local mode settles synchronously to signed-out, but the entry is hidden.
    await waitFor(() => {
      expect(container.querySelector(".CloudAuthButton")).toBeNull();
    });
    expect(screen.queryByText("Cloud sign in")).not.toBeInTheDocument();
  });

  it("shows a sign-in trigger when signed out", async () => {
    setBackend(makeBackend({ auth: true, currentUser: null }));
    render(<CloudAuthButton />);
    expect(await screen.findByText("Cloud sign in")).toBeInTheDocument();
  });

  it("opens the dialog and signs in via email + password", async () => {
    const signIn = vi.fn(async () => ({
      id: "u1",
      email: "user@example.com",
      displayName: null,
      avatarUrl: null,
      createdAt: 0,
      lastSignInAt: null,
    }));
    setBackend(makeBackend({ auth: true, currentUser: null, signIn }));
    const onSignedIn = vi.fn();
    const onOpenCloudScenes = vi.fn();
    const onOpenAITasks = vi.fn();
    render(
      <CloudAuthButton
        onSignedIn={onSignedIn}
        onOpenCloudScenes={onOpenCloudScenes}
        onOpenAITasks={onOpenAITasks}
      />,
    );

    fireEvent.click(await screen.findByText("Cloud sign in"));

    const email = await screen.findByLabelText("Email");
    const password = screen.getByLabelText("Password");
    fireEvent.change(email, { target: { value: "user@example.com" } });
    fireEvent.change(password, { target: { value: "secret123" } });

    const form = email.closest("form")!;
    fireEvent.click(within(form).getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(signIn).toHaveBeenCalledWith({
        kind: "password",
        email: "user@example.com",
        password: "secret123",
      });
    });
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    // After sign-in the entry flips to the account trigger. Identity and
    // sign-out are shown only inside the account dialog.
    const accountButton = await screen.findByRole("button", {
      name: "Cloud account",
    });
    expect(screen.queryByText("user@example.com")).not.toBeInTheDocument();

    fireEvent.click(accountButton);

    expect(await screen.findByText("user@example.com")).toBeInTheDocument();
    expect(await screen.findByText("1 saved")).toBeInTheDocument();
    expect(screen.getByText("Latest: Roadmap")).toBeInTheDocument();
    expect(screen.queryByText("Close")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sign out" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Cloud whiteboards/ }));
    expect(onOpenCloudScenes).toHaveBeenCalledTimes(1);
  });

  it("surfaces the sanitized BackendError message on failure", async () => {
    const signIn = vi.fn(async () => {
      throw new BackendError("unauthorized", "邮箱或密码错误", {
        nextAction: "重新登录",
      });
    });
    setBackend(makeBackend({ auth: true, currentUser: null, signIn }));
    render(<CloudAuthButton />);

    fireEvent.click(await screen.findByText("Cloud sign in"));
    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "wrong" },
    });
    const form = screen.getByLabelText("Password").closest("form")!;
    fireEvent.click(within(form).getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "邮箱或密码错误",
    );
  });

  it("shows account details in the dialog when already signed in, and signs out", async () => {
    const signOut = vi.fn(async () => {});
    const onSaveCloudScene = vi.fn(async () => {});
    const onOpenAITasks = vi.fn();
    const sceneSummaries = [
      {
        id: "scene-1",
        title: "Roadmap",
        version: 2,
        updatedAt: 2,
      },
    ];
    setBackend(
      makeBackend({
        auth: true,
        currentUser: {
          id: "u1",
          email: "me@example.com",
          displayName: null,
          avatarUrl: null,
          createdAt: 0,
          lastSignInAt: null,
        },
        signOut,
        sceneSummaries,
        aiTasks: [
          {
            id: "task-1",
            status: "succeeded",
          },
        ],
      }),
    );
    render(
      <CloudAuthButton
        onSaveCloudScene={onSaveCloudScene}
        onOpenAITasks={onOpenAITasks}
      />,
    );

    const accountButton = await screen.findByRole("button", {
      name: "Cloud account",
    });
    expect(screen.queryByText("me@example.com")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Cloud sign out" }),
    ).not.toBeInTheDocument();

    fireEvent.click(accountButton);

    expect(await screen.findByText("me@example.com")).toBeInTheDocument();
    expect(await screen.findByText("1 saved")).toBeInTheDocument();
    sceneSummaries.unshift({
      id: "scene-2",
      title: "Updated plan",
      version: 1,
      updatedAt: 3,
    });
    fireEvent.click(screen.getByRole("button", { name: "Save to cloud" }));
    await waitFor(() => expect(onSaveCloudScene).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("2 saved")).toBeInTheDocument();
    expect(screen.getByText("Latest: Updated plan")).toBeInTheDocument();
    expect(await screen.findByText("1 recent")).toBeInTheDocument();
    expect(await screen.findByText("Deployment status")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Cloud sign in")).toBeInTheDocument();
  });

  it("saves an encrypted cloud copy when E2E storage is enabled", async () => {
    const onSaveEncryptedCloudScene = vi.fn(async () => {});
    setBackend(
      makeBackend({
        auth: true,
        currentUser: {
          id: "u1",
          email: "me@example.com",
          displayName: null,
          avatarUrl: null,
          createdAt: 0,
          lastSignInAt: null,
        },
        encryptedCloudStorage: true,
      }),
    );

    render(
      <CloudAuthButton onSaveEncryptedCloudScene={onSaveEncryptedCloudScene} />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Cloud account" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Save encrypted copy" }),
    );

    await waitFor(() =>
      expect(onSaveEncryptedCloudScene).toHaveBeenCalledTimes(1),
    );
  });

  it("opens cloud AI tasks from the account dialog", async () => {
    const onOpenAITasks = vi.fn();
    setBackend(
      makeBackend({
        auth: true,
        currentUser: {
          id: "u1",
          email: "me@example.com",
          displayName: null,
          avatarUrl: null,
          createdAt: 0,
          lastSignInAt: null,
        },
        aiTasks: [
          {
            id: "task-1",
            status: "failed",
          },
        ],
      }),
    );
    render(<CloudAuthButton onOpenAITasks={onOpenAITasks} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Cloud account" }),
    );
    expect(await screen.findByText("1 recent")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /AI tasks/ }));
    expect(onOpenAITasks).toHaveBeenCalledTimes(1);
  });

  it("shows current cloud scene refresh controls when a remote update exists", async () => {
    const onCheckCurrentCloudScene = vi.fn(async () => {});
    const onRefreshCurrentCloudScene = vi.fn(async () => {});
    setBackend(
      makeBackend({
        auth: true,
        currentUser: {
          id: "u1",
          email: "me@example.com",
          displayName: null,
          avatarUrl: null,
          createdAt: 0,
          lastSignInAt: null,
        },
      }),
    );
    render(
      <CloudAuthButton
        activeCloudScene={{
          id: "scene-1",
          title: "Roadmap",
          version: 2,
          updatedAt: 2,
        }}
        cloudSceneRemoteUpdate={{
          status: "remote-newer",
          metadata: {
            id: "scene-1",
            title: "Roadmap",
            version: 3,
            updatedAt: 3,
          },
          checkedAt: 3,
        }}
        onCheckCurrentCloudScene={onCheckCurrentCloudScene}
        onRefreshCurrentCloudScene={onRefreshCurrentCloudScene}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Cloud account" }),
    );

    expect(await screen.findByText("Current whiteboard")).toBeInTheDocument();
    expect(screen.getByText("Version 2")).toBeInTheDocument();
    expect(
      screen.getByText("Newer cloud version available."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Check updates" }));
    await waitFor(() =>
      expect(onCheckCurrentCloudScene).toHaveBeenCalledTimes(1),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh current whiteboard" }),
    );
    await waitFor(() =>
      expect(onRefreshCurrentCloudScene).toHaveBeenCalledTimes(1),
    );
  });

  it("shows current cloud scene cast artifact summary and refreshes it", async () => {
    const castSessions = [
      {
        id: "cast-1",
        status: "exported",
      },
    ];
    const castExports = [
      {
        id: "export-1",
        type: "mp4",
      },
    ];
    const backend = makeBackend({
      auth: true,
      currentUser: {
        id: "u1",
        email: "me@example.com",
        displayName: null,
        avatarUrl: null,
        createdAt: 0,
        lastSignInAt: null,
      },
      castSessions,
      castExports,
    });
    setBackend(backend);

    render(
      <CloudAuthButton
        activeCloudScene={{
          id: "scene-1",
          title: "Roadmap",
          version: 2,
          updatedAt: 2,
        }}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Cloud account" }),
    );

    expect(await screen.findByText("Recording artifacts")).toBeInTheDocument();
    expect(screen.getByText("Sessions: 1 · Exports: 1")).toBeInTheDocument();
    expect(screen.getByText("Latest: Exported")).toBeInTheDocument();
    expect(backend.cast.listByScene).toHaveBeenCalledWith("scene-1", {
      limit: 20,
    });
    expect(backend.cast.listExportsByScene).toHaveBeenCalledWith("scene-1", {
      limit: 20,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh cast artifacts" }),
    );
    await waitFor(() =>
      expect(backend.cast.listByScene).toHaveBeenCalledTimes(2),
    );
  });

  it("shows current cloud scene embed summary and opens management", async () => {
    const onOpenEmbeds = vi.fn();
    const backend = makeBackend({
      auth: true,
      currentUser: {
        id: "u1",
        email: "me@example.com",
        displayName: null,
        avatarUrl: null,
        createdAt: 0,
        lastSignInAt: null,
      },
      embeds: [
        {
          id: "embed-1",
          mode: "write",
        },
      ],
    });
    setBackend(backend);

    render(
      <CloudAuthButton
        activeCloudScene={{
          id: "scene-1",
          title: "Roadmap",
          version: 2,
          updatedAt: 2,
        }}
        onOpenEmbeds={onOpenEmbeds}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Cloud account" }),
    );

    expect(await screen.findByText("Embeds")).toBeInTheDocument();
    expect(screen.getByText("1 embeds")).toBeInTheDocument();
    expect(screen.getByText("Latest: Writable")).toBeInTheDocument();
    expect(backend.embed.listByScene).toHaveBeenCalledWith("scene-1", {
      limit: 20,
    });

    fireEvent.click(screen.getByRole("button", { name: "Refresh embeds" }));
    await waitFor(() =>
      expect(backend.embed.listByScene).toHaveBeenCalledTimes(2),
    );

    fireEvent.click(screen.getByRole("button", { name: "Manage embeds" }));
    expect(onOpenEmbeds).toHaveBeenCalledTimes(1);
  });

  it("shows collaboration room binding controls and creates a copied link", async () => {
    const onStartCollabRoom = vi.fn();
    const onCollabRoomChanged = vi.fn();
    const backend = makeBackend({
      auth: true,
      currentUser: {
        id: "u1",
        email: "me@example.com",
        displayName: null,
        avatarUrl: null,
        createdAt: 0,
        lastSignInAt: null,
      },
    });
    setBackend(backend);

    render(
      <CloudAuthButton
        onStartCollabRoom={onStartCollabRoom}
        onCollabRoomChanged={onCollabRoomChanged}
        activeCloudScene={{
          id: "scene-1",
          title: "Roadmap",
          version: 2,
          updatedAt: 2,
        }}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Cloud account" }),
    );

    expect(
      await screen.findByText("Live collaboration room"),
    ).toBeInTheDocument();
    expect(screen.getByText("No room binding")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create room link" }));

    await waitFor(() =>
      expect(backend.collabRooms.createForScene).toHaveBeenCalledWith({
        sceneId: "scene-1",
        roomId: expect.any(String),
      }),
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining("#room="),
    );
    expect(onStartCollabRoom).toHaveBeenCalledWith({
      roomId: expect.any(String),
      roomKey: expect.any(String),
    });
    expect(onCollabRoomChanged).toHaveBeenCalledTimes(1);
  });

  it("notifies when a collaboration room binding is revoked", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onCollabRoomChanged = vi.fn();
    const onCollabRoomRevoked = vi.fn();
    const collabRoom = {
      id: "collab-room-1",
      ownerId: "u1",
      sceneId: "scene-1",
      roomId: "room-1",
      status: "active",
      createdAt: 0,
      updatedAt: 0,
      revokedAt: null,
    };
    const backend = makeBackend({
      auth: true,
      currentUser: {
        id: "u1",
        email: "me@example.com",
        displayName: null,
        avatarUrl: null,
        createdAt: 0,
        lastSignInAt: null,
      },
      collabRoom,
    });
    setBackend(backend);

    render(
      <CloudAuthButton
        onCollabRoomChanged={onCollabRoomChanged}
        onCollabRoomRevoked={onCollabRoomRevoked}
        activeCloudScene={{
          id: "scene-1",
          title: "Roadmap",
          version: 2,
          updatedAt: 2,
        }}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Cloud account" }),
    );

    expect(
      await screen.findByText("Live collaboration room"),
    ).toBeInTheDocument();
    expect(screen.getByText("Active room")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

    await waitFor(() =>
      expect(backend.collabRooms.revoke).toHaveBeenCalledWith("collab-room-1"),
    );
    expect(onCollabRoomRevoked).toHaveBeenCalledWith(collabRoom);
    expect(onCollabRoomChanged).toHaveBeenCalledTimes(1);
  });
});
