import {
  assertVaultDeploymentReadyToken,
  type VaultDeploymentReady,
} from "../../vault/capabilities";
import {
  createVaultEncryptedAssetService,
  type VaultEncryptedAssetService,
  type VaultEncryptedAssetInput,
} from "../../vault/assets";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  isCanonicalBase64Url,
} from "../../vault/encoding";
import { isVaultErrorCode, VaultError } from "../../vault/errors";
import { assertVaultEncryptedEnvelopeV1 } from "../../vault/protocol";

import { getSupabaseClient } from "./client";
import { mapSupabaseVaultError } from "./SupabaseVaultPersistenceService";

import type { VaultAssetEncryptedEnvelopeV1 } from "../../vault/types";

const VAULT_ASSET_FUNCTION = "vault-asset-access";
const VAULT_ASSET_BUCKET = "vault-assets";
const MAX_VAULT_ASSET_BYTES = 104_857_600;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILE_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;

interface VaultFunctionResult {
  data: unknown;
  error: unknown;
}

interface VaultStorageResult {
  data: unknown;
  error: unknown;
}

export interface SupabaseVaultAssetClient {
  functions: {
    invoke(
      functionName: string,
      options: { body: Readonly<Record<string, unknown>> },
    ): PromiseLike<VaultFunctionResult>;
  };
  storage: {
    from(bucket: string): {
      uploadToSignedUrl(
        storagePath: string,
        token: string,
        data: Uint8Array<ArrayBuffer>,
        options: { upsert: false },
      ): PromiseLike<VaultStorageResult>;
    };
  };
}

export interface VaultAssetFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type VaultAssetFetcher = (
  url: string,
) => Promise<VaultAssetFetchResponse>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertExactKeys = (
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new VaultError("VAULT_INTERNAL", "Invalid Vault asset response.");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    !expected.every((key) => keys.includes(key))
  ) {
    throw new VaultError("VAULT_INTERNAL", "Invalid Vault asset response.");
  }
  return value;
};

const assertAssetInput = (input: VaultEncryptedAssetInput) => {
  if (!UUID_RE.test(input.vaultId)) {
    throw new VaultError("VAULT_URL_INVALID", "Invalid Vault ID.");
  }
  if (
    input.invitationCapability.length !== 43 ||
    !isCanonicalBase64Url(input.invitationCapability, 32)
  ) {
    throw new VaultError(
      "VAULT_CAPABILITY_INVALID",
      "Invalid Vault capability.",
    );
  }
  if (!FILE_ID_RE.test(input.fileId)) {
    throw new VaultError("VAULT_ENVELOPE_INVALID", "Invalid Vault file ID.");
  }
};

export const serializeVaultAssetEnvelope = (
  envelope: VaultAssetEncryptedEnvelopeV1,
): Uint8Array<ArrayBuffer> => {
  assertVaultEncryptedEnvelopeV1(envelope);
  if (envelope.purpose !== "asset") {
    throw new VaultError("VAULT_ENVELOPE_INVALID", "Invalid Vault asset.");
  }
  return new TextEncoder().encode(
    JSON.stringify({
      version: envelope.version,
      vaultId: envelope.vaultId,
      purpose: envelope.purpose,
      messageType: envelope.messageType,
      messageId: envelope.messageId,
      iv: envelope.iv,
      ciphertext: envelope.ciphertext,
    }),
  );
};

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < left.byteLength; index++) {
    mismatch |= left[index] ^ right[index];
  }
  return mismatch === 0;
};

const digestBytes = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => {
  if (!globalThis.crypto?.subtle) {
    throw new VaultError(
      "VAULT_CRYPTO_UNAVAILABLE",
      "WebCrypto is unavailable.",
    );
  }
  return bytesToBase64Url(
    new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)),
  );
};

const assertAssetSize = (bytes: number) => {
  if (bytes <= 0 || bytes > MAX_VAULT_ASSET_BYTES) {
    throw new VaultError(
      "VAULT_PAYLOAD_TOO_LARGE",
      "Vault asset exceeds the allowed size.",
    );
  }
};

const mapStableFunctionErrorBody = (value: unknown): VaultError | null => {
  if (!isRecord(value) || Object.keys(value).length !== 1) {
    return null;
  }
  return isVaultErrorCode(value.error)
    ? mapSupabaseVaultError({ code: "P0001", message: value.error })
    : null;
};

