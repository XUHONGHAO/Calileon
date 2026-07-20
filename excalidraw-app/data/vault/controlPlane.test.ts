import { describe, expect, it, vi } from "vitest";

import { issueVaultAdmission } from "./admission";
import { assertVaultDeploymentReady } from "./capabilities";
import {
  assertVaultCapabilityDisconnectNotice,
  VaultCapabilityControlPlane,
} from "./controlPlane";

import type { VaultAdmission } from "./admission";
import type {
  VaultControlPlaneClock,
  VaultControlPlaneSocket,
} from "./controlPlane";

const NOW = 1_800_000_000_000;
const vaultId = "123e4567-e89b-42d3-a456-426614174000";
const invitationId = "123e4567-e89b-42d3-a456-426614174002";
const senderSessionId = "123e4567-e89b-42d3-a456-426614174001";

class FakeClock implements VaultControlPlaneClock {
  current = NOW;
  private nextId = 1;
  private timers = new Map<
    number,
    { callback: () => void; scheduledAt: number }
  >();

  now = () => this.current;

  setTimeout = (callback: () => void, delay: number) => {
    const id = this.nextId++;
    this.timers.set(id, { callback, scheduledAt: this.current + delay });
    return id;
  };

  clearTimeout = (handle: unknown) => {
    this.timers.delete(handle as number);
  };

  advance = (milliseconds: number) => {
    this.current += milliseconds;
    while (true) {
      const due = [...this.timers.entries()].find(
        ([, timer]) => timer.scheduledAt <= this.current,
      );
      if (!due) {
        return;
      }
      this.timers.delete(due[0]);
      due[1].callback();
    }
  };
}

class FakeSocket implements VaultControlPlaneSocket {
  private listeners = new Map<string, Set<(notice: unknown) => void>>();

  on = (event: string, listener: (notice: unknown) => void) => {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  };

  off = (event: string, listener: (notice: unknown) => void) => {
    this.listeners.get(event)?.delete(listener);
    return this;
  };

  emit = (event: string, notice: unknown) => {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(notice);
    }
  };

  listenerCount = () =>
    [...this.listeners.values()].reduce(
      (count, listeners) => count + listeners.size,
      0,
    );
}

const createDeploymentReady = () =>
  assertVaultDeploymentReady(
    {
      enabled: true,
      protocolVersions: [1],
      roomProtocolVersions: [1],
      invitationService: true,
      encryptedSnapshotPersistence: true,
      encryptedAssetPersistence: true,
    },
    { isSecureContext: true, hasWebCrypto: true },
  );

const createAdmission = (
  expiresAt: number | null = NOW + 60_000,
): VaultAdmission =>
  issueVaultAdmission(
    createDeploymentReady(),
    {
      vaultId,
      invitationId,
      role: "editor",
      authorizationVersion: 4,
      activeRoomId: "vault_room_1234567890",
      snapshotGeneration: 0,
      expiresAt,
    },
    senderSessionId,
    NOW,
  );

const createTeardown = () => {
  const closeSocket = vi.fn();
  const destroySession = vi.fn();
  const save = vi.fn();
  const stop = vi.fn();
  const teardown = vi.fn(() => {
    closeSocket();
    destroySession();
  });
  return { closeSocket, destroySession, save, stop, teardown };
};

