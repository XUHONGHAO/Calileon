import * as Y from "yjs";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import type { SceneData } from "@excalidraw/excalidraw/types";

import { VaultV2SceneController } from "./controller";
import { VAULT_V2_REMOTE_ORIGIN } from "./sceneDoc";
import { buildBasicScene, byId } from "./testUtils";

import type { VaultV2EditorApi } from "./controller";

/** minimal editor double: holds elements, bumps versions on local edits */
class FakeEditor implements VaultV2EditorApi {
  elements: ExcalidrawElement[] = [];
  updates = 0;
  getSceneElementsIncludingDeleted = () => this.elements;
  updateScene = (scene: SceneData) => {
    this.updates += 1;
    if (scene.elements) {
      this.elements = [...(scene.elements as ExcalidrawElement[])];
    }
  };
  edit(id: string, changes: Record<string, unknown>) {
    this.elements = this.elements.map((element) =>
      element.id === id
        ? ({
            ...element,
            ...changes,
            version: element.version + 1,
            versionNonce: (element.versionNonce * 31 + 7) | 0,
          } as ExcalidrawElement)
        : element,
    );
  }
}

/** two connected controllers; local updates are relayed to the peer */
const pair = () => {
  const make = (actorId: string) => {
    const controller = new VaultV2SceneController({ actorId });
    const editor = new FakeEditor();
    controller.attach(editor);
    const outbox: Uint8Array[] = [];
    controller.scene.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== VAULT_V2_REMOTE_ORIGIN) {
        outbox.push(update);
      }
    });
    return { controller, editor, outbox };
  };
  const a = make("actor-a");
  const b = make("actor-b");
  a.editor.elements = buildBasicScene();
  a.controller.captureLocal(a.editor.elements, null);
  const relay = (from: typeof a, to: typeof a) => {
    const merged = from.outbox.length ? Y.mergeUpdates(from.outbox) : null;
    from.outbox.length = 0;
    if (merged) {
      to.controller.applyRemote(merged);
    }
  };
  relay(a, b);
  a.controller.flushToEditor();
  return { a, b, relay };
};

describe("VaultV2SceneController · capture ⇄ apply", () => {
  it("a local edit reaches the peer editor, and does not echo back", () => {
    const { a, b, relay } = pair();
    expect(byId(b.editor.elements, "note-1")!.x).toBe(600);
    a.editor.edit("note-1", { x: 42 });
    expect(a.controller.captureLocal(a.editor.elements, null)).toBe(true);
    relay(a, b);
    expect(byId(b.editor.elements, "note-1")!.x).toBe(42);
    // B's editor onChange fires with what we pushed: nothing to capture
    expect(b.controller.captureLocal(b.editor.elements, null)).toBe(false);
    expect(b.outbox).toHaveLength(0);
  });

  it("derived fields never travel: a container resize rewraps the label on the peer", () => {
    const { a, b, relay } = pair();
    a.editor.edit("box-1", { width: 90 });
    a.controller.captureLocal(a.editor.elements, null);
    relay(a, b);
    const label = byId(b.editor.elements, "label-1")!;
    expect(label.text).toContain("\n");
  });

  it("explicit delete and local undo (retract)", () => {
    const { a, b, relay } = pair();
    a.editor.edit("box-2", { isDeleted: true });
    a.controller.captureLocal(a.editor.elements, null);
    relay(a, b);
    expect(byId(b.editor.elements, "box-2")!.isDeleted).toBe(true);
    a.editor.edit("box-2", { isDeleted: false });
    a.controller.captureLocal(a.editor.elements, null);
    relay(a, b);
    expect(byId(b.editor.elements, "box-2")!.isDeleted).toBe(false);
  });

  it("converged appState keys sync; others do not", () => {
    const { a, b, relay } = pair();
    let received: Record<string, unknown> | undefined;
    b.editor.updateScene = (scene) => {
      received = scene.appState as Record<string, unknown>;
    };
    a.controller.captureLocal(a.editor.elements, {
      viewBackgroundColor: "#123456",
      zoom: { value: 3 },
    } as never);
    relay(a, b);
    expect(received?.viewBackgroundColor).toBe("#123456");
    expect(received && "zoom" in received).toBe(false);
  });
});

describe("VaultV2SceneController · text editor binding", () => {
  const openEditor = (side: ReturnType<typeof pair>["a"], id: string) => {
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.value = byId(side.editor.elements, id)!.originalText;
    const dispose = side.controller.onTextEditorMount({
      elementId: id,
      textarea,
    })!;
    const type = (value: string, caret = value.length) => {
      textarea.value = value;
      textarea.setSelectionRange(caret, caret);
      textarea.dispatchEvent(new Event("input"));
    };
    return { textarea, dispose, type };
  };

  it("typing is relayed per splice; a remote insert patches the open textarea and keeps the caret", () => {
    const { a, b, relay } = pair();
    const ed = openEditor(a, "note-1");
    ed.type("note!", 5);
    relay(a, b);
    expect(byId(b.editor.elements, "note-1")!.originalText).toBe("note!");
    // B types at the start while A's caret is at the end
    b.editor.edit("note-1", { originalText: ">> note!" });
    b.controller.captureLocal(b.editor.elements, null);
    relay(b, a);
    expect(ed.textarea.value).toBe(">> note!");
    expect(ed.textarea.selectionStart).toBe(8);
    ed.dispose();
  });

  it("IME: remote edits during composition wait; the composed text lands where composition started", () => {
    const { a, b, relay } = pair();
    const ed = openEditor(a, "note-1");
    ed.textarea.setSelectionRange(4, 4);
    ed.textarea.dispatchEvent(new Event("compositionstart"));
    ed.textarea.value = "notenihao"; // intermediate pinyin, never sent
    ed.textarea.dispatchEvent(new Event("input"));
    expect(a.outbox).toHaveLength(0);
    b.editor.edit("note-1", { originalText: "my note" });
    b.controller.captureLocal(b.editor.elements, null);
    relay(b, a);
    expect(ed.textarea.value).toBe("notenihao"); // not patched mid-composition
    ed.textarea.value = "note你好";
    ed.textarea.dispatchEvent(new Event("compositionend"));
    expect(ed.textarea.value).toBe("my note你好");
    relay(a, b);
    expect(byId(b.editor.elements, "note-1")!.originalText).toBe("my note你好");
    ed.dispose();
  });

  it("undo of an edit session restores via Y.UndoManager and keeps a peer's concurrent text (R2)", () => {
    const { a, b, relay } = pair();
    const ed = openEditor(a, "note-1");
    ed.type("note A", 6);
    ed.dispose();
    a.editor.edit("note-1", { originalText: "note A" });
    a.controller.captureLocal(a.editor.elements, null);
    relay(a, b);
    // B prepends while A is not editing
    b.editor.edit("note-1", { originalText: "B: note A" });
    b.controller.captureLocal(b.editor.elements, null);
    relay(b, a);
    // A's History undo restores the whole old value of its session ("note")
    a.editor.edit("note-1", { originalText: "note" });
    a.controller.captureLocal(a.editor.elements, null);
    a.controller.flushToEditor();
    relay(a, b);
    expect(byId(a.editor.elements, "note-1")!.originalText).toBe("B: note");
    expect(byId(b.editor.elements, "note-1")!.originalText).toBe("B: note");
    // redo
    a.editor.edit("note-1", { originalText: "note A" });
    a.controller.captureLocal(a.editor.elements, null);
    a.controller.flushToEditor();
    expect(byId(a.editor.elements, "note-1")!.originalText).toBe("B: note A");
  });
});
