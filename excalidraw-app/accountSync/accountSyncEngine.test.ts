import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadAIAgentConfig, saveAIAgentConfig } from "../ai/agentConfig";
import { loadAIImageConfig, saveAIImageConfig } from "../ai/config";
import {
  loadCustomPromptTemplates,
  saveCustomPromptTemplates,
} from "../ai/promptTemplates";
import { loadAIProxyConfig, saveAIProxyConfig } from "../ai/proxyConfig";
import { BackendError } from "../data/cloud/errors";

import {
  AccountSyncError,
  createAccountSyncEngine,
  readDeviceSyncEntry,
} from "./accountSyncEngine";
import {
  MIN_KDF_ITERATIONS,
  createKdf,
  decryptSettings,
  deriveSettingsKey,
  encryptSettings,
} from "./settingsCrypto";

import type { AccountSyncEngine } from "./accountSyncEngine";
import type {
  AccountSettingsRecord,
  AccountSettingsWrite,
} from "../data/cloud/types";

const PASSPHRASE = "correct horse battery";
const USER = "u1";

// —— fake account row with the same revision rules as the SQL ——

const createFakeService = () => {
  let row: AccountSettingsRecord | null = null;
  // runs once before the next put lands (simulates another device)
  let beforeNextPut: (() => Promise<void>) | null = null;
  const service = {
    get: vi.fn(async () => (row ? { ...row } : null)),
    put: vi.fn(async (write: AccountSettingsWrite, expected: number | null) => {
      if (beforeNextPut) {
        const hook = beforeNextPut;
        beforeNextPut = null;
        await hook();
      }
      const ok = expected === null ? !row : row?.revision === expected;
      if (!ok) {
        throw new BackendError("conflict", "conflict");
      }
      row = { ...write, revision: (expected ?? 0) + 1, updatedAt: 1 };
      return { ...row };
    }),
    remove: vi.fn(async () => {
      row = null;
    }),
  };
  return {
    service,
    row: () => row,
    setRow: (next: AccountSettingsRecord | null) => {
      row = next;
    },
    beforeNextPut: (hook: () => Promise<void>) => {
      beforeNextPut = hook;
    },
  };
};

// —— devices: each one is its own localStorage snapshot + engine ——

const snapshots = new Map<string, Record<string, string>>();
let currentDevice: string | null = null;

const useDevice = (name: string) => {
  if (currentDevice) {
    const snapshot: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      snapshot[key] = localStorage.getItem(key)!;
    }
    snapshots.set(currentDevice, snapshot);
  }
  localStorage.clear();
  for (const [key, value] of Object.entries(snapshots.get(name) ?? {})) {
    localStorage.setItem(key, value);
  }
  currentDevice = name;
};

const engines: AccountSyncEngine[] = [];

const startEngine = async (fake: ReturnType<typeof createFakeService>) => {
  const engine = createAccountSyncEngine({
    service: fake.service,
    // timers never fire on their own; tests call flush()
    debounceMs: 1e9,
    kdfIterations: MIN_KDF_ITERATIONS,
  });
  engines.push(engine);
  engine.setUser(USER);
  await vi.waitFor(() => expect(engine.getView().status).not.toBe("loading"));
  await engine.flush();
  return engine;
};

// —— settings fixtures ——

const model = (id: string, apiKey: string) => ({
  id,
  siteName: "Relay",
  baseURL: "https://api.example.com/v1",
  apiKey,
  model: id,
  label: id,
  mediaType: "image" as const,
  capabilities: ["text-to-image" as const],
});

const setModels = (...models: ReturnType<typeof model>[]) =>
  saveAIImageConfig({
    baseURL: "",
    apiKey: "",
    defaultModel: models[0]?.id ?? "",
    models: models as any,
  });

const modelIds = () => loadAIImageConfig().models.map((m) => m.id);

const setTemplate = (label: string) =>
  saveCustomPromptTemplates([
    {
      id: `tpl-${label}`,
      label,
      template: `${label} [subject]`,
      modes: ["text-to-image"],
      category: "custom",
      language: "multi",
      createdAt: 1,
      isBuiltIn: false,
    },
  ]);

const templateLabels = () => loadCustomPromptTemplates().map((t) => t.label);

const decryptRow = async (record: AccountSettingsRecord) =>
  (await decryptSettings(
    record,
    await deriveSettingsKey(PASSPHRASE, record.kdf),
    USER,
  )) as any;