const mapFunctionError = async (
  error: unknown,
  data: unknown,
): Promise<VaultError> => {
  const dataError = mapStableFunctionErrorBody(data);
  if (dataError) {
    return dataError;
  }
  const context =
    isRecord(error) && "context" in error ? error.context : undefined;
  if (
    context &&
    typeof context === "object" &&
    "json" in context &&
    typeof (context as { json?: unknown }).json === "function"
  ) {
    try {
      const body = await (context as { json(): Promise<unknown> }).json();
      const contextError = mapStableFunctionErrorBody(body);
      if (contextError) {
        return contextError;
      }
    } catch {
      // Only the stable JSON error field is accepted.
    }
  }
  return mapSupabaseVaultError(error);
};

const mapCreateUploadResponse = (
  value: unknown,
  vaultId: string,
  fileId: string,
): {
  storagePath: string;
  token: string | null;
  state: "pending" | "ready";
} => {
  const response = assertExactKeys(value, ["storagePath", "token", "state"]);
  const expectedPath = `vault/${vaultId.toLowerCase()}/${fileId}`;
  if (
    response.storagePath !== expectedPath ||
    (response.state !== "pending" && response.state !== "ready") ||
    (response.state === "pending" &&
      (typeof response.token !== "string" ||
        response.token.length === 0 ||
        response.token.length > 4096)) ||
    (response.state === "ready" && response.token !== null)
  ) {
    throw new VaultError("VAULT_INTERNAL", "Invalid Vault asset response.");
  }
  return {
    storagePath: expectedPath,
    token: response.token as string | null,
    state: response.state,
  };
};

const mapCompleteUploadResponse = (
  value: unknown,
  vaultId: string,
  fileId: string,
) => {
  const response = assertExactKeys(value, ["vaultId", "fileId", "state"]);
  if (
    response.vaultId !== vaultId ||
    response.fileId !== fileId ||
    response.state !== "ready"
  ) {
    throw new VaultError("VAULT_INTERNAL", "Invalid Vault asset response.");
  }
};

const mapCreateDownloadResponse = (
  value: unknown,
): {
  url: string;
  encryptedDigest: string;
  ciphertextBytes: number;
} => {
  const response = assertExactKeys(value, [
    "url",
    "expiresAt",
    "encryptedDigest",
    "ciphertextBytes",
  ]);
  if (
    typeof response.url !== "string" ||
    response.url.length === 0 ||
    response.url.length > 8192 ||
    typeof response.expiresAt !== "number" ||
    !Number.isSafeInteger(response.expiresAt) ||
    response.expiresAt <= Date.now() ||
    typeof response.encryptedDigest !== "string" ||
    response.encryptedDigest.length !== 43 ||
    !isCanonicalBase64Url(response.encryptedDigest, 32) ||
    typeof response.ciphertextBytes !== "number" ||
    !Number.isSafeInteger(response.ciphertextBytes)
  ) {
    throw new VaultError("VAULT_INTERNAL", "Invalid Vault asset response.");
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(response.url);
  } catch {
    throw new VaultError("VAULT_INTERNAL", "Invalid Vault asset response.");
  }
  if (
    (parsedUrl.protocol !== "https:" &&
      !(
        parsedUrl.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(parsedUrl.hostname)
      )) ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.hash
  ) {
    throw new VaultError("VAULT_INTERNAL", "Invalid Vault asset response.");
  }
  assertAssetSize(response.ciphertextBytes);
  return {
    url: response.url,
    encryptedDigest: response.encryptedDigest,
    ciphertextBytes: response.ciphertextBytes,
  };
};

const parseDownloadedEnvelope = (
  bytes: Uint8Array<ArrayBuffer>,
  vaultId: string,
): VaultAssetEncryptedEnvelopeV1 => {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Invalid Vault asset envelope.",
    );
  }
  assertVaultEncryptedEnvelopeV1(value);
  if (value.purpose !== "asset" || value.vaultId !== vaultId) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Invalid Vault asset envelope.",
    );
  }
  if (!equalBytes(bytes, serializeVaultAssetEnvelope(value))) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Vault asset envelope is not canonically serialized.",
    );
  }
  return value;
};

