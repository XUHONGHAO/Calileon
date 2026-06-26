import { AuthApiError } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackendError } from "../errors";

import { createSupabaseAuthProvider } from "./SupabaseAuthProvider";

// Mock the client module so no real network/SDK client is created.
const mockAuth = {
  getUser: vi.fn(),
  signInWithPassword: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChange: vi.fn(),
};

vi.mock("./client", () => ({
  getSupabaseClient: () => ({ auth: mockAuth }),
  hasSupabaseConfig: () => true,
}));

const supabaseUser = {
  id: "user-1",
  email: "a@b.com",
  user_metadata: { full_name: "Ada", avatar_url: "https://x/y.png" },
  app_metadata: {},
  aud: "authenticated",
  created_at: "2026-06-20T10:00:00.000Z",
  last_sign_in_at: "2026-06-21T08:00:00.000Z",
};

const expectBackendError = async (
  promise: Promise<unknown>,
  code: string,
): Promise<void> => {
  await expect(promise).rejects.toBeInstanceOf(BackendError);
  await promise.catch((e) => {
    expect((e as BackendError).code).toBe(code);
  });
};

describe("SupabaseAuthProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("signIn", () => {
    it("signs in with password and maps the user to AuthUser", async () => {
      mockAuth.signInWithPassword.mockResolvedValue({
        data: { user: supabaseUser },
        error: null,
      });

      const auth = createSupabaseAuthProvider();
      const user = await auth.signIn({
        kind: "password",
        email: "a@b.com",
        password: "secret",
      });

      expect(mockAuth.signInWithPassword).toHaveBeenCalledWith({
        email: "a@b.com",
        password: "secret",
      });
      expect(user).toEqual({
        id: "user-1",
        displayName: "Ada",
        email: "a@b.com",
        avatarUrl: "https://x/y.png",
        createdAt: Date.parse("2026-06-20T10:00:00.000Z"),
        lastSignInAt: Date.parse("2026-06-21T08:00:00.000Z"),
      });
    });

    it("maps bad credentials (400) to BackendError 'unauthorized'", async () => {
      mockAuth.signInWithPassword.mockResolvedValue({
        data: { user: null },
        error: new AuthApiError("Invalid login", 400, "invalid_credentials"),
      });

      const auth = createSupabaseAuthProvider();
      await expectBackendError(
        auth.signIn({ kind: "password", email: "a@b.com", password: "x" }),
        "unauthorized",
      );
    });

    it("does not implement oauth/magic-link yet → 'not-configured'", async () => {
      const auth = createSupabaseAuthProvider();
      await expectBackendError(
        auth.signIn({ kind: "oauth", provider: "github" }),
        "not-configured",
      );
      await expectBackendError(
        auth.signIn({ kind: "magic-link", email: "a@b.com" }),
        "not-configured",
      );
      expect(mockAuth.signInWithPassword).not.toHaveBeenCalled();
    });
  });

  describe("getCurrentUser", () => {
    it("returns the mapped user when a session exists", async () => {
      mockAuth.getUser.mockResolvedValue({
        data: { user: supabaseUser },
        error: null,
      });
      const auth = createSupabaseAuthProvider();
      const user = await auth.getCurrentUser();
      expect(user?.id).toBe("user-1");
    });

    it("returns null (not an error) when there is no session", async () => {
      mockAuth.getUser.mockResolvedValue({
        data: { user: null },
        error: new AuthApiError("not authenticated", 401, "not_authenticated"),
      });
      const auth = createSupabaseAuthProvider();
      expect(await auth.getCurrentUser()).toBeNull();
    });

    it("falls back to null display/avatar when metadata is absent", async () => {
      mockAuth.getUser.mockResolvedValue({
        data: { user: { ...supabaseUser, user_metadata: {} } },
        error: null,
      });
      const auth = createSupabaseAuthProvider();
      const user = await auth.getCurrentUser();
      expect(user?.displayName).toBeNull();
      expect(user?.avatarUrl).toBeNull();
    });
  });

  describe("signOut", () => {
    it("resolves when the SDK reports no error", async () => {
      mockAuth.signOut.mockResolvedValue({ error: null });
      const auth = createSupabaseAuthProvider();
      await expect(auth.signOut()).resolves.toBeUndefined();
    });
  });

  describe("onAuthStateChange", () => {
    it("emits mapped user on sign-in and returns an unsubscribe", () => {
      const unsubscribe = vi.fn();
      // Hold the captured listener on an object so TS re-reads the declared
      // type at each use (flow analysis won't narrow a nested-closure write).
      const holder: {
        cb: ((event: string, session: unknown) => void) | null;
      } = { cb: null };
      mockAuth.onAuthStateChange.mockImplementation((cb) => {
        holder.cb = cb;
        return { data: { subscription: { unsubscribe } } };
      });

      const auth = createSupabaseAuthProvider();
      const received: Array<unknown> = [];
      const off = auth.onAuthStateChange((u) => received.push(u));

      holder.cb?.("SIGNED_IN", { user: supabaseUser });
      holder.cb?.("SIGNED_OUT", null);

      expect((received[0] as { id: string }).id).toBe("user-1");
      expect(received[1]).toBeNull();

      off();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
  });
});
