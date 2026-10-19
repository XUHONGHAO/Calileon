/**
 * Vault v2 (P4c) sync engine. W2 design §4 (batching), §5 (chunks), §6
 * (join, gap detection, snapshots).
 *
 * - local Yjs updates are batched (150 ms / end of user action / 64 KB),
 *   merged, sealed, stored in the outbox, then sent;
 * - outbox entries are retired once a snapshot that covers them is known
 *   (there is no server ack, W2 §10 item 4); reconnect re-sends them
 *   (Yjs is idempotent, receivers dedupe by `updateId`); on start they are
 *   also applied locally, since they can be newer than the local copy;
 * - receivers detect gaps from the authenticated `baseStateVector` (S3), never
 *   from outer ordering; a gap that does not close within 2 s triggers a
 *   snapshot request + state-vector context;
 * - join: load the snapshot via the snapshot store, apply, send `sync.context`;
 *   online peers answer with exactly what is missing (and ask back if the
 *   joiner is ahead);
 * - editors write snapshots (200 updates / 10 min / page hidden), CAS on the
 *   generation; on conflict they load and merge instead of overwriting.
 */
import * as Y from "yjs";

import { VaultError } from "../errors";

import {
  VAULT_V2_ENVELOPE_VERSION,
  VAULT_V2_PROTOCOL_VERSION,
  VAULT_V2_SCHEMA_VERSION,
  VaultV2Reassembler,
  createVaultV2MessageId,
  fromB64,
  openVaultV2,
  sealVaultV2Message,
  toB64,
} from "./protocol";
import { VAULT_V2_REMOTE_ORIGIN } from "./sceneDoc";

import type { VaultV2SceneController } from "./controller";
import type {
  SyncSnapshotV2,
  SyncUpdateV2,
  VaultEnvelopeV2,
  VaultV2Inner,
  VaultV2Keys,
  VaultV2MessageType,
} from "./protocol";

export type VaultV2Role = "viewer" | "editor";

export type VaultV2Status =
  | "connecting"
  | "syncing"
  | "synced"
  | "offline"
  | "blocked";

export type VaultV2Transport = {
  /** sends sealed envelopes; resolves once handed to the socket */
  send: (
    envelopes: readonly VaultEnvelopeV2[],
    options: { volatile: boolean },
  ) => Promise<void>;
  /** subscribes to envelopes relayed from other clients */
  onEnvelope: (handler: (envelope: unknown) => void) => () => void;
  isConnected: () => boolean;
};

export type VaultV2SnapshotStore = {
  load: () => Promise<{
    generation: number;
    envelopes: readonly VaultEnvelopeV2[];
  } | null>;
  cas: (input: {
    expectedGeneration: number;
    snapshotId: string;
    envelopes: readonly VaultEnvelopeV2[];
  }) => Promise<
    { ok: true; generation: number } | { ok: false; reason: "conflict" }
  >;
};

export type VaultV2OutboxEntry = {
  readonly updateId: string;
  readonly clientId: number;
  /** our Yjs client clock after this batch */
  readonly clockAfter: number;
  readonly envelopes: readonly VaultEnvelopeV2[];
};

/** durable outbox (W3 supplies IndexedDB; tests use the in-memory one) */
export type VaultV2Outbox = {
  put: (entry: VaultV2OutboxEntry) => Promise<void>;
  remove: (updateIds: readonly string[]) => Promise<void>;
  list: () => Promise<readonly VaultV2OutboxEntry[]>;
};

export const createMemoryOutbox = (): VaultV2Outbox & {
  entries: Map<string, VaultV2OutboxEntry>;
} => {
  const entries = new Map<string, VaultV2OutboxEntry>();
  return {
    entries,
    put: async (entry) => void entries.set(entry.updateId, entry),
    remove: async (ids) => ids.forEach((id) => entries.delete(id)),
    list: async () => [...entries.values()],
  };
};

export type VaultV2Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
};

export type VaultV2SyncConfig = {
  batchMs: number;
  batchMaxBytes: number;
  gapGraceMs: number;
  snapshotEveryUpdates: number;
  snapshotEveryMs: number;
};

export const VAULT_V2_SYNC_DEFAULTS: VaultV2SyncConfig = {
  batchMs: 150,
  batchMaxBytes: 64 * 1024,
  gapGraceMs: 2_000,
  snapshotEveryUpdates: 200,
  snapshotEveryMs: 10 * 60_000,
};

