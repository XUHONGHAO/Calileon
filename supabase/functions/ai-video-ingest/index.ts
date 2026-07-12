/* eslint-disable */

import { errorResponse, getCorsHeaders, jsonResponse } from "../_shared/http.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase.ts";
import {
  fetchVideoWithValidatedRedirects,
  parseAllowedVideoHosts,
  readVideoBodyWithLimit,
} from "../_shared/videoSecurity.ts";

const BUCKET = "excalidraw-assets";
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(["video/mp4", "video/webm"]);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getCorsHeaders(request) });
  }
  if (request.method !== "POST") {
    return errorResponse(request, 405, "method-not-allowed");
  }

  try {
    const body = await request.json();
    const sceneId = typeof body.sceneId === "string" ? body.sceneId : "";
    const sourceUrl = typeof body.sourceUrl === "string" ? body.sourceUrl : "";
    const idempotencyKey =
      typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
    const expectedMimeType =
      typeof body.expectedMimeType === "string"
        ? body.expectedMimeType.toLowerCase()
        : undefined;
    if (!sceneId || !sourceUrl || !idempotencyKey) {
      return errorResponse(request, 400, "invalid-request");
    }

    const userClient = createUserClient(request);
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user) {
      return errorResponse(request, 401, "unauthorized");
    }

    const serviceClient = createServiceClient();
    const { data: scene } = await serviceClient
      .from("scenes")
      .select("id,owner_id")
      .eq("id", sceneId)
      .eq("owner_id", authData.user.id)
      .is("deleted_at", null)
      .single();
    if (!scene) {
      return errorResponse(request, 403, "forbidden-scene");
    }

    const { data: existing } = await serviceClient
      .from("assets")
      .select("id,mime_type,bytes")
      .eq("owner_id", authData.user.id)
      .eq("scene_id", sceneId)
      .eq("file_id", idempotencyKey)
      .eq("type", "ai-video-output")
      .is("deleted_at", null)
      .maybeSingle();
    if (existing) {
      return jsonResponse(request, 200, {
        assetId: existing.id,
        mimeType: existing.mime_type,
        bytes: Number(existing.bytes),
      });
    }

    const allowedHosts = parseAllowedVideoHosts(
      Deno.env.get("AI_VIDEO_INGEST_ALLOWED_HOSTS"),
    );
    if (!allowedHosts.length) {
      return errorResponse(request, 503, "video-ingest-not-configured");
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      Number(Deno.env.get("AI_VIDEO_INGEST_TIMEOUT_MS") || 60_000),
    );
    let response: Response;
    try {
      response = await fetchVideoWithValidatedRedirects({
        sourceUrl,
        allowedHosts,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
    if (!response.ok) {
      return errorResponse(request, 502, "video-download-failed");
    }

    const mimeType = (response.headers.get("Content-Type") || "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (
      !ALLOWED_MIME_TYPES.has(mimeType) ||
      (expectedMimeType && expectedMimeType !== mimeType)
    ) {
      return errorResponse(request, 415, "unsupported-video-type");
    }

    const maxBytes = Number(
      Deno.env.get("AI_VIDEO_INGEST_MAX_BYTES") || DEFAULT_MAX_BYTES,
    );
    const bytes = await readVideoBodyWithLimit(response, maxBytes);
    const storagePath = `${authData.user.id}/${sceneId}/${idempotencyKey}`;
    const { error: uploadError } = await serviceClient.storage
      .from(BUCKET)
      .upload(storagePath, bytes, {
        contentType: mimeType,
        upsert: false,
      });
    if (uploadError) {
      return errorResponse(request, 502, "video-upload-failed");
    }

    const { data: asset, error: assetError } = await serviceClient
      .from("assets")
      .insert({
        owner_id: authData.user.id,
        scene_id: sceneId,
        file_id: idempotencyKey,
        type: "ai-video-output",
        storage_path: storagePath,
        mime_type: mimeType,
        bytes: bytes.byteLength,
      })
      .select("id,mime_type,bytes")
      .single();
    if (assetError || !asset) {
      await serviceClient.storage.from(BUCKET).remove([storagePath]);
      return errorResponse(request, 502, "video-metadata-failed");
    }

    return jsonResponse(request, 200, {
      assetId: asset.id,
      mimeType: asset.mime_type,
      bytes: Number(asset.bytes),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "video-too-large") {
      return errorResponse(request, 413, "video-too-large");
    }
    if (
      message === "video-source-not-allowed" ||
      message === "video-source-redirect-rejected"
    ) {
      return errorResponse(request, 403, message);
    }
    if ((error as { name?: string } | null)?.name === "AbortError") {
      return errorResponse(request, 504, "video-download-timeout");
    }
    return errorResponse(request, 500, "video-ingest-failed");
  }
});
