import {
  VAULT_V2_CHUNK_RAW_BYTES,
  VaultV2Reassembler,
  assertVaultEnvelopeV2,
  createVaultV2Keys,
  openVaultV2,
  sealVaultV2,
  sealVaultV2Message,
} from "./protocol";

import type { VaultEnvelopeContextV2, VaultEnvelopeV2 } from "./protocol";

const VAULT_ID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const ROOT = `${"A".repeat(42)}A`;
const keys = createVaultV2Keys(ROOT, VAULT_ID);

const context = (
  overrides: Partial<VaultEnvelopeContextV2> = {},
): VaultEnvelopeContextV2 => ({
  version: 2,
  schemaVersion: 2,
  protocolVersion: 2,
  vaultId: VAULT_ID,
  roomId: "room_1",
  purpose: "realtime.content",
  messageType: "sync.update",
  messageId: "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d",
  generation: 0,
  chunkIndex: 0,
  chunkCount: 1,
  ...overrides,
});

const base = {
  version: 2,
  schemaVersion: 2,
  protocolVersion: 2,
  vaultId: VAULT_ID,
  roomId: "room_1",
  messageType: "sync.update",
  generation: 3,
} as const;

const updateInner = (size = 4) => ({
  kind: "sync.update" as const,
  updateId: "u-1",
  authorActorId: "actor-a",
  authorClock: 1,
  baseStateVector: "",
  updates: ["A".repeat(size)],
  baseGeneration: 0,
});

describe("Vault v2 envelope (W2 §2, negative matrix N1–N6, N20)", () => {
  it("round-trips and has exactly the 13 allowed fields, no session ids (N1)", async () => {
    const envelope = await sealVaultV2(
      keys,
      context(),
      new Uint8Array([1, 2, 3]),
    );
    expect(Object.keys(envelope).sort()).toEqual(
      [
        "chunkCount",
        "chunkIndex",
        "ciphertext",
        "generation",
        "iv",
        "messageId",
        "messageType",
        "protocolVersion",
        "purpose",
        "roomId",
        "schemaVersion",
        "vaultId",
        "version",
      ].sort(),
    );
    const { plaintext } = await openVaultV2(keys, envelope);
    expect([...plaintext]).toEqual([1, 2, 3]);
  });

  it("rejects extra or missing fields, including v1 senderSessionId / sequence (N1)", async () => {
    const envelope = await sealVaultV2(keys, context(), new Uint8Array([1]));
    expect(() =>
      assertVaultEnvelopeV2({ ...envelope, senderSessionId: "x" }),
    ).toThrow(/allowlist/);
    expect(() => assertVaultEnvelopeV2({ ...envelope, sequence: 1 })).toThrow(
      /allowlist/,
    );
    const { roomId, ...missing } = envelope;
    expect(() => assertVaultEnvelopeV2(missing)).toThrow(/allowlist/);
  });

  it("rejects unknown versions without downgrade (N2), unknown purpose/type (N3)", async () => {
    const envelope = await sealVaultV2(keys, context(), new Uint8Array([1]));
    expect(() => assertVaultEnvelopeV2({ ...envelope, version: 1 })).toThrow(
      /Unsupported/,
    );
    expect(() =>
      assertVaultEnvelopeV2({ ...envelope, protocolVersion: 3 }),
    ).toThrow(/Unsupported/);
    expect(() =>
      assertVaultEnvelopeV2({ ...envelope, purpose: "realtime" }),
    ).toThrow();
    expect(() =>
      assertVaultEnvelopeV2({ ...envelope, messageType: "scene.init" }),
    ).toThrow();
  });

  it("rejects purpose/messageType mismatches used to bypass roles (N20)", async () => {
    await expect(
      sealVaultV2(
        keys,
        context({ purpose: "realtime.request", messageType: "sync.update" }),
        new Uint8Array([1]),
      ),
    ).rejects.toThrow(/does not match/);
    const envelope = await sealVaultV2(keys, context(), new Uint8Array([1]));
    expect(() =>
      assertVaultEnvelopeV2({ ...envelope, purpose: "realtime.request" }),
    ).toThrow(/does not match/);
  });

  it("rejects bad iv length and short ciphertext (N4)", async () => {
    const envelope = await sealVaultV2(keys, context(), new Uint8Array([1]));
    expect(() => assertVaultEnvelopeV2({ ...envelope, iv: "AAAA" })).toThrow(
      /iv/,
    );
    expect(() =>
      assertVaultEnvelopeV2({ ...envelope, ciphertext: "AAAA" }),
    ).toThrow(/short/);
  });

  it("tampering with ciphertext or any AAD field fails authentication (N5)", async () => {
    const envelope = await sealVaultV2(
      keys,
      context({ chunkCount: 2, chunkIndex: 0 }),
      new Uint8Array([1, 2]),
    );
    const flipped = envelope.ciphertext.startsWith("A")
      ? `B${envelope.ciphertext.slice(1)}`
      : `A${envelope.ciphertext.slice(1)}`;
    await expect(
      openVaultV2(keys, { ...envelope, ciphertext: flipped }),
    ).rejects.toThrow(/authentication/);
    await expect(
      openVaultV2(keys, { ...envelope, chunkIndex: 1 }),
    ).rejects.toThrow(/authentication/);
    await expect(
      openVaultV2(keys, { ...envelope, generation: 9 }),
    ).rejects.toThrow(/authentication/);
    await expect(
      openVaultV2(keys, { ...envelope, roomId: "room_2" }),
    ).rejects.toThrow(/authentication/);
  });

  it("cannot be opened under another purpose or Vault (N6)", async () => {
    const presence = await sealVaultV2(
      keys,
      context({
        purpose: "realtime.presence",
        messageType: "presence.ephemeral",
      }),
      new Uint8Array([1]),
    );
    // relabel as content: AAD and key both differ
    await expect(
      openVaultV2(keys, {
        ...presence,
        purpose: "realtime.content",
        messageType: "sync.update",
      }),
    ).rejects.toThrow(/authentication/);
    const otherVault = "7f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    await expect(
      openVaultV2(createVaultV2Keys(ROOT, otherVault), {
        ...presence,
        vaultId: otherVault,
      }),
    ).rejects.toThrow(/authentication/);
  });
});

