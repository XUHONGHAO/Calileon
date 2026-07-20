import type { VaultSnapshotEncryptedEnvelopeV1 } from "../../../excalidraw-app/data/vault/types";

(globalThis as typeof globalThis & { window: typeof globalThis }).window =
  globalThis;

const { generateVaultRootKey } = await import(
  "../../../excalidraw-app/data/vault/crypto"
);
const { decryptVaultSnapshot, encryptVaultSnapshot } = await import(
  "../../../excalidraw-app/data/vault/snapshot"
);
const { base64UrlToBytes } = await import(
  "../../../excalidraw-app/data/vault/encoding"
);

const VAULT_ID = "40000000-0000-4000-8000-000000000002";
const GENERATION = 1;
const PAYLOAD = Object.freeze({
  marker: "P4A-F4-RESTORE-CRYPTO-FIXTURE",
  elements: [{ id: "encrypted-restore-sentinel" }],
  files: {},
});

const readStdin = async () => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
};

const generateFixture = async () => {
  const rootKey = generateVaultRootKey();
  const envelope = await encryptVaultSnapshot({
    vaultId: VAULT_ID,
    rootKey,
    generation: GENERATION,
    snapshot: PAYLOAD,
  });
  process.stdout.write(
    JSON.stringify({
      vaultId: VAULT_ID,
      generation: GENERATION,
      rootKey,
      payload: PAYLOAD,
      envelope,
      ciphertextBytes: base64UrlToBytes(envelope.ciphertext).byteLength,
    }),
  );
};

const verifyFixture = async () => {
  const fixture = JSON.parse(await readStdin()) as {
    vaultId: string;
    generation: number;
    rootKey: string;
    payload: unknown;
    envelope: VaultSnapshotEncryptedEnvelopeV1;
  };
  const restored = await decryptVaultSnapshot({
    vaultId: fixture.vaultId,
    rootKey: fixture.rootKey,
    generation: fixture.generation,
    envelope: fixture.envelope,
  });
  if (JSON.stringify(restored) !== JSON.stringify(fixture.payload)) {
    throw new Error("Restored Vault snapshot plaintext mismatch");
  }

  try {
    await decryptVaultSnapshot({
      vaultId: fixture.vaultId,
      rootKey: generateVaultRootKey(),
      generation: fixture.generation,
      envelope: fixture.envelope,
    });
    throw new Error("Incorrect Vault key unexpectedly decrypted snapshot");
  } catch (error) {
    if ((error as { code?: string }).code !== "VAULT_DECRYPT_FAILED") {
      throw error;
    }
  }

  process.stdout.write(
    "Restored AES-GCM Vault snapshot passed correct-key and wrong-key gates.\n",
  );
};

const mode = process.argv[2];
if (mode === "generate") {
  await generateFixture();
} else if (mode === "verify") {
  await verifyFixture();
} else {
  throw new Error("Expected restore crypto fixture mode: generate or verify");
}
