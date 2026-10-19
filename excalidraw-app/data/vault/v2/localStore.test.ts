import { createVaultV2Keys } from "./protocol";
import { VaultV2LocalDocSaver, VaultV2LocalStore } from "./localStore";
import { canonical, replica, seeded } from "./testUtils";

import type { VaultEnvelopeV2 } from "./protocol";

const VAULT_ID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const OTHER_VAULT = "7f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const ROOM_ID = "room_1234567890abcdef";
const keys = createVaultV2Keys("A".repeat(43), VAULT_ID);

let dbIndex = 0;
const freshName = () => `vault-v2-test-${++dbIndex}-${Date.now()}`;

const envelope = (messageId: string): VaultEnvelopeV2 => ({
  version: 2,
  schemaVersion: 2,
  protocolVersion: 2,
  vaultId: VAULT_ID,
  roomId: ROOM_ID,
  purpose: "realtime.content",
  messageType: "sync.update",
  messageId,
  generation: 0,
  chunkIndex: 0,
  chunkCount: 1,
  iv: "AAAAAAAAAAAAAAAA",
  ciphertext: "A".repeat(22),
});

const entry = (n: number) => ({
  updateId: `u-${n}`,
  clientId: 7,
  clockAfter: n,
  envelopes: [envelope(`1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5${n}`)],
});

describe("VaultV2LocalStore · outbox (W3)", () => {
  it("survives a reopen, is scoped per Vault and removes by updateId", async () => {
    const databaseName = freshName();
    let store = await VaultV2LocalStore.open({ databaseName });
    await store.outbox(VAULT_ID).put(entry(1));
    await store.outbox(VAULT_ID).put(entry(2));
    await store.outbox(OTHER_VAULT).put(entry(3));
    store.close();

    store = await VaultV2LocalStore.open({ databaseName });
    const outbox = store.outbox(VAULT_ID);
    expect((await outbox.list()).map((e) => e.updateId).sort()).toEqual([
      "u-1",
      "u-2",
    ]);
    expect(await outbox.list()).toContainEqual(entry(1));
    await outbox.remove(["u-1"]);
    expect((await outbox.list()).map((e) => e.updateId)).toEqual(["u-2"]);
    expect(await store.outbox(OTHER_VAULT).list()).toHaveLength(1);
    store.close();
  });

  it("skips corrupted records instead of resending them", async () => {
    const store = await VaultV2LocalStore.open({ databaseName: freshName() });
    await store.outbox(VAULT_ID).put({
      ...entry(1),
      envelopes: [{ ...envelope("x"), extra: 1 } as any],
    });
    await store.outbox(VAULT_ID).put(entry(2));
    expect(
      (await store.outbox(VAULT_ID).list()).map((e) => e.updateId),
    ).toEqual(["u-2"]);
    store.close();
  });

  it("purgeVault removes outbox and doc of that Vault only", async () => {
    const store = await VaultV2LocalStore.open({ databaseName: freshName() });
    const { scene } = seeded();
    await store.outbox(VAULT_ID).put(entry(1));
    await store.outbox(OTHER_VAULT).put(entry(2));
    await store.saveDoc({
      keys,
      vaultId: VAULT_ID,
      roomId: ROOM_ID,
      generation: 0,
      scene,
    });
    await store.purgeVault(VAULT_ID);
    expect(await store.outbox(VAULT_ID).list()).toEqual([]);
    expect(await store.outbox(OTHER_VAULT).list()).toHaveLength(1);
    expect(
      await store.restoreDoc({
        keys,
        vaultId: VAULT_ID,
        roomId: ROOM_ID,
        scene: replica("actor-b").scene,
      }),
    ).toBeNull();
    store.close();
  });
});

describe("VaultV2LocalStore · local doc (W3)", () => {
  it("round-trips the sealed doc into a fresh replica", async () => {
    const store = await VaultV2LocalStore.open({ databaseName: freshName() });
    const source = seeded();
    await store.saveDoc({
      keys,
      vaultId: VAULT_ID,
      roomId: ROOM_ID,
      generation: 4,
      scene: source.scene,
      now: 123,
    });
    const target = replica("actor-b");
    await expect(
      store.restoreDoc({
        keys,
        vaultId: VAULT_ID,
        roomId: ROOM_ID,
        scene: target.scene,
      }),
    ).resolves.toEqual({ generation: 4, savedAt: 123 });
    expect(canonical(target.materializer.materialize().elements)).toBe(
      canonical(source.materializer.materialize().elements),
    );
    store.close();
  });

  it("never stores plaintext element content", async () => {
    const databaseName = freshName();
    const store = await VaultV2LocalStore.open({ databaseName });
    const { scene } = seeded("actor-a");
    await store.saveDoc({
      keys,
      vaultId: VAULT_ID,
      roomId: ROOM_ID,
      generation: 0,
      scene,
    });
    store.close();
    const raw = await new Promise<unknown>((resolve) => {
      const req = indexedDB.open(databaseName);
      req.onsuccess = () => {
        const get = req.result
          .transaction("docs")
          .objectStore("docs")
          .get(VAULT_ID);
        get.onsuccess = () => {
          req.result.close();
          resolve(get.result);
        };
      };
    });
    const text = JSON.stringify(raw);
    expect(text).not.toContain("hello world");
    expect(text).not.toContain("box-1");
  });

  it("drops a copy sealed with another key or for another room", async () => {
    const store = await VaultV2LocalStore.open({ databaseName: freshName() });
    const { scene } = seeded();
    await store.saveDoc({
      keys: createVaultV2Keys(`${"B".repeat(42)}A`, VAULT_ID),
      vaultId: VAULT_ID,
      roomId: ROOM_ID,
      generation: 0,
      scene,
    });
    const target = replica("actor-b");
    await expect(
      store.restoreDoc({
        keys,
        vaultId: VAULT_ID,
        roomId: ROOM_ID,
        scene: target.scene,
      }),
    ).resolves.toBeNull();
    expect(target.materializer.materialize().elements).toHaveLength(0);

    await store.saveDoc({
      keys,
      vaultId: VAULT_ID,
      roomId: ROOM_ID,
      generation: 0,
      scene,
    });
    await expect(
      store.restoreDoc({
        keys,
        vaultId: VAULT_ID,
        roomId: "room_other_1234567",
        scene: target.scene,
      }),
    ).resolves.toBeNull();
    store.close();
  });

  it("the saver debounces doc updates and flushes on demand", async () => {
    vi.useFakeTimers();
    try {
      const store = await VaultV2LocalStore.open({ databaseName: freshName() });
      const save = vi.spyOn(store, "saveDoc");
      const { scene } = seeded();
      const saver = new VaultV2LocalDocSaver({
        store,
        keys,
        vaultId: VAULT_ID,
        roomId: ROOM_ID,
        scene,
        generation: () => 2,
        debounceMs: 2_000,
      });
      scene.transact(() => scene.writeFields("note-1", { x: 1 }));
      scene.transact(() => scene.writeFields("note-1", { x: 2 }));
      expect(save).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(save).toHaveBeenCalledTimes(1);
      scene.transact(() => scene.writeFields("note-1", { x: 3 }));
      await saver.flush(); // page hidden
      expect(save).toHaveBeenCalledTimes(2);
      saver.dispose();
      scene.transact(() => scene.writeFields("note-1", { x: 4 }));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(save).toHaveBeenCalledTimes(2);
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