export const createSupabaseVaultEncryptedAssetService = (
  deployment: VaultDeploymentReady,
  options?: {
    client?: SupabaseVaultAssetClient;
    fetcher?: VaultAssetFetcher;
  },
): VaultEncryptedAssetService => {
  assertVaultDeploymentReadyToken(deployment);
  const getClient = () =>
    options?.client ??
    (getSupabaseClient() as unknown as SupabaseVaultAssetClient);
  const fetcher: VaultAssetFetcher =
    options?.fetcher ?? (async (url) => await fetch(url));

  const invoke = async (
    body: Readonly<Record<string, unknown>>,
  ): Promise<unknown> => {
    try {
      const { data, error } = await getClient().functions.invoke(
        VAULT_ASSET_FUNCTION,
        { body },
      );
      if (error) {
        throw await mapFunctionError(error, data);
      }
      const stableError = mapStableFunctionErrorBody(data);
      if (stableError) {
        throw stableError;
      }
      return data;
    } catch (error) {
      if (error instanceof VaultError) {
        throw error;
      }
      throw mapSupabaseVaultError(error);
    }
  };

  return createVaultEncryptedAssetService(deployment, {
    upload: async (input) => {
      assertAssetInput(input);
      assertVaultEncryptedEnvelopeV1(input.envelope);
      if (
        input.envelope.purpose !== "asset" ||
        input.envelope.vaultId !== input.vaultId
      ) {
        throw new VaultError("VAULT_ENVELOPE_INVALID", "Invalid Vault asset.");
      }
      const bytes = serializeVaultAssetEnvelope(input.envelope);
      assertAssetSize(bytes.byteLength);
      const encryptedDigest = await digestBytes(bytes);
      const createUpload = mapCreateUploadResponse(
        await invoke({
          action: "create-upload",
          vaultId: input.vaultId,
          invitationCapability: input.invitationCapability,
          fileId: input.fileId,
          encryptedDigest,
          ciphertextBytes: bytes.byteLength,
        }),
        input.vaultId,
        input.fileId,
      );
      if (createUpload.state === "pending") {
        try {
          const { error } = await getClient()
            .storage.from(VAULT_ASSET_BUCKET)
            .uploadToSignedUrl(
              createUpload.storagePath,
              createUpload.token as string,
              bytes,
              { upsert: false },
            );
          if (error) {
            throw mapSupabaseVaultError(error);
          }
        } catch (error) {
          if (error instanceof VaultError) {
            throw error;
          }
          throw mapSupabaseVaultError(error);
        }
        mapCompleteUploadResponse(
          await invoke({
            action: "complete-upload",
            vaultId: input.vaultId,
            invitationCapability: input.invitationCapability,
            fileId: input.fileId,
          }),
          input.vaultId,
          input.fileId,
        );
      }
      return {
        vaultId: input.vaultId,
        fileId: input.fileId,
        encryptedDigest,
        ciphertextBytes: bytes.byteLength,
      };
    },
    download: async (input) => {
      assertAssetInput(input);
      const access = mapCreateDownloadResponse(
        await invoke({
          action: "create-download",
          vaultId: input.vaultId,
          invitationCapability: input.invitationCapability,
          fileId: input.fileId,
        }),
      );
      let response: VaultAssetFetchResponse;
      try {
        response = await fetcher(access.url);
      } catch (error) {
        throw mapSupabaseVaultError(error);
      }
      if (!response.ok) {
        throw mapSupabaseVaultError({ status: response.status });
      }
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        throw mapSupabaseVaultError(error);
      }
      assertAssetSize(bytes.byteLength);
      if (bytes.byteLength !== access.ciphertextBytes) {
        throw new VaultError(
          "VAULT_ASSET_CONFLICT",
          "Vault asset size does not match metadata.",
        );
      }
      const actualDigest = await digestBytes(bytes);
      if (
        !equalBytes(
          base64UrlToBytes(actualDigest),
          base64UrlToBytes(access.encryptedDigest),
        )
      ) {
        throw new VaultError(
          "VAULT_ASSET_CONFLICT",
          "Vault asset digest does not match metadata.",
        );
      }
      return {
        vaultId: input.vaultId,
        fileId: input.fileId,
        encryptedDigest: actualDigest,
        ciphertextBytes: bytes.byteLength,
        envelope: parseDownloadedEnvelope(bytes, input.vaultId),
      };
    },
  });
};
