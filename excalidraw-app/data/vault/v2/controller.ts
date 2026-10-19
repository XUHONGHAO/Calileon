/**
 * Vault v2 (P4c) scene controller: editor ⇄ CRDT document.
 *
 * W1 design §4 (capture), §5 (remote → materialize → updateScene), §7 (undo).
 *
 * - `captureLocal(elements, appState)` is called from the editor's onChange.
 *   It diffs every element whose `version`/`versionNonce` moved since the
 *   last known state and writes only changed register fields, all in ONE
 *   transaction (one Lamport clock). Elements we emitted ourselves are known
 *   and skipped, so remote updates never echo back.
 * - `applyRemote(update)` merges a remote Yjs update and pushes the
 *   materialized changes into the editor with `CaptureUpdateAction.NEVER`
 *   (remote changes never enter the local undo stack, ADR 0030 §2.8).
 * - while a text editor is open on an element, its `originalText` is owned by
 *   `VaultTextBinding` (6-D deferred strategy); capture skips it.
 * - text undo/redo (R2): when History restores an element's whole
 *   `originalText` to the value before/after one of OUR edit sessions, the
 *   element's `Y.UndoManager` undoes/redoes that session instead, so text
 *   typed by others in the meantime survives.
 */
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import * as Y from "yjs";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import type { AppState, SceneData } from "@excalidraw/excalidraw/types";

import { VaultSceneMaterializer } from "./materialize";
import {
  CONVERGED_APP_STATE_KEYS,
  isRegisterField,
  isSupportedElementType,
} from "./schema";
import { VAULT_V2_LOCAL_TEXT_ORIGIN, VaultSceneDoc } from "./sceneDoc";
import { VaultTextBinding } from "./textBinding";

import type {
  VaultMaterializeReport,
  VaultMaterializeResult,
} from "./materialize";

/** the slice of the imperative API the controller uses */
export type VaultV2EditorApi = {
  getSceneElementsIncludingDeleted(): readonly ExcalidrawElement[];
  // method syntax: accepts ExcalidrawImperativeAPI's generic updateScene
  updateScene(scene: SceneData): void;
};

type Known = { version: number; versionNonce: number; snapshot: string };

type TextSession = { before: string; after: string };

const isBlank = (text: string) => text.trim() === "";

const snapshotOf = (element: ExcalidrawElement) => {
  const { version, versionNonce, updated, ...rest } = element as any;
  return JSON.stringify(rest);
};

export class VaultV2SceneController {
  readonly scene: VaultSceneDoc;
  readonly materializer: VaultSceneMaterializer;

  private api: VaultV2EditorApi | null = null;
  private readonly known = new Map<string, Known>();
  private readonly fieldsSeen = new Map<string, Record<string, unknown>>();
  private readonly bindings = new Map<string, VaultTextBinding>();
  private readonly undoManagers = new Map<string, Y.UndoManager>();
  private readonly sessions = new WeakMap<object, TextSession>();
  private appStateSeen: Partial<Record<string, string>> = {};
  private applying = false;
  private lastReport: VaultMaterializeReport = {
    conflicts: [],
    danglingBindings: [],
    implicitlyDeleted: [],
  };

  private appStateDirty = true;
  private readonly flushListeners = new Set<
    (result: VaultMaterializeResult) => void
  >();

  constructor(options: { actorId: string; doc?: Y.Doc }) {
    this.scene = new VaultSceneDoc(options);
    this.scene.appState.observe(() => {
      this.appStateDirty = true;
    });
    this.materializer = new VaultSceneMaterializer(this.scene, {
      editorVersion: (id) => this.editorVersions?.get(id),
    });
  }

  private editorVersions: Map<string, number> | null = null;

  get report(): VaultMaterializeReport {
    return this.lastReport;
  }

  attach(api: VaultV2EditorApi) {
    this.api = api;
  }

  /** called after every materialize (W6 notices); returns an unsubscribe */
  onFlush(listener: (result: VaultMaterializeResult) => void) {
    this.flushListeners.add(listener);
    return () => {
      this.flushListeners.delete(listener);
    };
  }

  detach() {
    for (const binding of this.bindings.values()) {
      binding.dispose();
    }
    this.bindings.clear();
    this.api = null;
  }

  // ------------------------------------------------------------ remote → editor

  /** merges remote state and pushes the result into the editor */
  applyRemote(update: Uint8Array) {
    this.scene.applyRemoteUpdate(update);
    this.flushToEditor();
  }