describe("Vault v2 chunking (W2 §5, N10, N11)", () => {
  const openAll = async (
    envelopes: VaultEnvelopeV2[],
    reassembler = new VaultV2Reassembler(),
  ) => {
    let out = null;
    for (const envelope of envelopes) {
      const { plaintext } = await openVaultV2(keys, envelope);
      out = reassembler.accept(envelope, plaintext) ?? out;
    }
    return out;
  };

  it("a small message is one envelope; a large one splits into ≤ 1 MiB envelopes and reassembles", async () => {
    expect(await sealVaultV2Message(keys, base, updateInner())).toHaveLength(1);
    const big = updateInner(VAULT_V2_CHUNK_RAW_BYTES * 2 + 10);
    const envelopes = await sealVaultV2Message(keys, base, big);
    expect(envelopes).toHaveLength(3);
    for (const envelope of envelopes) {
      expect(JSON.stringify(envelope).length).toBeLessThan(1024 * 1024);
      expect(envelope.generation).toBe(3);
      expect(envelope.chunkCount).toBe(3);
    }
    expect(await openAll([envelopes[2], envelopes[0], envelopes[1]])).toEqual(
      big,
    );
  });

  it("nothing is returned before every chunk arrived; an incomplete group expires (N10)", async () => {
    let now = 0;
    const reassembler = new VaultV2Reassembler(30_000, () => now);
    const envelopes = await sealVaultV2Message(
      keys,
      base,
      updateInner(VAULT_V2_CHUNK_RAW_BYTES + 1),
    );
    expect(await openAll([envelopes[0]], reassembler)).toBeNull();
    now = 31_000;
    expect(reassembler.expire()).toBe(1);
    expect(reassembler.pendingGroups).toBe(0);
  });

  it("an exact duplicate chunk is ignored; inconsistent groups are rejected (N11)", async () => {
    const envelopes = await sealVaultV2Message(
      keys,
      base,
      updateInner(VAULT_V2_CHUNK_RAW_BYTES + 1),
    );
    const reassembler = new VaultV2Reassembler();
    const first = await openVaultV2(keys, envelopes[0]);
    expect(reassembler.accept(envelopes[0], first.plaintext)).toBeNull();
    expect(reassembler.accept(envelopes[0], first.plaintext)).toBeNull();
    // a chunk claiming the same group but another generation
    const forged = { ...envelopes[1], generation: 4 };
    expect(() =>
      reassembler.accept(forged as VaultEnvelopeV2, first.plaintext),
    ).toThrow();
  });
});