const defaultTimers: VaultV2Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
  now: () => Date.now(),
};

const digestOf = (updates: readonly string[]) => {
  let hash = 2166136261;
  for (const update of updates) {
    for (let i = 0; i < update.length; i++) {
      hash ^= update.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
  }
  return hash >>> 0;
};

const svAhead = (theirs: Map<number, number>, ours: Map<number, number>) => {
  for (const [client, clock] of theirs) {
    if (clock > (ours.get(client) ?? 0)) {
      return true;
    }
  }
  return false;
};

export class VaultV2SyncEngine {
  private readonly config: VaultV2SyncConfig;
  private readonly timers: VaultV2Timers;
  private readonly reassembler: VaultV2Reassembler;

  private batch: Uint8Array[] = [];
  private batchBytes = 0;
  private batchBaseSv: Uint8Array | null = null;
  private batchTimer: unknown = null;
  private flushing: Promise<void> = Promise.resolve();

  private readonly seen = new Map<string, number>();
  private gapTarget: Map<number, number> | null = null;
  private gapTimer: unknown = null;

  private generation = 0;
  private updatesSinceSnapshot = 0;
  private lastSnapshotAt = 0;
  private snapshotTimer: unknown = null;
  private writingSnapshot: Promise<void> | null = null;
  /** state vector of the newest stored snapshot we know of */
  private snapshotSv: Map<number, number> | null = null;

  private status: VaultV2Status = "connecting";
  private stopped = false;
  private unsubscribe: (() => void) | null = null;
  private readonly onDocUpdate: (update: Uint8Array, origin: unknown) => void;

  constructor(
    private readonly options: {
      controller: VaultV2SceneController;
      keys: VaultV2Keys;
      vaultId: string;
      roomId: string;
      role: VaultV2Role;
      transport: VaultV2Transport;
      snapshots: VaultV2SnapshotStore;
      outbox: VaultV2Outbox;
      onStatus?: (status: VaultV2Status) => void;
      onPresence?: (payload: unknown) => void;
      onError?: (error: unknown) => void;
      timers?: VaultV2Timers;
      config?: Partial<VaultV2SyncConfig>;
    },
  ) {
    this.config = { ...VAULT_V2_SYNC_DEFAULTS, ...options.config };
    this.timers = options.timers ?? defaultTimers;
    this.reassembler = new VaultV2Reassembler(30_000, this.timers.now);
    const doc = options.controller.scene.doc;
    this.onDocUpdate = (update, origin) => {
      if (origin === VAULT_V2_REMOTE_ORIGIN || this.stopped) {
        return;
      }
      if (options.role !== "editor") {
        // viewers never publish content; a local change is a bug upstream
        options.onError?.(
          new VaultError(
            "VAULT_CAPABILITY_FORBIDDEN",
            "viewer produced a local update",
          ),
        );
        return;
      }
      this.enqueue(update);
    };
    doc.on("beforeTransaction", this.onBeforeTransaction);
    doc.on("update", this.onDocUpdate);
  }

  private get doc(): Y.Doc {
    return this.options.controller.scene.doc;
  }

  get currentStatus() {
    return this.status;
  }

  get knownGeneration() {
    return this.generation;
  }

  private setStatus(status: VaultV2Status) {
    if (this.status !== status) {
      this.status = status;
      this.options.onStatus?.(status);
    }
  }

  private refreshStatus() {
    if (this.status === "blocked" || this.stopped) {
      return;
    }
    if (!this.options.transport.isConnected()) {
      this.setStatus("offline");
      return;
    }
    const busy =
      this.batch.length > 0 ||
      this.gapTarget !== null ||
      this.reassembler.pendingGroups > 0;
    this.setStatus(busy ? "syncing" : "synced");
  }

  private base(messageType: VaultV2MessageType) {
    return {
      version: VAULT_V2_ENVELOPE_VERSION,
      schemaVersion: VAULT_V2_SCHEMA_VERSION,
      protocolVersion: VAULT_V2_PROTOCOL_VERSION,
      vaultId: this.options.vaultId,
      roomId: this.options.roomId,
      messageType,
      generation: this.generation,
    } as const;
  }

  // -------------------------------------------------------------- lifecycle

  /** W2 §6.1: outbox → snapshot → merge → context → drain outbox */
  async start() {
    this.unsubscribe = this.options.transport.onEnvelope((envelope) => {
      void this.receive(envelope).catch((error) =>
        this.options.onError?.(error),
      );
    });
    await this.replayOutbox();
    await this.loadSnapshot();
    this.options.controller.flushToEditor();
    await this.sendContext("sync.context");
    await this.drainOutbox();
    this.lastSnapshotAt = this.timers.now();
    this.scheduleSnapshotTimer();
    this.refreshStatus();
  }

  /** call after the transport reconnects */
  async onReconnect() {
    // Same path as join: with no peer online, the stored snapshot is the only
    // source of what we missed while disconnected.
    await this.loadSnapshot();
    this.options.controller.flushToEditor();
    await this.sendContext("sync.context");
    await this.drainOutbox();
    this.refreshStatus();
  }

  stop() {
    this.stopped = true;
    this.unsubscribe?.();
    this.doc.off("update", this.onDocUpdate);
    this.doc.off("beforeTransaction", this.onBeforeTransaction);
    for (const timer of [this.batchTimer, this.gapTimer, this.snapshotTimer]) {
      if (timer !== null) {
        this.timers.clearTimeout(timer);
      }
    }
  }

  /** marks the document unusable (revoked/expired, S12); keeps ciphertext */
  block() {
    this.setStatus("blocked");
  }

  // -------------------------------------------------------------- local → wire

  private onBeforeTransaction = (transaction: Y.Transaction) => {
    if (
      transaction.origin !== VAULT_V2_REMOTE_ORIGIN &&
      this.batch.length === 0 &&
      !this.batchBaseSv
    ) {
      this.batchBaseSv = Y.encodeStateVector(this.doc);
    }
  };

  private enqueue(update: Uint8Array) {
    this.batch.push(update);
    this.batchBytes += update.byteLength;
    if (this.batchBytes >= this.config.batchMaxBytes) {
      void this.flushNow();
      return;
    }
    if (this.batchTimer === null) {
      this.batchTimer = this.timers.setTimeout(() => {
        this.batchTimer = null;
        void this.flushNow();
      }, this.config.batchMs);
    }
    this.refreshStatus();
  }

  /** flushes the current batch (also the "end of user action" trigger) */
  flushNow(): Promise<void> {
    this.flushing = this.flushing
      .then(() => this.flushBatch())
      .catch((error) => {
        this.options.onError?.(error);
      });
    return this.flushing;
  }

  private async flushBatch() {
    if (this.batchTimer !== null) {
      this.timers.clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.batch.length === 0) {
      return;
    }
    const merged = Y.mergeUpdates(this.batch);
    const baseSv = this.batchBaseSv ?? Y.encodeStateVector(this.doc);
    this.batch = [];
    this.batchBytes = 0;
    this.batchBaseSv = null;
    const updateId = createVaultV2MessageId();
    const inner: SyncUpdateV2 = {
      kind: "sync.update",
      updateId,
      authorActorId: this.options.controller.scene.actorId,
      authorClock: this.options.controller.scene.observedMaxClock,
      baseStateVector: toB64(baseSv),
      updates: [toB64(merged)],
      baseGeneration: this.generation,
    };
    const envelopes = await sealVaultV2Message(
      this.options.keys,
      this.base("sync.update"),
      inner,
    );
    const clientId = this.doc.clientID;
    await this.options.outbox.put({
      updateId,
      clientId,
      clockAfter:
        Y.decodeStateVector(Y.encodeStateVector(this.doc)).get(clientId) ?? 0,
      envelopes,
    });
    this.seen.set(updateId, digestOf(inner.updates));
    this.updatesSinceSnapshot += 1;
    if (this.options.transport.isConnected()) {
      await this.options.transport.send(envelopes, { volatile: false });
    }
    if (this.updatesSinceSnapshot >= this.config.snapshotEveryUpdates) {
      void this.writeSnapshot("count");
    }
    this.refreshStatus();
  }

  /**
   * Applies our own unsent/unretired edits to the document before anything
   * else. The local copy is saved on a debounce, so after a crash the outbox
   * can be newer than it; resending alone would not bring the edit back when
   * no peer is online to echo it, and the next snapshot would leave it out.
   */
  private async replayOutbox() {
    for (const entry of await this.options.outbox.list()) {
      try {
        const reassembler = new VaultV2Reassembler(
          Number.MAX_SAFE_INTEGER,
          this.timers.now,
        );
        for (const raw of entry.envelopes) {
          const { envelope, plaintext } = await openVaultV2(
            this.options.keys,
            raw,
          );
          if (
            envelope.vaultId.toLowerCase() !==
              this.options.vaultId.toLowerCase() ||
            envelope.messageType !== "sync.update"
          ) {
            throw new VaultError(
              "VAULT_ENVELOPE_INVALID",
              "outbox entry does not belong to this Vault",
            );
          }
          const inner = reassembler.accept(envelope, plaintext);
          if (inner?.kind === "sync.update") {
            this.seen.set(inner.updateId, digestOf(inner.updates));
            const updates = inner.updates
              .filter((update) => update.length > 0)
              .map(fromB64);
            if (updates.length > 0) {
              this.options.controller.scene.applyRemoteUpdate(
                updates.length === 1 ? updates[0] : Y.mergeUpdates(updates),
              );
            }
          }
        }
      } catch (error) {
        // a broken entry must not block opening; the rest still applies
        this.options.onError?.(error);
      }
    }
  }

  private async drainOutbox() {
    if (!this.options.transport.isConnected()) {
      return;
    }
    for (const entry of await this.options.outbox.list()) {
      await this.options.transport.send(entry.envelopes, { volatile: false });
    }
  }

  private async sendContext(
    kind: "sync.context" | "sync.snapshot-request",
    reason?: "gap" | "join",
  ) {
    if (!this.options.transport.isConnected()) {
      return;
    }
    const stateVector = toB64(Y.encodeStateVector(this.doc));
    const inner: VaultV2Inner =
      kind === "sync.context"
        ? { kind, stateVector, lastKnownGeneration: this.generation }
        : { kind, stateVector, reason: reason ?? "gap" };
    const envelopes = await sealVaultV2Message(
      this.options.keys,
      this.base(kind),
      inner,
    );
    await this.options.transport.send(envelopes, { volatile: false });
  }

  /** presence is volatile and never enters the document */
  async sendPresence(payload: unknown) {
    if (!this.options.transport.isConnected()) {
      return;
    }
    const envelopes = await sealVaultV2Message(
      this.options.keys,
      this.base("presence.ephemeral"),
      {
        kind: "presence",
        payload,
      },
    );
    await this.options.transport.send(envelopes, { volatile: true });
  }

  // -------------------------------------------------------------- wire → local

  async receive(raw: unknown) {
    if (this.stopped || this.status === "blocked") {
      return;
    }
    let opened: Awaited<ReturnType<typeof openVaultV2>>;
    try {
      opened = await openVaultV2(this.options.keys, raw);
    } catch (error) {
      this.options.onError?.(error);
      return; // N1–N6: rejected, never applied
    }
    const { envelope, plaintext } = opened;
    if (
      envelope.vaultId.toLowerCase() !== this.options.vaultId.toLowerCase() ||
      envelope.roomId !== this.options.roomId
    ) {
      this.options.onError?.(
        new VaultError(
          "VAULT_ENVELOPE_INVALID",
          "envelope for another Vault/room",
        ),
      );
      return;
    }
    let inner: VaultV2Inner | null;
    try {
      inner = this.reassembler.accept(envelope, plaintext);
    } catch (error) {
      this.options.onError?.(error);
      return;
    }
    if (!inner) {
      this.refreshStatus();
      return;
    }
    switch (inner.kind) {
      case "sync.update":
        this.applyUpdate(inner);
        break;
      case "sync.context":
        await this.answerContext(inner.stateVector, true);
        break;
      case "sync.snapshot-request":
        await this.answerContext(inner.stateVector, false);
        break;
      case "sync.snapshot":
        this.applySnapshot(inner, envelope.generation);
        break;
      case "presence":
        this.options.onPresence?.(inner.payload);
        break;
    }
    this.refreshStatus();
  }

  private applyUpdate(inner: SyncUpdateV2) {
    const digest = digestOf(inner.updates);
    const known = this.seen.get(inner.updateId);
    if (known !== undefined) {
      if (known !== digest) {
        this.options.onError?.(
          new VaultError(
            "VAULT_REPLAY_REJECTED",
            "updateId reused with different content (N9)",
          ),
        );
      }
      return;
    }
    this.seen.set(inner.updateId, digest);
    if (this.seen.size > 20_000) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) {
        this.seen.delete(oldest);
      }
    }
    const updates = inner.updates
      .filter((update) => update.length > 0)
      .map(fromB64);
    if (updates.length > 0) {
      this.options.controller.applyRemote(
        updates.length === 1 ? updates[0] : Y.mergeUpdates(updates),
      );
    }
    if (inner.baseStateVector.length > 0) {
      const base = Y.decodeStateVector(fromB64(inner.baseStateVector));
      this.noteGap(base);
    }
    this.noteGap(null);
  }

  /** S3: the author knew more than we have → wait briefly, then ask */
  private noteGap(base: Map<number, number> | null) {
    const ours = Y.decodeStateVector(Y.encodeStateVector(this.doc));
    if (base && svAhead(base, ours)) {
      const target = this.gapTarget ?? new Map<number, number>();
      for (const [client, clock] of base) {
        target.set(client, Math.max(target.get(client) ?? 0, clock));
      }
      this.gapTarget = target;
    }
    if (
      this.gapTarget &&
      !svAhead(this.gapTarget, ours) &&
      !this.doc.store.pendingStructs
    ) {
      this.gapTarget = null;
      if (this.gapTimer !== null) {
        this.timers.clearTimeout(this.gapTimer);
        this.gapTimer = null;
      }
      return;
    }
    if (
      (this.gapTarget || this.doc.store.pendingStructs) &&
      this.gapTimer === null
    ) {
      this.gapTimer = this.timers.setTimeout(() => {
        this.gapTimer = null;
        const now = Y.decodeStateVector(Y.encodeStateVector(this.doc));
        if (
          (this.gapTarget && svAhead(this.gapTarget, now)) ||
          this.doc.store.pendingStructs
        ) {
          void this.sendContext("sync.snapshot-request", "gap");
          this.gapTimer = this.timers.setTimeout(() => {
            this.gapTimer = null;
            this.noteGap(null);
          }, this.config.gapGraceMs);
        } else {
          this.gapTarget = null;
          this.refreshStatus();
        }
      }, this.config.gapGraceMs);
    }
  }

  /** answers a peer's state vector with what it lacks; asks back if it is ahead */
  private async answerContext(stateVectorB64: string, askBack: boolean) {
    if (stateVectorB64.length === 0) {
      return;
    }
    const theirs = Y.decodeStateVector(fromB64(stateVectorB64));
    const ours = Y.decodeStateVector(Y.encodeStateVector(this.doc));
    // always answer: a state vector does not cover deletions, so "not ahead"
    // does not mean "nothing to send" (the diff is tiny when equal)
    if (this.options.role === "editor") {
      const diff = Y.encodeStateAsUpdate(this.doc, fromB64(stateVectorB64));
      const inner: SyncUpdateV2 = {
        kind: "sync.update",
        updateId: createVaultV2MessageId(),
        authorActorId: this.options.controller.scene.actorId,
        authorClock: this.options.controller.scene.observedMaxClock,
        baseStateVector: "",
        updates: [toB64(diff)],
        baseGeneration: this.generation,
      };
      const envelopes = await sealVaultV2Message(
        this.options.keys,
        this.base("sync.update"),
        inner,
      );
      await this.options.transport.send(envelopes, { volatile: false });
    }
    if (askBack && svAhead(theirs, ours)) {
      await this.sendContext("sync.context");
    }
  }

  // -------------------------------------------------------------- snapshots

  private applySnapshot(inner: SyncSnapshotV2, generation: number) {
    if (inner.state.length > 0) {
      this.options.controller.applyRemote(fromB64(inner.state));
    }
    this.generation = Math.max(this.generation, generation, inner.generation);
    void this.retireOutbox();
    this.noteGap(null);
  }

  private async loadSnapshot() {
    const loaded = await this.options.snapshots.load();
    if (!loaded) {
      return;
    }
    const reassembler = new VaultV2Reassembler(
      Number.MAX_SAFE_INTEGER,
      this.timers.now,
    );
    for (const raw of loaded.envelopes) {
      const { envelope, plaintext } = await openVaultV2(this.options.keys, raw);
      if (
        envelope.messageType !== "snapshot.scene" ||
        envelope.generation !== loaded.generation
      ) {
        throw new VaultError(
          "VAULT_ENVELOPE_INVALID",
          "snapshot chunk does not belong to the loaded generation",
        );
      }
      const inner = reassembler.accept(envelope, plaintext);
      if (inner) {
        if (inner.kind !== "sync.snapshot") {
          throw new VaultError("VAULT_ENVELOPE_INVALID", "not a snapshot");
        }
        this.options.controller.scene.applyRemoteUpdate(fromB64(inner.state));
        if (inner.stateVector.length > 0) {
          this.snapshotSv = Y.decodeStateVector(fromB64(inner.stateVector));
        }
      }
    }
    if (reassembler.pendingGroups > 0) {
      throw new VaultError(
        "VAULT_ENVELOPE_INVALID",
        "incomplete snapshot (N12)",
      );
    }
    this.generation = Math.max(this.generation, loaded.generation);
    await this.retireOutbox();
  }

  /** outbox entries contained in the latest known snapshot can go */
  private async retireOutbox() {
    // only a *stored* snapshot (written or loaded) retires entries
    if (!this.snapshotSv) {
      return;
    }
    const covered = (await this.options.outbox.list())
      .filter(
        (entry) =>
          (this.snapshotSv!.get(entry.clientId) ?? 0) >= entry.clockAfter,
      )
      .map((entry) => entry.updateId);
    if (covered.length > 0) {
      await this.options.outbox.remove(covered);
    }
  }

  private scheduleSnapshotTimer() {
    if (this.options.role !== "editor" || this.stopped) {
      return;
    }
    this.snapshotTimer = this.timers.setTimeout(() => {
      this.snapshotTimer = null;
      void this.writeSnapshot("timer").finally(() =>
        this.scheduleSnapshotTimer(),
      );
    }, this.config.snapshotEveryMs);
  }

  /**
   * Writes a snapshot (editors only). `reason` "hidden" is the
   * visibilitychange/pagehide trigger (W2 §6.3). Never while a gap is open.
   */
  writeSnapshot(
    reason: "count" | "timer" | "hidden" | "manual",
  ): Promise<void> {
    if (this.options.role !== "editor" || this.status === "blocked") {
      return Promise.resolve();
    }
    if (this.writingSnapshot) {
      return this.writingSnapshot;
    }
    const run = async () => {
      if (this.gapTarget || this.doc.store.pendingStructs) {
        return;
      }
      if (reason === "timer" && this.updatesSinceSnapshot === 0) {
        return;
      }
      await this.flushNow();
      const expectedGeneration = this.generation;
      const svBytes = Y.encodeStateVector(this.doc);
      const inner: SyncSnapshotV2 = {
        kind: "sync.snapshot",
        snapshotId: createVaultV2MessageId(),
        authorActorId: this.options.controller.scene.actorId,
        authorClock: this.options.controller.scene.observedMaxClock,
        generation: expectedGeneration + 1,
        stateVector: toB64(svBytes),
        state: toB64(Y.encodeStateAsUpdate(this.doc)),
      };
      const envelopes = await sealVaultV2Message(
        this.options.keys,
        { ...this.base("snapshot.scene"), generation: expectedGeneration + 1 },
        inner,
      );
      const result = await this.options.snapshots.cas({
        expectedGeneration,
        snapshotId: inner.snapshotId,
        envelopes,
      });
      if (result.ok) {
        this.generation = result.generation;
        this.snapshotSv = Y.decodeStateVector(svBytes);
        this.updatesSinceSnapshot = 0;
        this.lastSnapshotAt = this.timers.now();
        await this.retireOutbox();
        return;
      }
      // CAS conflict: someone else wrote. Merge theirs (CRDT), retry next cycle.
      await this.loadSnapshot();
      this.options.controller.flushToEditor();
    };
    this.writingSnapshot = run()
      .catch((error) => this.options.onError?.(error))
      .finally(() => {
        this.writingSnapshot = null;
      });
    return this.writingSnapshot;
  }

  get stats() {
    return {
      generation: this.generation,
      updatesSinceSnapshot: this.updatesSinceSnapshot,
      lastSnapshotAt: this.lastSnapshotAt,
      pendingChunkGroups: this.reassembler.pendingGroups,
      gapOpen: this.gapTarget !== null,
    };
  }
}