  /** materializes pending changes and pushes them into the editor */
  flushToEditor(appState?: Partial<AppState>) {
    const api = this.api;
    const current = api?.getSceneElementsIncludingDeleted() ?? [];
    this.editorVersions = new Map(
      current.map((element) => [element.id, element.version]),
    );
    const result = this.materializer.materialize();
    this.editorVersions = null;
    this.lastReport = result.report;
    for (const listener of this.flushListeners) {
      listener(result);
    }
    const appStateChanged = this.appStateDirty;
    if (
      !api ||
      (result.changedIds.size === 0 && !appState && !appStateChanged)
    ) {
      return result;
    }
    this.appStateDirty = false;
    const byId = new Map(current.map((element) => [element.id, element]));
    const next: ExcalidrawElement[] = [];
    const seen = new Set<string>();
    for (const element of result.elements) {
      seen.add(element.id);
      // the element being typed into stays the editor's own (W1 §5.3)
      const local = byId.get(element.id);
      if (
        local &&
        this.bindings.has(element.id) &&
        !result.changedIds.has(element.id)
      ) {
        next.push(local);
        continue;
      }
      next.push(element);
    }
    // local elements the document does not know yet (e.g. a text being created)
    for (const element of current) {
      if (!seen.has(element.id)) {
        next.push(element);
      }
    }
    this.applying = true;
    try {
      api.updateScene({
        elements: next,
        appState: { ...appState, ...this.readAppState() },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    } finally {
      this.applying = false;
    }
    // whatever the editor holds now (after its own index repair) is the baseline
    for (const element of api.getSceneElementsIncludingDeleted()) {
      // only elements the document has; purely local ones must still be captured
      if (
        this.scene.hasElement(element.id) &&
        (result.changedIds.has(element.id) || !this.known.has(element.id))
      ) {
        this.remember(element);
      }
    }
    // an index the editor repaired (duplicate after concurrent moves) is
    // written back so every replica converges on it
    this.captureLocal(api.getSceneElementsIncludingDeleted(), null, {
      indexOnly: true,
    });
    return result;
  }

  private readAppState(): Partial<AppState> {
    const out: Record<string, unknown> = {};
    for (const [key, candidates] of this.scene.readAppStateCandidates()) {
      const winner = [...candidates].sort((a, b) =>
        a.clock !== b.clock
          ? a.clock - b.clock
          : a.actorId < b.actorId
          ? -1
          : 1,
      )[candidates.length - 1];
      out[key] = winner.value;
      this.appStateSeen[key] = JSON.stringify(winner.value);
    }
    return out as Partial<AppState>;
  }

  private remember(element: ExcalidrawElement) {
    this.known.set(element.id, {
      version: element.version,
      versionNonce: element.versionNonce,
      snapshot: snapshotOf(element),
    });
    this.fieldsSeen.set(element.id, JSON.parse(JSON.stringify(element)));
  }

  // ------------------------------------------------------------ editor → doc

  /**
   * Writes local changes into the document. Returns whether anything was
   * written (the caller then schedules a W2 batch flush).
   */
  captureLocal(
    elements: readonly ExcalidrawElement[],
    appState: Partial<AppState> | null,
    options: { indexOnly?: boolean } = {},
  ): boolean {
    if (this.applying) {
      return false;
    }
    const before = this.scene.observedMaxClock;
    let wrote = false;
    this.deferredUndo = [];
    this.scene.transact(() => {
      for (const element of elements) {
        const known = this.known.get(element.id);
        if (
          known &&
          known.version === element.version &&
          known.versionNonce === element.versionNonce
        ) {
          continue;
        }
        if (known && known.snapshot === snapshotOf(element)) {
          this.remember(element);
          continue;
        }
        if (!isSupportedElementType(element.type)) {
          continue; // e.g. selection; never synced
        }
        if (options.indexOnly) {
          if (!this.scene.hasElement(element.id)) {
            continue; // not in the document yet: the next normal capture creates it
          }
          const seenIndex = this.fieldsSeen.get(element.id)?.index;
          if (
            this.scene.hasElement(element.id) &&
            seenIndex !== element.index
          ) {
            this.scene.writeFields(element.id, { index: element.index });
            wrote = true;
          }
          this.remember(element);
          continue;
        }
        wrote = this.captureElement(element) || wrote;
        this.remember(element);
      }
      if (appState) {
        for (const key of CONVERGED_APP_STATE_KEYS) {
          const value = (appState as Record<string, unknown>)[key];
          if (value === undefined) {
            continue;
          }
          const serialized = JSON.stringify(value);
          if (this.appStateSeen[key] !== serialized) {
            this.scene.writeAppState(key, value);
            this.appStateSeen[key] = serialized;
            wrote = true;
          }
        }
      }
    });
    // Y.UndoManager must run in its own transaction (origin = the manager),
    // otherwise it neither recognises the undo nor fills its redo stack
    for (const { id, manager, kind } of this.deferredUndo) {
      if (kind === "undo") {
        manager.undo();
      } else {
        manager.redo();
      }
      this.scene.transact(() => this.scene.touchElement(id));
      wrote = true;
    }
    this.deferredUndo = [];
    return wrote || this.scene.observedMaxClock !== before;
  }

  private deferredUndo: {
    id: string;
    manager: Y.UndoManager;
    kind: "undo" | "redo";
  }[] = [];

  private captureElement(element: ExcalidrawElement): boolean {
    const record = element as unknown as Record<string, unknown>;
    if (!this.scene.hasElement(element.id)) {
      // a text being created stays local until it has content (R4: blank = hidden anyway)
      if (
        element.isDeleted &&
        element.type === "text" &&
        isBlank(element.originalText)
      ) {
        return false;
      }
      this.scene.createElement(element);
      return true;
    }
    const seen = this.fieldsSeen.get(element.id) ?? {};
    const isBound = typeof record.containerId === "string";
    const changes: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(record)) {
      if (
        field === "type" ||
        !(
          isRegisterField(element.type, field, isBound) ||
          field === "containerId"
        )
      ) {
        continue;
      }
      if (JSON.stringify(seen[field]) !== JSON.stringify(value)) {
        changes[field] = value;
      }
    }
    if ("containerId" in changes && !isBound) {
      Object.assign(changes, {
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
      });
    }
    let wrote = false;
    if (Object.keys(changes).length > 0) {
      this.scene.writeFields(element.id, changes);
      wrote = true;
    }

    if (element.type === "text" && !this.bindings.has(element.id)) {
      const current = this.scene.readText(element.id) ?? "";
      const target = element.originalText;
      // implicit delete (R4): a blank submit clears the text, no tombstone
      if (
        current !== target &&
        !(element.isDeleted && isBlank(target) && isBlank(current))
      ) {
        wrote = this.restoreText(element.id, current, target) || wrote;
      }
    }

    const wasDeleted = seen.isDeleted === true;
    if (element.isDeleted !== wasDeleted) {
      const implicit = element.type === "text" && isBlank(element.originalText);
      if (element.isDeleted && !implicit) {
        this.scene.deleteElement(element.id);
        wrote = true;
      } else if (!element.isDeleted) {
        this.scene.retractDelete(element.id);
        wrote = true;
      }
    }
    return wrote;
  }

  /** whole-value text change outside the editor: undo/redo our session, or diff (R2) */
  private restoreText(id: string, current: string, target: string): boolean {
    const manager = this.undoManagers.get(id);
    const top = manager?.undoStack[manager.undoStack.length - 1];
    const redoTop = manager?.redoStack[manager.redoStack.length - 1];
    const undoSession = top && this.sessions.get(top);
    const redoSession = redoTop && this.sessions.get(redoTop);
    if (manager && undoSession && undoSession.before === target) {
      this.deferredUndo.push({ id, manager, kind: "undo" });
      return true;
    }
    if (manager && redoSession && redoSession.after === target) {
      this.deferredUndo.push({ id, manager, kind: "redo" });
      return true;
    }
    this.scene.editText(id, target);
    return true;
  }

  // ------------------------------------------------------------ text editor

  /** `ExcalidrawProps.onTextEditorMount` */
  onTextEditorMount = ({
    elementId,
    textarea,
  }: {
    elementId: string;
    textarea: HTMLTextAreaElement;
  }) => {
    const api = this.api;
    if (!this.scene.hasElement(elementId)) {
      // new text: create it now (blank → hidden for peers until it has content)
      const element = api
        ?.getSceneElementsIncludingDeleted()
        .find((candidate) => candidate.id === elementId);
      if (!element || element.type !== "text") {
        return;
      }
      this.scene.transact(() =>
        this.scene.createElement({ ...element, isDeleted: false }),
      );
      this.remember(element);
    }
    const manager = this.undoManagerFor(elementId);
    manager.stopCapturing();
    const before = this.scene.readText(elementId) ?? "";
    const binding = new VaultTextBinding(this.scene, elementId, textarea);
    this.bindings.set(elementId, binding);
    return () => {
      binding.dispose();
      this.bindings.delete(elementId);
      manager.stopCapturing();
      const top = manager.undoStack[manager.undoStack.length - 1];
      if (top && !this.sessions.has(top)) {
        this.sessions.set(top, {
          before,
          after: this.scene.readText(elementId) ?? "",
        });
      }
    };
  };

  private undoManagerFor(id: string): Y.UndoManager {
    let manager = this.undoManagers.get(id);
    if (!manager) {
      manager = new Y.UndoManager(this.scene.getText(id)!, {
        trackedOrigins: new Set([VAULT_V2_LOCAL_TEXT_ORIGIN]),
        captureTimeout: Number.MAX_SAFE_INTEGER,
      });
      // undo moves a session to the redo stack as a NEW stack item (and back).
      // Yjs emits 'stack-item-added' for the new item BEFORE 'stack-item-popped'
      // for the old one, so carry the session over on 'popped'
      const owner = manager;
      owner.on(
        "stack-item-popped",
        (event: { stackItem: object; type: "undo" | "redo" }) => {
          const session = this.sessions.get(event.stackItem);
          const target =
            event.type === "undo" ? owner.redoStack : owner.undoStack;
          const added = target[target.length - 1];
          if (session && added && !this.sessions.has(added)) {
            this.sessions.set(added, session);
          }
        },
      );
      this.undoManagers.set(id, manager);
    }
    return manager;
  }

  isTextBound(id: string) {
    return this.bindings.has(id);
  }
}
