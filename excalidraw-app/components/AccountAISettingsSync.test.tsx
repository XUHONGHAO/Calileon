import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React, { useSyncExternalStore } from "react";
import { vi } from "vitest";

import { loadAIImageConfig, saveAIImageConfig } from "../ai/config";
import { createAccountSyncEngine } from "../accountSync/accountSyncEngine";
import { MIN_KDF_ITERATIONS } from "../accountSync/settingsCrypto";
import { BackendError } from "../data/cloud/errors";

import { AccountAISettingsSync, formatSyncedAt } from "./AccountAISettingsSync";

import type { AccountSyncEngine } from "../accountSync/accountSyncEngine";
import type { AccountSettingsRecord } from "../data/cloud/types";

const harness = vi.hoisted(
  (): { engine: AccountSyncEngine | null; available: boolean } => ({
    engine: null,
    available: true,
  }),
);

vi.mock("../accountSync/useAccountSettingsSync", () => ({
  isAccountSettingsSyncAvailable: () => harness.available,
  useAccountSettingsSync: () => {
    const engine = harness.engine!;
    const view = useSyncExternalStore(engine.subscribe, engine.getView);
    return { engine, view };
  },
}));

const PASSPHRASE = "a long passphrase";

const createService = () => {
  let row: AccountSettingsRecord | null = null;
  return {
    get: vi.fn(async () => row),
    put: vi.fn(async (write: any, expected: number | null) => {
      if (expected === null ? row : row?.revision !== expected) {
        throw new BackendError("conflict", "conflict");
      }
      row = { ...write, revision: (expected ?? 0) + 1, updatedAt: 1 };
      return row!;
    }),
    remove: vi.fn(async () => {
      row = null;
    }),
    row: () => row,
  };
};

const startEngine = async (service: ReturnType<typeof createService>) => {
  const engine = createAccountSyncEngine({
    service,
    debounceMs: 1e9,
    kdfIterations: MIN_KDF_ITERATIONS,
  });
  engine.setUser("u1");
  await waitFor(() => expect(engine.getView().status).not.toBe("loading"));
  harness.engine = engine;
  return engine;
};

const theSwitch = () =>
  screen.getByRole("switch", { name: "Save AI settings to my account" });

const setModels = (id: string) =>
  saveAIImageConfig({
    baseURL: "",
    apiKey: "",
    defaultModel: id,
    models: [
      {
        id,
        siteName: "Relay",
        baseURL: "https://api.example.com/v1",
        apiKey: "sk-test",
        model: id,
        label: id,
        mediaType: "image",
        capabilities: ["text-to-image"],
      } as any,
    ],
  });

describe("AccountAISettingsSync (ADR 0038)", () => {
  beforeEach(() => {
    localStorage.clear();
    harness.available = true;
  });

  afterEach(() => {
    harness.engine?.dispose();
    harness.engine = null;
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("is a disabled row when the deployment doesn't offer it", async () => {
    harness.available = false;
    await startEngine(createService());
    render(<AccountAISettingsSync />);
    expect(theSwitch()).toBeDisabled();
    expect(theSwitch()).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Not enabled on this deployment.")).toBeVisible();
  });

  it("sets up sync with a confirmed passphrase", async () => {
    const service = createService();
    setModels("m1");
    await startEngine(service);
    render(<AccountAISettingsSync />);
    expect(screen.getByText(/Use your models, agents/)).toBeVisible();

    fireEvent.click(theSwitch());
    expect(theSwitch()).toHaveAttribute("aria-checked", "true");
    const [passphrase, repeat] = screen.getAllByLabelText(/passphrase/i);
    fireEvent.change(passphrase, { target: { value: PASSPHRASE } });
    fireEvent.change(repeat, { target: { value: "something else" } });
    fireEvent.click(screen.getByRole("button", { name: "Turn on sync" }));
    expect(
      await screen.findByText("The passphrases don't match."),
    ).toBeVisible();
    expect(service.put).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Repeat passphrase"), {
      target: { value: PASSPHRASE },
    });
    fireEvent.click(screen.getByRole("button", { name: "Turn on sync" }));

    expect(await screen.findByText(/Synced just now/)).toBeVisible();
    expect(screen.queryByLabelText("Sync passphrase")).toBeNull();
    // the form had focus; it goes back to the switch, not <body>
    await waitFor(() => expect(theSwitch()).toHaveFocus());
    expect(service.row()?.revision).toBe(1);
    expect(JSON.stringify(service.row())).not.toContain("sk-test");
  });

  it("unlocks an existing copy and reports a wrong passphrase", async () => {
    const service = createService();
    setModels("from-account");
    const first = await startEngine(service);
    await first.enable(PASSPHRASE);
    first.dispose();

    // a fresh device
    localStorage.clear();
    await startEngine(service);
    render(<AccountAISettingsSync />);
    expect(
      screen.getByText(/Your account has saved AI settings/),
    ).toBeVisible();

    fireEvent.click(theSwitch());
    fireEvent.change(screen.getByLabelText("Sync passphrase"), {
      target: { value: "not the passphrase" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect(
      await screen.findByText("That passphrase doesn't unlock your settings."),
    ).toBeVisible();

    fireEvent.change(screen.getByLabelText("Sync passphrase"), {
      target: { value: PASSPHRASE },
    });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByText(/Synced just now/)).toBeVisible();
    expect(loadAIImageConfig().models.map((model) => model.id)).toEqual([
      "from-account",
    ]);
  });

  it("asks which copy to keep on a conflict", async () => {
    const service = createService();
    setModels("from-account");
    const first = await startEngine(service);
    await first.enable(PASSPHRASE);
    first.dispose();

    localStorage.clear();
    setModels("from-device");
    await startEngine(service);
    render(<AccountAISettingsSync />);
    fireEvent.click(theSwitch());
    fireEvent.change(screen.getByLabelText("Sync passphrase"), {
      target: { value: PASSPHRASE },
    });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

    expect(
      await screen.findByText(/have different models/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use this device's" }));
    expect(await screen.findByText(/Synced just now/)).toBeVisible();
    expect(loadAIImageConfig().models[0].id).toBe("from-device");
    expect(service.row()?.revision).toBe(2);
  });

  it("turns off here, and deletes the account copy after confirming", async () => {
    const service = createService();
    const engine = await startEngine(service);
    await engine.enable(PASSPHRASE);
    render(<AccountAISettingsSync />);
    expect(theSwitch()).toHaveAttribute("aria-checked", "true");

    vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "More sync actions" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Delete from account" }),
    );
    await act(async () => {});
    expect(service.remove).not.toHaveBeenCalled();

    act(() => fireEvent.click(theSwitch()));
    expect(theSwitch()).toHaveAttribute("aria-checked", "false");
    expect(service.row()).not.toBeNull();
  });
});

describe("formatSyncedAt", () => {
  it("uses relative wording for recent syncs", () => {
    const now = 10 * 86_400_000;
    expect(formatSyncedAt(now - 5_000, now)).toBe("just now");
    expect(formatSyncedAt(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(formatSyncedAt(now - 3 * 3_600_000, now)).toBe("3 h ago");
  });
});
