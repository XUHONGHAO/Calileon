import type { ExcalidrawElement } from "@excalidraw/element/types";

import type { SceneData } from "@excalidraw/excalidraw/types";

import { VAULT_SOCKET_EVENTS } from "../backendContract";

import { VaultV2LocalStore } from "./localStore";
import { MockVaultRoom } from "./mockRoom";
import { openVaultV2Session } from "./session";
import { buildBasicScene, byId } from "./testUtils";

import type { VaultV2SessionSocket } from "./session";
import type { VaultV2Role } from "./syncEngine";

const VAULT_ID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const INVITATION_ID = "223e4567-e89b-42d3-a456-426614174000";
const ROOM_ID = "room_1234567890abcdef";
const link = {
  version: 2 as const,
  vaultId: VAULT_ID,
  rootKey: `${"C".repeat(42)}A`,
  invitationCapability: "A".repeat(43),
};

const settle = async () => {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

/** a socket.io-shaped relay with the room server's v2 admission rules */
class FakeServer {
  readonly sockets = new Set<FakeSocket>();
  revoked = false;
  constructor(readonly snapshots = new MockVaultRoom()) {}

  connect(role: VaultV2Role) {
    const socket = new FakeSocket(this, role);
    this.sockets.add(socket);
    return socket;
  }
}

class FakeSocket implements VaultV2SessionSocket {
  connected = true;
  private readonly listeners = new Map<string, Set<(...a: any[]) => void>>();
  admitted = false;
  constructor(
    private readonly server: FakeServer,
    readonly role: VaultV2Role,
  ) {}

  on(event: string, listener: (...a: any[]) => void) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
  }
  off(event: string, listener: (...a: any[]) => void) {
    this.listeners.get(event)?.delete(listener);
  }
  fire(event: string, ...args: any[]) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener(...args);
    }
  }
  listenerCount() {
    return [...this.listeners.values()].reduce((n, s) => n + s.size, 0);
  }
  emit(event: string, ...args: any[]) {
    const ack = typeof args[args.length - 1] === "function" ? args.pop() : null;
    if (!this.connected) {
      return;
    }
    if (event === VAULT_SOCKET_EVENTS.join) {
      if (this.server.revoked) {
        ack?.({ ok: false, code: "VAULT_CAPABILITY_REVOKED" });
        return;
      }
      this.admitted = true;
      ack?.({
        ok: true,
        resolution: {
          vaultId: VAULT_ID,
          invitationId: INVITATION_ID,
          role: this.role,
          authorizationVersion: 1,
          activeRoomId: ROOM_ID,
          snapshotGeneration: 0,
          expiresAt: null,
          protocolVersion: 2,
        },
      });
      return;
    }
    const [roomId, envelope] = args;
    if (!this.admitted || roomId !== ROOM_ID) {
      ack?.({ ok: false, code: "VAULT_CAPABILITY_FORBIDDEN" });
      return;
    }
    if (this.role === "viewer" && envelope.purpose === "realtime.content") {
      ack?.({ ok: false, code: "VAULT_CAPABILITY_FORBIDDEN" });
      return;
    }
    for (const peer of this.server.sockets) {
      if (peer !== this && peer.admitted && peer.connected) {
        peer.fire(VAULT_SOCKET_EVENTS.server, { envelope });
      }
    }
    ack?.({ ok: true });
  }
  drop() {
    this.connected = false;
    this.admitted = false;
    this.fire("disconnect");
  }
  restore() {
    this.connected = true;
    this.fire("connect");
  }
  close() {
    this.connected = false;
  }
}

class Editor {
  elements: ExcalidrawElement[] = [];
  getSceneElementsIncludingDeleted = () => this.elements;
  updateScene = (scene: SceneData) => {
    if (scene.elements) {
      this.elements = [...(scene.elements as ExcalidrawElement[])];
    }
  };
  edit(id: string, changes: Record<string, unknown>) {
    this.elements = this.elements.map((element) =>
      element.id === id
        ? ({
            ...element,
            ...changes,
            version: element.version + 1,
            versionNonce: element.versionNonce + 1,
          } as ExcalidrawElement)
        : element,
    );
  }
}

const fakeLifecycle = () => {
  const listeners = new Map<string, () => void>();
  return {
    document: { visibilityState: "visible" as DocumentVisibilityState },
    addEventListener: (type: string, fn: any) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
    fire: (type: string) => listeners.get(type)?.(),
    listeners,
  };
};

const open = async (
  server: FakeServer,
  role: VaultV2Role,
  extra: Partial<Parameters<typeof openVaultV2Session>[0]> = {},
) => {
  const socket = server.connect(role);
  const editor = new Editor();
  const statuses: string[] = [];
  const blocked: unknown[] = [];
  const lifecycle = fakeLifecycle();
  const session = await openVaultV2Session({
    link,
    socket,
    createSnapshotStore: () => server.snapshots.snapshotStore(role),
    onStatus: (status) => statuses.push(status),
    onBlocked: (error) => blocked.push(error),
    config: { batchMs: 0 },
    lifecycle,
    ...extra,
  });
  session.attach(editor);
  await settle();
  const commit = async () => {
    session.onChange(editor.elements, {});
    await session.engine.flushNow();
    await settle();
  };
  return { session, socket, editor, statuses, blocked, lifecycle, commit };
};