describe("account settings sync engine (ADR 0038)", () => {
  beforeEach(() => {
    localStorage.clear();
    snapshots.clear();
    currentDevice = null;
  });

  afterEach(() => {
    engines.splice(0).forEach((engine) => engine.dispose());
    localStorage.clear();
  });

  it("enables from this device and stores only ciphertext", async () => {
    const fake = createFakeService();
    useDevice("A");
    setModels(model("m1", "sk-secret-123"));
    const a = await startEngine(fake);
    expect(a.getView()).toEqual({ status: "off", remote: false });

    await a.enable(PASSPHRASE);

    expect(a.getView().status).toBe("on");
    const row = fake.row()!;
    expect(row.revision).toBe(1);
    expect(JSON.stringify(row)).not.toContain("sk-secret-123");
    expect(JSON.stringify(row)).not.toContain(PASSPHRASE);
    const plaintext = await decryptRow(row);
    expect(plaintext.sections.models.models[0].apiKey).toBe("sk-secret-123");
    // the device remembers the key, not the passphrase
    expect(
      localStorage.getItem("excalidraw-account-settings-sync"),
    ).not.toContain(PASSPHRASE);
  });

  it("rejects short passphrases and a second setup", async () => {
    const fake = createFakeService();
    useDevice("A");
    const a = await startEngine(fake);
    await expect(a.enable("short")).rejects.toMatchObject({
      code: "passphrase-too-short",
    });
    await a.enable(PASSPHRASE);

    useDevice("B");
    const b = await startEngine(fake);
    await expect(b.enable(PASSPHRASE)).rejects.toMatchObject({
      code: "remote-exists",
    });
    expect(fake.row()!.revision).toBe(1);
  });

  it("unlocks on a new device with the passphrase, not without it", async () => {
    const fake = createFakeService();
    useDevice("A");
    setModels(model("m1", "sk-a"));
    setTemplate("Poster");
    const a = await startEngine(fake);
    await a.enable(PASSPHRASE);

    useDevice("B");
    const b = await startEngine(fake);
    expect(b.getView()).toEqual({ status: "off", remote: true });

    await expect(b.unlock("wrong passphrase")).rejects.toMatchObject({
      code: "wrong-passphrase",
    });
    expect(modelIds()).toEqual([]);
    expect(readDeviceSyncEntry(USER)).toBeNull();

    expect(await b.unlock(PASSPHRASE)).toBe("done");
    expect(b.getView().status).toBe("on");
    expect(loadAIImageConfig().models[0].apiKey).toBe("sk-a");
    expect(templateLabels()).toEqual(["Poster"]);
    // taking the account's copy as-is needs no upload
    expect(fake.service.put).toHaveBeenCalledTimes(1);
  });

  it("carries later edits both ways and doesn't echo applied changes", async () => {
    const fake = createFakeService();
    useDevice("A");
    setModels(model("m1", "sk-a"));
    const a = await startEngine(fake);
    await a.enable(PASSPHRASE);
    useDevice("B");
    const b = await startEngine(fake);
    await b.unlock(PASSPHRASE);

    useDevice("A");
    setModels(model("m1", "sk-a"), model("m2", "sk-a2"));
    await a.syncNow();
    expect(fake.row()!.revision).toBe(2);

    useDevice("B");
    await b.syncNow();
    expect(modelIds()).toEqual(["m1", "m2"]);
    // applying A's change is not a local edit: nothing goes back up
    await b.flush();
    await b.syncNow();
    expect(fake.row()!.revision).toBe(2);
  });

  it("merges edits to different sections from two devices", async () => {
    const fake = createFakeService();
    useDevice("A");
    setModels(model("m1", "sk-a"));
    const a = await startEngine(fake);
    await a.enable(PASSPHRASE);
    useDevice("B");
    const b = await startEngine(fake);
    await b.unlock(PASSPHRASE);

    useDevice("A");
    setModels(model("m1", "sk-a"), model("m2", "sk-a2"));
    await a.syncNow();

    useDevice("B");
    setTemplate("Offline edit");
    await b.syncNow();
    expect(modelIds()).toEqual(["m1", "m2"]);
    expect(templateLabels()).toEqual(["Offline edit"]);

    useDevice("A");
    await a.syncNow();
    expect(templateLabels()).toEqual(["Offline edit"]);
    expect(modelIds()).toEqual(["m1", "m2"]);
  });

  it("lets the device that syncs last win when both edit one section", async () => {
    const fake = createFakeService();
    useDevice("A");
    setModels(model("m1", "sk-a"));
    const a = await startEngine(fake);
    await a.enable(PASSPHRASE);
    useDevice("B");
    const b = await startEngine(fake);
    await b.unlock(PASSPHRASE);

    useDevice("A");
    setModels(model("from-a", "sk-a"));
    await a.syncNow();
    useDevice("B");
    setModels(model("from-b", "sk-b"));
    await b.syncNow();
    expect(modelIds()).toEqual(["from-b"]);

    useDevice("A");
    await a.syncNow();
    expect(modelIds()).toEqual(["from-b"]);
  });

  it("starts over when another device writes in the middle of a sync", async () => {
    const fake = createFakeService();
    useDevice("A");
    setModels(model("m1", "sk-a"));
    const a = await startEngine(fake);
    await a.enable(PASSPHRASE);
    useDevice("B");
    const b = await startEngine(fake);
    await b.unlock(PASSPHRASE);

    // B edits templates; while its upload is on the way, A uploads models
    setTemplate("From B");
    fake.beforeNextPut(async () => {
      useDevice("A");
      setModels(model("m1", "sk-a"), model("m3", "sk-a3"));
      await a.syncNow();
      useDevice("B");
    });
    await b.syncNow();

    expect(b.getView()).toMatchObject({ status: "on" });
    expect((b.getView() as any).error).toBeUndefined();
    expect(modelIds()).toEqual(["m1", "m3"]);
    const plaintext = await decryptRow(fake.row()!);
    expect(plaintext.sections.templates.map((t: any) => t.label)).toEqual([
      "From B",
    ]);
    expect(plaintext.sections.models.models.map((m: any) => m.id)).toEqual([
      "m1",
      "m3",
    ]);
  });

  it("asks which copy to keep when both sides already differ", async () => {
    const fake = createFakeService();
    useDevice("A");
    setModels(model("account-model", "sk-a"));
    setTemplate("Account template");
    const a = await startEngine(fake);
    await a.enable(PASSPHRASE);

    useDevice("B");
    setModels(model("device-model", "sk-b"));
    saveAIAgentConfig({
      ...loadAIAgentConfig(),
      textAgents: [
        {
          id: "agent-1",
          name: "Writer",
          type: "text",
          provider: "openai",
          baseURL: "",
          apiKey: "sk-agent",
          model: "gpt-4o-mini",
        },
      ],
    });
    const b = await startEngine(fake);

    expect(await b.unlock(PASSPHRASE)).toBe("conflict");
    // agents only exist here and templates only in the account: no question
    expect(b.getView()).toEqual({ status: "conflict", sections: ["models"] });
    expect(readDeviceSyncEntry(USER)).toBeNull();

    await b.resolveConflict("device");
    expect(b.getView().status).toBe("on");
    expect(modelIds()).toEqual(["device-model"]);
    expect(templateLabels()).toEqual(["Account template"]);
    const plaintext = await decryptRow(fake.row()!);
    expect(plaintext.sections.models.models[0].id).toBe("device-model");
    expect(plaintext.sections.agents.textAgents[0].apiKey).toBe("sk-agent");
  });

  it("can keep the account's copy instead", async () => {
    const fake = createFakeService();
    useDevice("A");
    setModels(model("account-model", "sk-a"));
    const a = await startEngine(fake);
    await a.enable(PASSPHRASE);

    useDevice("B");
    setModels(model("device-model", "sk-b"));
    const b = await startEngine(fake);
    await b.unlock(PASSPHRASE);
    await b.resolveConflict("account");

    expect(modelIds()).toEqual(["account-model"]);
    expect(fake.row()!.revision).toBe(1);
  });

  it("stops syncing here when the account copy is deleted elsewhere", async () => {
    const fake = createFakeService();
    useDevice("A");
    setModels(model("m1", "sk-a"));
    const a = await startEngine(fake);
    await a.enable(PASSPHRASE);
    useDevice("B");
    const b = await startEngine(fake);
    await b.unlock(PASSPHRASE);

    useDevice("A");
    await a.deleteRemote();
    expect(a.getView()).toEqual({ status: "off", remote: false });
    expect(fake.row()).toBeNull();

    useDevice("B");
    setModels(model("m1", "sk-a"), model("m9", "sk-9"));
    await b.syncNow();
    expect(b.getView()).toEqual({
      status: "off",
      remote: false,
      notice: "remote-removed",
    });
    // no silent re-upload, and this device keeps its settings
    expect(fake.row()).toBeNull();
    expect(modelIds()).toEqual(["m1", "m9"]);
  });

  it("turns off on one device without touching the account copy", async () => {
    const fake = createFakeService();
    useDevice("A");
    setModels(model("m1", "sk-a"));
    const a = await startEngine(fake);
    await a.enable(PASSPHRASE);

    a.turnOff();
    expect(a.getView()).toEqual({ status: "off", remote: true });
    expect(readDeviceSyncEntry(USER)).toBeNull();
    expect(fake.row()).not.toBeNull();

    setModels(model("local-only", "sk-x"));
    await a.flush();
    expect(fake.service.put).toHaveBeenCalledTimes(1);
  });

  it("asks for the passphrase again after it changed on another device", async () => {
    const fake = createFakeService();
    useDevice("A");
    const a = await startEngine(fake);
    await a.enable(PASSPHRASE);

    // another device deleted and re-created the copy with a new passphrase
    const kdf = createKdf(MIN_KDF_ITERATIONS);
    const key = await deriveSettingsKey("a brand new passphrase", kdf);
    fake.setRow({
      ...(await encryptSettings({ version: 1, sections: {} }, key, kdf, USER)),
      revision: 1,
      updatedAt: 1,
    });

    await a.syncNow();
    expect(a.getView()).toEqual({
      status: "off",
      remote: true,
      notice: "passphrase-changed",
    });
  });

  it("refuses an account row with weakened key derivation", async () => {
    const fake = createFakeService();
    const kdf = { ...createKdf(MIN_KDF_ITERATIONS), iterations: 1000 };
    fake.setRow({
      formatVersion: 1,
      kdf,
      iv: "aXZpdml2aXZpdml2",
      ciphertext: "eA==",
      revision: 1,
      updatedAt: 1,
    });
    useDevice("A");
    const a = await startEngine(fake);
    await expect(a.unlock(PASSPHRASE)).rejects.toMatchObject({
      code: "unsupported-kdf",
    });
  });

  it("keeps an account section this build rejects instead of overwriting it", async () => {
    const fake = createFakeService();
    // network settings saved by a build that allows this endpoint
    const kdf = createKdf(MIN_KDF_ITERATIONS);
    const key = await deriveSettingsKey(PASSPHRASE, kdf);
    const network = {
      version: 2,
      mode: "byok-proxy",
      endpoint: "http://proxy.example.com/ai-proxy/v1/forward",
      accessToken: "proxy-token",
      gatewayEndpoint: "",
      managedRoutes: {},
    };
    fake.setRow({
      ...(await encryptSettings(
        { version: 1, sections: { network } },
        key,
        kdf,
        USER,
      )),
      revision: 1,
      updatedAt: 1,
    });

    useDevice("B");
    saveAIProxyConfig({ mode: "direct" });
    const b = await startEngine(fake);
    await b.unlock(PASSPHRASE);
    expect(loadAIProxyConfig().mode).toBe("direct");

    setModels(model("m1", "sk-b"));
    await b.syncNow();
    const plaintext = await decryptRow(fake.row()!);
    expect(plaintext.sections.network).toEqual(network);
    expect(plaintext.sections.models.models[0].id).toBe("m1");
  });

  it("reports sync failures on the view without turning off", async () => {
    const fake = createFakeService();
    useDevice("A");
    setModels(model("m1", "sk-a"));
    const a = await startEngine(fake);
    await a.enable(PASSPHRASE);

    fake.service.get.mockRejectedValueOnce(
      new BackendError("network", "Cloud is unreachable."),
    );
    setModels(model("m2", "sk-a"));
    await a.syncNow();
    expect(a.getView()).toMatchObject({
      status: "on",
      error: { code: "backend", message: "Cloud is unreachable." },
    });

    await a.syncNow();
    expect(a.getView()).toMatchObject({ status: "on" });
    expect((a.getView() as any).error).toBeUndefined();
    expect(fake.row()!.revision).toBe(2);
  });

  it("uploads local edits after the debounce", async () => {
    const fake = createFakeService();
    useDevice("A");
    const a = await startEngine(fake);
    await a.enable(PASSPHRASE);

    setTemplate("Debounced");
    await a.flush();
    expect(fake.row()!.revision).toBe(2);
    expect((await decryptRow(fake.row()!)).sections.templates[0].label).toBe(
      "Debounced",
    );
  });

  it("forgets everything when the user signs out or switches", async () => {
    const fake = createFakeService();
    useDevice("A");
    const a = await startEngine(fake);
    await a.enable(PASSPHRASE);
    a.setUser(null);
    expect(a.getView()).toEqual({ status: "unavailable" });

    setModels(model("while-signed-out", "sk"));
    await a.flush();
    expect(fake.service.put).toHaveBeenCalledTimes(1);
    expect(() => a.turnOff()).not.toThrow();
    await expect(a.enable(PASSPHRASE)).rejects.toBeInstanceOf(AccountSyncError);
  });
});
