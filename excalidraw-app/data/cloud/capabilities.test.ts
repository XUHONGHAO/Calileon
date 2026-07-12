import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readCapabilities } from "./capabilities";

/**
 * capabilities derive from env. We stub the Supabase + collab env vars to
 * verify the deployment-tier matrix (decision 0008 §1.3): Supabase configured
 * → auth/sceneStorage on + self-hosted tier; absent → pure-local, all off.
 */
describe("readCapabilities", () => {
  beforeEach(() => {
    // Start from a clean slate: nothing configured.
    vi.stubEnv("VITE_APP_SUPABASE_URL", "");
    vi.stubEnv("VITE_APP_SUPABASE_ANON_KEY", "");
    vi.stubEnv("VITE_APP_WS_SERVER_URL", "");
    vi.stubEnv("VITE_APP_FIREBASE_CONFIG", "");
    vi.stubEnv("VITE_APP_BACKEND_V2_POST_URL", "");
    vi.stubEnv("VITE_APP_COLLAB_PERSISTENCE", "");
    vi.stubEnv("VITE_APP_E2E_CLOUD_STORAGE", "");
    vi.stubEnv("VITE_APP_REMOTE_VIDEO_ASSETS", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is pure-local with everything off when nothing is configured", () => {
    const caps = readCapabilities();
    expect(caps.tier).toBe("local");
    expect(caps.auth).toBe(false);
    expect(caps.sceneStorage).toBe(false);
    expect(caps.assetStorage).toBe(false);
    expect(caps.share).toBe(false);
    expect(caps.aiTasks).toBe(false);
    expect(caps.collaborationMetadata).toBe(false);
    expect(caps.cast).toBe(false);
    expect(caps.embed).toBe(false);
    expect(caps.aiGateway).toBe(false);
    expect(caps.realtime).toBe(false);
    expect(caps.collabRoomBinding).toBe(false);
    expect(caps.collabPersistence).toBe(false);
    expect(caps.encryptedCloudStorage).toBe(false);
    expect(caps.remoteVideoAssets).toBe(false);
  });

  it("enables auth + sceneStorage and bumps tier when Supabase is configured", () => {
    vi.stubEnv("VITE_APP_SUPABASE_URL", "https://demo.supabase.co");
    vi.stubEnv("VITE_APP_SUPABASE_ANON_KEY", "anon-key-123");

    const caps = readCapabilities();
    expect(caps.tier).toBe("self-hosted");
    expect(caps.auth).toBe(true);
    expect(caps.sceneStorage).toBe(true);
    expect(caps.assetStorage).toBe(true);
    expect(caps.share).toBe(true);
    expect(caps.aiTasks).toBe(true);
    expect(caps.collaborationMetadata).toBe(true);
    expect(caps.cast).toBe(true);
    expect(caps.embed).toBe(true);
    expect(caps.collabPersistence).toBe(true);
    expect(caps.collabRoomBinding).toBe(false);
    expect(caps.aiGateway).toBe(false);
    expect(caps.remoteVideoAssets).toBe(false);
  });

  it("enables remote video assets only when Supabase and the feature flag are configured", () => {
    vi.stubEnv("VITE_APP_SUPABASE_URL", "https://demo.supabase.co");
    vi.stubEnv("VITE_APP_SUPABASE_ANON_KEY", "anon-key-123");
    vi.stubEnv("VITE_APP_REMOTE_VIDEO_ASSETS", "true");

    expect(readCapabilities().remoteVideoAssets).toBe(true);

    vi.stubEnv("VITE_APP_SUPABASE_URL", "");
    expect(readCapabilities().remoteVideoAssets).toBe(false);
  });

  it("enables collab room binding when Supabase and a room server are configured", () => {
    vi.stubEnv("VITE_APP_SUPABASE_URL", "https://demo.supabase.co");
    vi.stubEnv("VITE_APP_SUPABASE_ANON_KEY", "anon-key-123");
    vi.stubEnv("VITE_APP_WS_SERVER_URL", "https://collab.example.com");

    const caps = readCapabilities();
    expect(caps.realtime).toBe(true);
    expect(caps.collabRoomBinding).toBe(true);
    expect(caps.collabPersistence).toBe(true);
  });

  it("allows explicitly disabling collab persistence", () => {
    vi.stubEnv("VITE_APP_SUPABASE_URL", "https://demo.supabase.co");
    vi.stubEnv("VITE_APP_SUPABASE_ANON_KEY", "anon-key-123");
    vi.stubEnv("VITE_APP_COLLAB_PERSISTENCE", "none");

    const caps = readCapabilities();
    expect(caps.collabPersistence).toBe(false);
  });

  it("enables encrypted cloud storage only when Supabase and the E2E flag are set", () => {
    vi.stubEnv("VITE_APP_SUPABASE_URL", "https://demo.supabase.co");
    vi.stubEnv("VITE_APP_SUPABASE_ANON_KEY", "anon-key-123");
    vi.stubEnv("VITE_APP_E2E_CLOUD_STORAGE", "true");

    const caps = readCapabilities();
    expect(caps.encryptedCloudStorage).toBe(true);
  });

  it("stays local when only one Supabase var is set (incomplete config)", () => {
    vi.stubEnv("VITE_APP_SUPABASE_URL", "https://demo.supabase.co");
    // anon key missing

    const caps = readCapabilities();
    expect(caps.tier).toBe("local");
    expect(caps.auth).toBe(false);
    expect(caps.sceneStorage).toBe(false);
  });

  it("treats whitespace-only Supabase vars as unconfigured", () => {
    vi.stubEnv("VITE_APP_SUPABASE_URL", "   ");
    vi.stubEnv("VITE_APP_SUPABASE_ANON_KEY", "   ");

    const caps = readCapabilities();
    expect(caps.tier).toBe("local");
    expect(caps.auth).toBe(false);
  });

  it("derives legacy share/realtime/assetStorage independently of Supabase", () => {
    vi.stubEnv("VITE_APP_BACKEND_V2_POST_URL", "https://json.example.com/post");
    vi.stubEnv("VITE_APP_WS_SERVER_URL", "https://collab.example.com");
    vi.stubEnv("VITE_APP_FIREBASE_CONFIG", '{"apiKey":"x"}');

    const caps = readCapabilities();
    expect(caps.share).toBe(true);
    expect(caps.realtime).toBe(true);
    expect(caps.assetStorage).toBe(true);
    expect(caps.collabPersistence).toBe(true);
    expect(caps.collabRoomBinding).toBe(false);
    // Supabase still unset → cloud scenes stay off.
    expect(caps.sceneStorage).toBe(false);
  });
});
