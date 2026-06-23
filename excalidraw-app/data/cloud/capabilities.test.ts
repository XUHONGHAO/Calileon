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
    expect(caps.realtime).toBe(false);
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
    // Supabase still unset → cloud scenes stay off.
    expect(caps.sceneStorage).toBe(false);
  });
});
