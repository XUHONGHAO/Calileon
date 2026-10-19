import type { ExcalidrawElement } from "@excalidraw/element/types";

import type { SceneData } from "@excalidraw/excalidraw/types";

import { VaultV2SceneController } from "./controller";
import { MockVaultRoom } from "./mockRoom";
import { createVaultV2Keys } from "./protocol";
import { VaultV2SyncEngine, createMemoryOutbox } from "./syncEngine";
import { buildBasicScene, byId, canonical } from "./testUtils";

import type { VaultV2Role, VaultV2Status, VaultV2Timers } from "./syncEngine";

const VAULT_ID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const ROOT = `${"B".repeat(42)}A`;
const keys = createVaultV2Keys(ROOT, VAULT_ID);

/** manual clock: timers fire only on `advance` */
const manualTimers = () => {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: VaultV2Timers & { advance: (ms: number) => Promise<void> } = {
    now: () => now,
    setTimeout: (fn, ms) => {
      seq += 1;
      pending.set(seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout: (handle) => void pending.delete(handle as number),
    advance: async (ms) => {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) {
          break;
        }
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await settle();
      }
      now = target;
      await settle();
    },
  };
  return timers;
};

const settle = async () => {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

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

const client = (
  room: MockVaultRoom,
  name: string,
  role: VaultV2Role,
  timers: ReturnType<typeof manualTimers>,
) => {
  const controller = new VaultV2SceneController({ actorId: `actor-${name}` });
  const editor = new Editor();
  controller.attach(editor);
  const statuses: VaultV2Status[] = [];
  const errors: unknown[] = [];
  const outbox = createMemoryOutbox();
  const engine = new VaultV2SyncEngine({
    controller,
    keys,
    vaultId: VAULT_ID,
    roomId: "room_1",
    role,
    transport: room.join(name, role),
    snapshots: room.snapshotStore(role),
    outbox,
    timers,
    onStatus: (status) => statuses.push(status),
    onError: (error) => errors.push(error),
  });
  const commit = async () => {
    controller.captureLocal(editor.elements, null);
    await engine.flushNow();
    await settle();
  };
  return { controller, editor, engine, statuses, errors, outbox, commit };
};

const setup = async (roles: VaultV2Role[] = ["editor", "editor"]) => {
  const room = new MockVaultRoom();
  const timers = manualTimers();
  const clients = roles.map((role, index) =>
    client(room, String.fromCharCode(97 + index), role, timers),
  );
  const [a] = clients;
  a.editor.elements = buildBasicScene();
  for (const c of clients) {
    await c.engine.start();
  }
  await a.commit();
  return { room, timers, clients };
};

describe("VaultV2SyncEngine · end to end over the mock room", () => {
  it("edits converge; the relay carries only { envelope } (S-4)", async () => {
    const { room, clients } = await setup();
    const [a, b] = clients;
    expect(byId(b.editor.elements, "box-1")).toBeDefined();
    b.editor.edit("note-1", { x: 77 });
    await b.commit();
    expect(byId(a.editor.elements, "note-1")!.x).toBe(77);
    expect(canonical(a.controller.materializer.materialize().elements)).toBe(
      canonical(b.controller.materializer.materialize().elements),
    );
    for (const frame of room.relayed) {
      expect(Object.keys(frame as object)).toEqual(["envelope"]);
    }
    expect(a.errors).toEqual([]);
  });

  it("batches several edits within 150 ms into one envelope", async () => {
    const { room, clients, timers } = await setup();
    const [a] = clients;
    const before = room.relayed.length;
    for (const x of [1, 2, 3, 4]) {
      a.editor.edit("note-1", { x });
      a.controller.captureLocal(a.editor.elements, null);
    }
    await settle();
    expect(room.relayed.length).toBe(before);
    await timers.advance(150);
    expect(room.relayed.length).toBe(before + 1);
  });

  it("a viewer receives content but the server rejects content it sends (S-5, N15)", async () => {
    const { room, clients } = await setup(["editor", "viewer"]);
    const [a, v] = clients;
    expect(byId(v.editor.elements, "note-1")).toBeDefined();
    a.editor.edit("note-1", { x: 5 });
    await a.commit();
    expect(byId(v.editor.elements, "note-1")!.x).toBe(5);
    // a malicious viewer client forging content
    const forged = await (
      await import("./protocol")
    ).sealVaultV2Message(
      keys,
      {
        version: 2,
        schemaVersion: 2,
        protocolVersion: 2,
        vaultId: VAULT_ID,
        roomId: "room_1",
        messageType: "sync.update",
        generation: 0,
      },
      {
        kind: "sync.update",
        updateId: "x",
        authorActorId: "v",
        authorClock: 1,
        baseStateVector: "",
        updates: [],
        baseGeneration: 0,
      },
    );
    await room.join("v-forger", "viewer").send(forged, { volatile: false });
    expect(room.rejected.some((entry) => entry.reason === "role")).toBe(true);
  });

  it("viewer may ask for catch-up via realtime.request (N19)", async () => {
    const { room, clients } = await setup(["editor", "viewer"]);
    const before = room.rejected.length;
    await clients[1].engine.onReconnect();
    expect(room.rejected.length).toBe(before);
  });

  it("offline edits stay in the outbox and are sent on reconnect", async () => {
    const { room, clients } = await setup();
    const [a, b] = clients;
    room.setOnline("b", false);
    b.editor.edit("note-1", { x: 900 });
    await b.commit();
    expect(byId(a.editor.elements, "note-1")!.x).not.toBe(900);
    expect(b.outbox.entries.size).toBeGreaterThan(0);
    room.setOnline("b", true);
    await b.engine.onReconnect();
    await settle();
    expect(byId(a.editor.elements, "note-1")!.x).toBe(900);
  });

  it("reconnect with no peer online recovers missed edits from the snapshot", async () => {
    const { room, clients } = await setup();
    const [a, b] = clients;
    room.setOnline("b", false);
    a.editor.edit("note-1", { x: 444 });
    await a.commit();
    await a.engine.writeSnapshot("manual");
    a.engine.stop();
    room.setOnline("a", false); // the only peer that saw the edit is gone
    room.setOnline("b", true);
    await b.engine.onReconnect();
    await settle();
    expect(byId(b.editor.elements, "note-1")!.x).toBe(444);
    expect(b.engine.knownGeneration).toBe(1);
  });

  it("a missed update is detected from baseStateVector and recovered via snapshot-request (S3, N14)", async () => {
    const { room, clients, timers } = await setup([
      "editor",
      "editor",
      "editor",
    ]);
    const [a, b, c] = clients;
    // c misses a's first edit (dropped), then receives a's second edit
    room.setOnline("c", false);
    a.editor.edit("note-1", { x: 1 });
    await a.commit();
    room.setOnline("c", true);
    a.editor.edit("box-2", { x: 2 });
    await a.commit();
    expect(c.engine.stats.gapOpen).toBe(true);
    expect(c.engine.currentStatus).toBe("syncing");
    await timers.advance(2_000);
    await settle();
    expect(byId(c.editor.elements, "note-1")!.x).toBe(1);
    expect(byId(c.editor.elements, "box-2")!.x).toBe(2);
    expect(c.engine.stats.gapOpen).toBe(false);
    void b;
  });

  it("join after editors went quiet: snapshot + online catch-up", async () => {
    const { room, clients, timers } = await setup();
    const [a] = clients;
    await a.engine.writeSnapshot("manual");
    expect(room.snapshot?.generation).toBe(1);
    a.editor.edit("note-1", { x: 31 });
    await a.commit(); // after the snapshot
    const late = client(room, "z", "editor", timers);
    await late.engine.start();
    await settle();
    expect(byId(late.editor.elements, "note-1")!.x).toBe(31);
    expect(late.engine.knownGeneration).toBe(1);
  });

  it("snapshot CAS conflict merges instead of overwriting; outbox retires once covered", async () => {
    const { room, clients } = await setup();
    const [a, b] = clients;
    room.setOnline("a", false);
    room.setOnline("b", false);
    a.editor.edit("note-1", { x: 10 });
    await a.commit();
    b.editor.edit("box-2", { x: 20 });
    await b.commit();
    await a.engine.writeSnapshot("manual");
    expect(room.snapshot?.generation).toBe(1);
    await b.engine.writeSnapshot("manual"); // conflict → load + merge
    expect(byId(b.editor.elements, "note-1")!.x).toBe(10);
    expect(byId(b.editor.elements, "box-2")!.x).toBe(20);
    await b.engine.writeSnapshot("manual"); // now on top of gen 1
    expect(room.snapshot?.generation).toBe(2);
    expect(b.outbox.entries.size).toBe(0);
  });

  it("duplicated and reordered delivery converge (idempotent)", async () => {
    const { room, clients } = await setup(["editor", "editor", "editor"]);
    const [a, b, c] = clients;
    room.hold = true;
    a.editor.edit("note-1", { x: 3 });
    await a.commit();
    b.editor.edit("note-1", { strokeColor: "#f00" });
    await b.commit();
    room.hold = false;
    room.release((frames) => [...frames.reverse(), ...frames]);
    await settle();
    const scenes = [a, b, c].map((x) =>
      canonical(x.controller.materializer.materialize().elements),
    );
    expect(new Set(scenes).size).toBe(1);
    expect(c.errors).toEqual([]);
  });
});
