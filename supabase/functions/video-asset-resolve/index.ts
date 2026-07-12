/* eslint-disable */

import { errorResponse, getCorsHeaders, jsonResponse } from "../_shared/http.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase.ts";
import { verifyCollabAssetToken } from "../_shared/videoSecurity.ts";

const BUCKET = "excalidraw-assets";
const URL_TTL_SECONDS = 10 * 60;

const isAllowedEmbedOrigin = (origin: string, allowedOrigins: string[]) =>
  allowedOrigins.includes("*") || allowedOrigins.includes(origin);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getCorsHeaders(request) });
  }
  if (request.method !== "POST") {
    return errorResponse(request, 405, "method-not-allowed");
  }

  try {
    const body = await request.json();
    const assetId = typeof body.assetId === "string" ? body.assetId : "";
    const access = body.access;
    if (!assetId || !access || typeof access.kind !== "string") {
      return errorResponse(request, 400, "invalid-request");
    }

    const serviceClient = createServiceClient();
    const { data: asset } = await serviceClient
      .from("assets")
      .select("id,owner_id,scene_id,storage_path,mime_type,type")
      .eq("id", assetId)
      .eq("type", "ai-video-output")
      .is("deleted_at", null)
      .single();
    if (!asset?.scene_id) {
      return errorResponse(request, 404, "asset-not-found");
    }

    let authorized = false;
    if (access.kind === "owner") {
      const userClient = createUserClient(request);
      const { data } = await userClient.auth.getUser();
      authorized = data.user?.id === asset.owner_id;
    } else if (access.kind === "share" && typeof access.token === "string") {
      const { data: share } = await serviceClient
        .from("shares")
        .select("scene_id,revoked,expires_at")
        .eq("token", access.token)
        .eq("scene_id", asset.scene_id)
        .eq("revoked", false)
        .maybeSingle();
      authorized =
        !!share &&
        (!share.expires_at || Date.parse(share.expires_at) > Date.now());
    } else if (access.kind === "embed" && typeof access.token === "string") {
      const requestOrigin = request.headers.get("Origin") || "";
      const { data: embed } = await serviceClient
        .from("embeds")
        .select("scene_id,revoked,allowed_origins")
        .eq("token", access.token)
        .eq("scene_id", asset.scene_id)
        .eq("revoked", false)
        .maybeSingle();
      authorized =
        !!embed &&
        !!requestOrigin &&
        requestOrigin === access.origin &&
        isAllowedEmbedOrigin(requestOrigin, embed.allowed_origins || []);
    } else if (
      access.kind === "collab" &&
      typeof access.accessToken === "string"
    ) {
      const secret = Deno.env.get("COLLAB_ASSET_JWT_SECRET") || "";
      authorized =
        !!secret &&
        (await verifyCollabAssetToken({
          token: access.accessToken,
          secret,
          sceneId: asset.scene_id,
        }));
    }

    if (!authorized) {
      return errorResponse(request, 403, "forbidden-asset");
    }

    const { data, error } = await serviceClient.storage
      .from(BUCKET)
      .createSignedUrl(asset.storage_path, URL_TTL_SECONDS);
    if (error || !data?.signedUrl) {
      return errorResponse(request, 502, "asset-url-failed");
    }

    return jsonResponse(request, 200, {
      url: data.signedUrl,
      expiresAt: Date.now() + URL_TTL_SECONDS * 1000,
      mimeType: asset.mime_type || "application/octet-stream",
    });
  } catch {
    return errorResponse(request, 500, "asset-resolve-failed");
  }
});
