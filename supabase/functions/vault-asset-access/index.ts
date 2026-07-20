/* eslint-disable */

import {
  errorResponse,
  getCorsHeaders,
  jsonResponse,
} from "../_shared/http.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import {
  assertVaultAssetEnvelopeBytes,
  assertVaultAssetRegistration,
  assertVaultAssetResolution,
  assertVaultCapabilityResolution,
  getVaultAssetErrorStatus,
  getVaultAssetStoragePath,
  parseVaultAssetAccessRequest,
  sha256Base64Url,
  toStableVaultAssetErrorCode,
  VaultAssetSecurityError,
  VAULT_ASSET_DOWNLOAD_TTL_SECONDS,
  VAULT_ASSET_MAX_BYTES,
} from "../_shared/vaultAssetSecurity.ts";

const BUCKET = Deno.env.get("VAULT_ASSET_BUCKET") || "vault-assets";

const invokeVaultRpc = async (
  client: ReturnType<typeof createServiceClient>,
  name: string,
  params: Record<string, unknown>,
) => {
  const { data, error } = await client.rpc(name, params);
  if (error) {
    throw error;
  }
  return data;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(request),
    });
  }
  if (request.method !== "POST") {
    return errorResponse(request, 405, "VAULT_ENVELOPE_INVALID");
  }

  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      throw new VaultAssetSecurityError("VAULT_ENVELOPE_INVALID");
    }
    const input = parseVaultAssetAccessRequest(rawBody);
    const serviceClient = createServiceClient();

    if (input.action === "create-upload") {
      const registration = assertVaultAssetRegistration(
        await invokeVaultRpc(serviceClient, "register_vault_asset", {
          p_vault_id: input.vaultId,
          p_capability: input.invitationCapability,
          p_file_id: input.fileId,
          p_encrypted_digest: input.encryptedDigest,
          p_ciphertext_bytes: input.ciphertextBytes,
        }),
        input.vaultId,
        input.fileId,
      );
      if (registration.state === "ready") {
        return jsonResponse(request, 200, {
          storagePath: registration.storagePath,
          token: null,
          state: "ready",
        });
      }
      const { data, error } = await serviceClient.storage
        .from(BUCKET)
        .createSignedUploadUrl(registration.storagePath, { upsert: false });
      if (
        error ||
        !data ||
        typeof data.token !== "string" ||
        !data.token ||
        (typeof data.path === "string" &&
          data.path !== registration.storagePath)
      ) {
        throw new VaultAssetSecurityError("VAULT_PERSISTENCE_UNAVAILABLE");
      }
      return jsonResponse(request, 200, {
        storagePath: registration.storagePath,
        token: data.token,
        state: "pending",
      });
    }

    if (input.action === "complete-upload") {
      assertVaultCapabilityResolution(
        await invokeVaultRpc(serviceClient, "resolve_vault_capability", {
          p_vault_id: input.vaultId,
          p_capability: input.invitationCapability,
        }),
        input.vaultId,
        "editor",
      );
      const storagePath = getVaultAssetStoragePath(input.vaultId, input.fileId);
      const { data: object, error: downloadError } = await serviceClient.storage
        .from(BUCKET)
        .download(storagePath);
      if (downloadError || !object) {
        const status = Number(
          (downloadError as { status?: unknown; statusCode?: unknown } | null)
            ?.statusCode ??
            (downloadError as { status?: unknown } | null)?.status,
        );
        throw new VaultAssetSecurityError(
          status === 404 ? "VAULT_NOT_FOUND" : "VAULT_PERSISTENCE_UNAVAILABLE",
        );
      }
      if (object.size <= 0 || object.size > VAULT_ASSET_MAX_BYTES) {
        throw new VaultAssetSecurityError(
          object.size > VAULT_ASSET_MAX_BYTES
            ? "VAULT_PAYLOAD_TOO_LARGE"
            : "VAULT_ENVELOPE_INVALID",
        );
      }
      const bytes = new Uint8Array(await object.arrayBuffer());
      assertVaultAssetEnvelopeBytes(bytes, input.vaultId);
      const observedEncryptedDigest = await sha256Base64Url(bytes);
      const completion = assertVaultAssetRegistration(
        await invokeVaultRpc(serviceClient, "complete_vault_asset", {
          p_vault_id: input.vaultId,
          p_capability: input.invitationCapability,
          p_file_id: input.fileId,
          p_observed_encrypted_digest: observedEncryptedDigest,
          p_observed_ciphertext_bytes: bytes.byteLength,
        }),
        input.vaultId,
        input.fileId,
      );
      if (completion.state !== "ready") {
        throw new VaultAssetSecurityError("VAULT_INTERNAL");
      }
      return jsonResponse(request, 200, {
        vaultId: input.vaultId,
        fileId: input.fileId,
        state: "ready",
      });
    }

    const resolution = assertVaultAssetResolution(
      await invokeVaultRpc(serviceClient, "resolve_vault_asset", {
        p_vault_id: input.vaultId,
        p_capability: input.invitationCapability,
        p_file_id: input.fileId,
      }),
      input.vaultId,
      input.fileId,
    );
    const expiresAt = Date.now() + VAULT_ASSET_DOWNLOAD_TTL_SECONDS * 1000;
    const { data, error } = await serviceClient.storage
      .from(BUCKET)
      .createSignedUrl(
        resolution.storagePath,
        VAULT_ASSET_DOWNLOAD_TTL_SECONDS,
      );
    if (
      error ||
      !data ||
      typeof data.signedUrl !== "string" ||
      !data.signedUrl
    ) {
      throw new VaultAssetSecurityError("VAULT_PERSISTENCE_UNAVAILABLE");
    }
    return jsonResponse(request, 200, {
      url: data.signedUrl,
      expiresAt,
      encryptedDigest: resolution.encryptedDigest,
      ciphertextBytes: resolution.ciphertextBytes,
    });
  } catch (error) {
    const code = toStableVaultAssetErrorCode(error);
    return errorResponse(request, getVaultAssetErrorStatus(code), code);
  }
});
