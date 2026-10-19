import { classifyAttachmentFailures, VaultV2UiStore } from "./uiState";

describe("Vault v2 UI state (W6)", () => {
  it("classifies failed uploads as retrying or needing the user", () => {
    expect(classifyAttachmentFailures([])).toBeNull();
    expect(
      classifyAttachmentFailures([{ status: "complete", errorCode: null }]),
    ).toBeNull();
    expect(
      classifyAttachmentFailures([
        { status: "failed", errorCode: "VAULT_RATE_LIMITED" },
        { status: "failed", errorCode: "VAULT_PERSISTENCE_UNAVAILABLE" },
      ]),
    ).toBe("retry");
    expect(
      classifyAttachmentFailures([
        { status: "failed", errorCode: "VAULT_RATE_LIMITED" },
        { status: "failed", errorCode: "VAULT_CAPABILITY_FORBIDDEN" },
      ]),
    ).toBe("action");
  });

  it("notifies only on real changes and keeps a stable snapshot", () => {
    const store = new VaultV2UiStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.get();
    store.update({ status: "connecting", conflictElementIds: [] });
    expect(listener).not.toHaveBeenCalled();
    expect(store.get()).toBe(before);

    store.update({ conflictElementIds: ["x"] });
    const withConflict = store.get();
    store.update({ conflictElementIds: ["x"] });
    expect(store.get()).toBe(withConflict);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stays blocked once blocked", () => {
    const store = new VaultV2UiStore();
    store.update({
      status: "blocked",
      blockedCode: "VAULT_CAPABILITY_REVOKED",
    });
    store.update({ status: "offline" });
    expect(store.get().status).toBe("blocked");
    expect(store.get().blockedCode).toBe("VAULT_CAPABILITY_REVOKED");
  });

  it("delivers notices to subscribers until they unsubscribe", () => {
    const store = new VaultV2UiStore();
    const listener = vi.fn();
    const off = store.onNotice(listener);
    store.emit({ kind: "conflict", elementIds: ["a"] });
    off();
    store.emit({ kind: "conflict", elementIds: ["b"] });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