describe("openVaultV2Session (W6 wiring over a socket.io-shaped relay)", () => {
  it("two editors converge through the real socket transport", async () => {
    const server = new FakeServer();
    const a = await open(server, "editor");
    const b = await open(server, "editor");
    a.editor.elements = buildBasicScene();
    await a.commit();
    expect(byId(b.editor.elements, "box-1")).toBeDefined();
    b.editor.edit("note-1", { x: 321 });
    await b.commit();
    expect(byId(a.editor.elements, "note-1")!.x).toBe(321);
    a.session.dispose();
    b.session.dispose();
  });

  it("a viewer receives but never captures local edits", async () => {
    const server = new FakeServer();
    const a = await open(server, "editor");
    const v = await open(server, "viewer");
    a.editor.elements = buildBasicScene();
    await a.commit();
    expect(byId(v.editor.elements, "note-1")).toBeDefined();
    v.editor.edit("note-1", { x: 999 });
    await v.commit();
    expect(byId(a.editor.elements, "note-1")!.x).not.toBe(999);
    expect(v.session.role).toBe("viewer");
  });

  it("refuses to open when admission is revoked (no fallback)", async () => {
    const server = new FakeServer();
    server.revoked = true;
    await expect(open(server, "editor")).rejects.toMatchObject({
      code: "VAULT_CAPABILITY_REVOKED",
    });
  });

  it("a revoke notice blocks the session", async () => {
    const server = new FakeServer();
    const a = await open(server, "editor");
    a.socket.fire(VAULT_SOCKET_EVENTS.capabilityRevoked, {
      vaultId: VAULT_ID,
      invitationId: INVITATION_ID,
      authorizationVersion: 2,
      reason: "revoked",
    });
    expect(a.blocked).toHaveLength(1);
    expect(a.session.status()).toBe("blocked");
  });

  it("re-joins after a socket reconnect and resends offline edits", async () => {
    const server = new FakeServer();
    const a = await open(server, "editor");
    const b = await open(server, "editor");
    a.editor.elements = buildBasicScene();
    await a.commit();
    b.socket.drop();
    b.editor.edit("note-1", { x: 55 });
    await b.commit();
    expect(byId(a.editor.elements, "note-1")!.x).not.toBe(55);
    b.socket.restore();
    await settle();
    expect(byId(a.editor.elements, "note-1")!.x).toBe(55);
  });

  it("pagehide writes a snapshot and the local copy; reopen restores offline edits", async () => {
    const server = new FakeServer();
    const localStore = await VaultV2LocalStore.open({
      databaseName: `vault-v2-session-${Date.now()}`,
    });
    const a = await open(server, "editor", { localStore });
    a.editor.elements = buildBasicScene();
    await a.commit();
    a.lifecycle.fire("pagehide");
    await settle();
    expect(server.snapshots.snapshot?.generation).toBe(1);

    // offline edit, then the tab closes before anything reaches the room
    a.socket.drop();
    a.editor.edit("note-1", { x: 77 });
    await a.commit();
    await a.session.persistNow();
    a.session.dispose();
    expect(a.lifecycle.listeners.size).toBe(0);

    const again = await open(server, "editor", { localStore });
    expect(byId(again.editor.elements, "note-1")!.x).toBe(77);
    // and the outbox is resent: a fresh peer sees it too
    const peer = await open(server, "editor");
    await settle();
    expect(byId(peer.editor.elements, "note-1")!.x).toBe(77);
    localStore.close();
  }, 20_000); // ~2 s alone; full-suite CPU contention pushed it past 5 s

  it("a crash before the local save loses no offline edit, even with nobody online (W7)", async () => {
    const server = new FakeServer();
    const localStore = await VaultV2LocalStore.open({
      databaseName: `vault-v2-crash-${Date.now()}`,
    });
    const a = await open(server, "editor", { localStore });
    a.editor.elements = buildBasicScene();
    await a.commit();
    await a.session.persistNow();

    // offline edit: sealed into the outbox, but the tab dies before the
    // debounced local copy is written (no pagehide, no persistNow)
    a.socket.drop();
    a.editor.edit("note-1", { x: 77 });
    await a.commit();
    a.session.dispose();

    // reopened alone: nobody can echo the edit back
    const again = await open(server, "editor", { localStore });
    expect(byId(again.editor.elements, "note-1")!.x).toBe(77);
    // and it reaches the next snapshot, so a later device sees it too
    await again.session.persistNow();
    again.session.dispose();
    const later = await open(server, "editor");
    expect(byId(later.editor.elements, "note-1")!.x).toBe(77);
    localStore.close();
  }, 20_000);

  it("dispose detaches every socket listener", async () => {
    const server = new FakeServer();
    const a = await open(server, "editor");
    expect(a.socket.listenerCount()).toBeGreaterThan(0);
    a.session.dispose();
    expect(a.socket.listenerCount()).toBe(0);
  });
});