describe("Vault capability control plane", () => {
  it("strictly parses disconnect notices", () => {
    const notice = {
      vaultId,
      invitationId,
      authorizationVersion: 5,
      reason: "revoked",
    };
    expect(() => assertVaultCapabilityDisconnectNotice(notice)).not.toThrow();
    expect(() =>
      assertVaultCapabilityDisconnectNotice({ ...notice, rawCapability: "x" }),
    ).toThrowError(
      expect.objectContaining({ code: "VAULT_CAPABILITY_REVOKED" }),
    );
    expect(() =>
      assertVaultCapabilityDisconnectNotice({ ...notice, reason: "paused" }),
    ).toThrowError(
      expect.objectContaining({ code: "VAULT_CAPABILITY_REVOKED" }),
    );
  });

  it.each(["revoked", "vault-revoked", "vault-deleted"] as const)(
    "tears down once for %s without legacy save or stop",
    (reason) => {
      const clock = new FakeClock();
      const socket = new FakeSocket();
      const effects = createTeardown();
      new VaultCapabilityControlPlane({
        admission: createAdmission(),
        socket,
        clock,
        teardown: effects.teardown,
      });

      socket.emit("vault:capability-revoked", {
        vaultId,
        invitationId,
        authorizationVersion: reason === "revoked" ? 5 : 4,
        reason,
      });
      socket.emit("vault:capability-revoked", {
        vaultId,
        invitationId,
        authorizationVersion: 6,
        reason,
      });

      expect(effects.teardown).toHaveBeenCalledTimes(1);
      expect(effects.teardown).toHaveBeenCalledWith(
        expect.objectContaining({ code: "VAULT_CAPABILITY_REVOKED" }),
      );
      expect(effects.closeSocket).toHaveBeenCalledTimes(1);
      expect(effects.destroySession).toHaveBeenCalledTimes(1);
      expect(effects.save).not.toHaveBeenCalled();
      expect(effects.stop).not.toHaveBeenCalled();
      expect(socket.listenerCount()).toBe(0);
    },
  );

  it("uses local expiresAt to tear down exactly once", () => {
    const clock = new FakeClock();
    const socket = new FakeSocket();
    const effects = createTeardown();
    new VaultCapabilityControlPlane({
      admission: createAdmission(NOW + 1_000),
      socket,
      clock,
      teardown: effects.teardown,
    });

    clock.advance(999);
    expect(effects.teardown).not.toHaveBeenCalled();
    clock.advance(1);
    socket.emit("vault:capability-expired", {
      vaultId,
      invitationId,
      authorizationVersion: 4,
      reason: "expired",
    });

    expect(effects.teardown).toHaveBeenCalledTimes(1);
    expect(effects.teardown).toHaveBeenCalledWith(
      expect.objectContaining({ code: "VAULT_CAPABILITY_EXPIRED" }),
    );
    expect(effects.closeSocket).toHaveBeenCalledTimes(1);
    expect(effects.destroySession).toHaveBeenCalledTimes(1);
    expect(socket.listenerCount()).toBe(0);
  });

  it("tears down an already attached transport when admission expires before control-plane attachment", () => {
    const clock = new FakeClock();
    const socket = new FakeSocket();
    const effects = createTeardown();
    const admission = createAdmission(NOW + 1_000);
    clock.advance(1_000);

    expect(
      () =>
        new VaultCapabilityControlPlane({
          admission,
          socket,
          clock,
          teardown: effects.teardown,
        }),
    ).not.toThrow();

    expect(effects.teardown).toHaveBeenCalledTimes(1);
    expect(effects.teardown).toHaveBeenCalledWith(
      expect.objectContaining({ code: "VAULT_CAPABILITY_EXPIRED" }),
    );
    expect(effects.closeSocket).toHaveBeenCalledTimes(1);
    expect(effects.destroySession).toHaveBeenCalledTimes(1);
    expect(socket.listenerCount()).toBe(0);
  });

  it("fails closed on admission mismatch and wrong control channel", () => {
    const mismatchedSocket = new FakeSocket();
    const mismatchEffects = createTeardown();
    new VaultCapabilityControlPlane({
      admission: createAdmission(),
      socket: mismatchedSocket,
      clock: new FakeClock(),
      teardown: mismatchEffects.teardown,
    });
    mismatchedSocket.emit("vault:capability-revoked", {
      vaultId: "123e4567-e89b-42d3-a456-426614174099",
      invitationId,
      authorizationVersion: 5,
      reason: "revoked",
    });
    expect(mismatchEffects.teardown).toHaveBeenCalledWith(
      expect.objectContaining({ code: "VAULT_CAPABILITY_REVOKED" }),
    );

    const wrongChannelSocket = new FakeSocket();
    const wrongChannelEffects = createTeardown();
    new VaultCapabilityControlPlane({
      admission: createAdmission(),
      socket: wrongChannelSocket,
      clock: new FakeClock(),
      teardown: wrongChannelEffects.teardown,
    });
    wrongChannelSocket.emit("vault:capability-expired", {
      vaultId,
      invitationId,
      authorizationVersion: 5,
      reason: "revoked",
    });
    expect(wrongChannelEffects.teardown).toHaveBeenCalledWith(
      expect.objectContaining({ code: "VAULT_CAPABILITY_EXPIRED" }),
    );
  });

  it("dispose removes listeners and timer without teardown", () => {
    const clock = new FakeClock();
    const socket = new FakeSocket();
    const effects = createTeardown();
    const controlPlane = new VaultCapabilityControlPlane({
      admission: createAdmission(),
      socket,
      clock,
      teardown: effects.teardown,
    });

    controlPlane.dispose();
    clock.advance(60_000);

    expect(socket.listenerCount()).toBe(0);
    expect(effects.teardown).not.toHaveBeenCalled();
  });
});
