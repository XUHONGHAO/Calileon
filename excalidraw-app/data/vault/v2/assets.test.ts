import type { ExcalidrawElement } from "@excalidraw/element/types";

import type { BinaryFileData, BinaryFiles } from "@excalidraw/excalidraw/types";

import { decryptVaultFile } from "../fileAssets";
import { VaultLocalStore } from "../local-store";

import {
  FakeAssetServer,
  TEST_FILE_ID as FILE_ID,
  imageElement,
  imageFile,
} from "./assetTestUtils";
import { VaultV2Assets } from "./assets";

import type { VaultV2AssetEditorApi } from "./assets";

const VAULT_ID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const ROOM_ID = "room_1234567890abcdef";
const ROOT_KEY = `${"F".repeat(42)}A`;
const CAPABILITY = `${"G".repeat(42)}A`;

/** a minimal editor: elements + files, updateScene replaces elements */
class FakeEditor implements VaultV2AssetEditorApi {
  elements: readonly ExcalidrawElement[] = [];
  files: BinaryFiles = {};
  getSceneElementsIncludingDeleted = () => this.elements;
  getFiles = () => this.files;
  addFiles = (files: BinaryFileData[]) => {
    this.files = {
      ...this.files,
      ...Object.fromEntries(files.map((file) => [file.id, file])),
    };
  };
  updateScene = (scene: { elements: readonly ExcalidrawElement[] }) => {
    this.elements = scene.elements;
  };
}

let dbIndex = 0;
const freshStore = () =>
  VaultLocalStore.open({
    databaseName: `vault-v2-assets-${++dbIndex}-${Date.now()}`,
  });

const make = async (
  server: FakeAssetServer,
  role: "editor" | "viewer",
  options: { store?: boolean; online?: () => boolean } = {},
) => {
  const store = options.store === false ? null : await freshStore();
  const assets = new VaultV2Assets({
    vaultId: VAULT_ID,
    roomId: ROOM_ID,
    rootKey: ROOT_KEY,
    invitationCapability: CAPABILITY,
    role,
    service: server.service,
    store: role === "editor" ? store : null,
    isOnline: options.online,
    delayMs: 0,
  });
  const editor = new FakeEditor();
  return { assets, editor, store };
};

const statusOf = (editor: FakeEditor, id: string) =>
  (editor.elements.find((element) => element.id === id) as any)?.status;

describe("VaultV2Assets (W5)", () => {
  it("uploads a new image under the v2 key and only then marks it saved", async () => {
    const server = new FakeAssetServer();
    const { assets, editor, store } = await make(server, "editor");
    editor.elements = [imageElement("img-1", FILE_ID, "pending")];
    editor.files = { [FILE_ID]: imageFile() };
    assets.attach(editor);
    await assets.run();

    expect(statusOf(editor, "img-1")).toBe("saved");
    const stored = server.objects.get(`${VAULT_ID}/${FILE_ID}`)!;
    // 0029 envelope bound to the v2 Vault; never plaintext on the server
    expect(stored.envelope.vaultId).toBe(VAULT_ID);
    expect(JSON.stringify(stored.envelope)).not.toContain(
      "djItYXNzZXQtYnl0ZXM",
    );
    expect(
      await decryptVaultFile({
        vaultId: VAULT_ID,
        rootKey: ROOT_KEY,
        fileId: FILE_ID,
        envelope: stored.envelope,
      }),
    ).toMatchObject({ id: FILE_ID, dataURL: imageFile().dataURL });
    assets.dispose();
    store?.close();
  });

  it("keeps an offline upload pending and resends the same ciphertext later", async () => {
    const server = new FakeAssetServer();
    let online = false;
    const { assets, editor, store } = await make(server, "editor", {
      online: () => online,
    });
    editor.elements = [imageElement("img-1", FILE_ID, "pending")];
    editor.files = { [FILE_ID]: imageFile() };
    assets.attach(editor);
    await assets.run();
    expect(statusOf(editor, "img-1")).toBe("pending");
    expect(server.uploads).toBe(0);
    const [queued] = await assets.queue!.listTasks();

    online = true;
    assets.schedule();
    await assets.run();
    expect(statusOf(editor, "img-1")).toBe("saved");
    expect(server.objects.get(`${VAULT_ID}/${FILE_ID}`)!.encryptedDigest).toBe(
      queued.encryptedDigest,
    );
    assets.dispose();
    store?.close();
  });

  it("fetches files of saved images for a viewer and never uploads", async () => {
    const server = new FakeAssetServer();
    const author = await make(server, "editor");
    author.editor.elements = [imageElement("img-1", FILE_ID, "pending")];
    author.editor.files = { [FILE_ID]: imageFile() };
    author.assets.attach(author.editor);
    await author.assets.run();
    const uploads = server.uploads;

    const viewer = await make(server, "viewer");
    // the materialized doc delivers only the element (fileId + status)
    viewer.editor.elements = author.editor.elements;
    viewer.assets.attach(viewer.editor);
    await viewer.assets.run();
    expect(viewer.editor.files[FILE_ID]).toMatchObject({
      dataURL: imageFile().dataURL,
    });
    expect(server.uploads).toBe(uploads);
    author.assets.dispose();
    viewer.assets.dispose();
    author.store?.close();
  });

  it("does not fetch images that are still pending at their author", async () => {
    const server = new FakeAssetServer();
    const viewer = await make(server, "viewer");
    viewer.editor.elements = [imageElement("img-1", FILE_ID, "pending")];
    viewer.assets.attach(viewer.editor);
    await viewer.assets.run();
    expect(viewer.editor.files[FILE_ID]).toBeUndefined();
    viewer.assets.dispose();
  });

  it("works without a local store (direct upload)", async () => {
    const server = new FakeAssetServer();
    const { assets, editor } = await make(server, "editor", { store: false });
    expect(assets.queue).toBeNull();
    editor.elements = [imageElement("img-1", FILE_ID, "pending")];
    editor.files = { [FILE_ID]: imageFile() };
    assets.attach(editor);
    await assets.run();
    expect(statusOf(editor, "img-1")).toBe("saved");
    assets.dispose();
  });
});
