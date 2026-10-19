/**
 * In-memory stand-in for room-server v2 + the snapshot RPC, used by tests.
 * Mirrors the server rules of W2 §7.2 (S-3 allowlist, S-4 bare relay,
 * S-5 roles) and §7.3 (D-4 atomic CAS); it never sees plaintext.
 */
import { assertVaultEnvelopeV2 } from "./protocol";

import type { VaultEnvelopeV2 } from "./protocol";
import type {
  VaultV2Role,
  VaultV2SnapshotStore,
  VaultV2Transport,
} from "./syncEngine";

const ROLE_ALLOWED: Record<VaultV2Role, ReadonlySet<string>> = {
  editor: new Set([
    "realtime.content",
    "realtime.request",
    "realtime.presence",
  ]),
  viewer: new Set(["realtime.request", "realtime.presence"]),
};

export class MockVaultRoom {
  private readonly peers = new Map<
    string,
    { role: VaultV2Role; handlers: Set<(e: unknown) => void>; online: boolean }
  >();
  readonly rejected: { peer: string; reason: string }[] = [];
  /** everything the server relayed (to prove it carries no session ids) */
  readonly relayed: unknown[] = [];
  snapshot: {
    generation: number;
    snapshotId: string;
    envelopes: VaultEnvelopeV2[];
  } | null = null;
  /** hold relays instead of delivering (to test gaps / reordering) */
  hold = false;
  readonly held: { to: string; frame: unknown }[] = [];

  join(peer: string, role: VaultV2Role): VaultV2Transport {
    const entry = {
      role,
      handlers: new Set<(e: unknown) => void>(),
      online: true,
    };
    this.peers.set(peer, entry);
    return {
      isConnected: () => entry.online,
      onEnvelope: (handler) => {
        entry.handlers.add(handler);
        return () => entry.handlers.delete(handler);
      },
      send: async (envelopes) => {
        for (const envelope of envelopes) {
          this.relay(peer, envelope);
        }
      },
    };
  }

  setOnline(peer: string, online: boolean) {
    this.peers.get(peer)!.online = online;
  }

  private relay(from: string, envelope: unknown) {
    const sender = this.peers.get(from)!;
    if (!sender.online) {
      return;
    }
    try {
      assertVaultEnvelopeV2(envelope);
    } catch (error) {
      this.rejected.push({ peer: from, reason: (error as Error).message });
      return;
    }
    if (!ROLE_ALLOWED[sender.role].has(envelope.purpose)) {
      this.rejected.push({ peer: from, reason: "role" });
      return;
    }
    if (JSON.stringify(envelope).length > 1024 * 1024) {
      this.rejected.push({ peer: from, reason: "size" });
      return;
    }
    const frame = { envelope }; // S-4: no sourceSocketId / admittedSenderSessionId
    for (const [name, peer] of this.peers) {
      if (name === from || !peer.online) {
        continue;
      }
      this.relayed.push(frame);
      if (this.hold) {
        this.held.push({ to: name, frame });
      } else {
        for (const handler of peer.handlers) {
          handler(frame.envelope);
        }
      }
    }
  }

  /** delivers held frames, optionally in a given order */
  release(
    order?: (
      frames: { to: string; frame: unknown }[],
    ) => { to: string; frame: unknown }[],
  ) {
    const frames = order ? order([...this.held]) : [...this.held];
    this.held.length = 0;
    for (const { to, frame } of frames) {
      for (const handler of this.peers.get(to)?.handlers ?? []) {
        handler((frame as { envelope: unknown }).envelope);
      }
    }
  }

  /** D-4/D-6 semantics: atomic multi-chunk CAS on the generation */
  snapshotStore(role: VaultV2Role): VaultV2SnapshotStore {
    return {
      load: async () =>
        this.snapshot
          ? {
              generation: this.snapshot.generation,
              envelopes: this.snapshot.envelopes,
            }
          : null,
      cas: async ({ expectedGeneration, snapshotId, envelopes }) => {
        if (role !== "editor") {
          throw new Error("viewer cannot write snapshots");
        }
        const current = this.snapshot?.generation ?? 0;
        if (this.snapshot?.snapshotId === snapshotId) {
          return { ok: true, generation: current };
        }
        if (current !== expectedGeneration) {
          return { ok: false, reason: "conflict" };
        }
        for (const envelope of envelopes) {
          assertVaultEnvelopeV2(envelope);
          if (
            envelope.messageType !== "snapshot.scene" ||
            envelope.generation !== current + 1
          ) {
            throw new Error("bad snapshot envelope");
          }
        }
        this.snapshot = {
          generation: current + 1,
          snapshotId,
          envelopes: [...envelopes],
        };
        return { ok: true, generation: current + 1 };
      },
    };
  }
}
