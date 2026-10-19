/**
 * Vault v2 (P4c) materializer: CRDT document → Excalidraw elements.
 *
 * W1 design §5 (pipeline), §6 (report), §8 (version stamp). Incremental: only
 * the dependency closure of the dirty set is recomputed (W1 §5.1, spike
 * tests/08: 0 escapes); unchanged elements keep their object identity, so the
 * editor's WeakMap shape/canvas caches keep hitting.
 *
 * Pipeline per element (fixed order, W1 §5.2):
 *  1 register winner by (c, actorId)   — losers left after R5 prune are concurrent
 *  2 explicit delete (tombstone-wins)
 *  3 originalText from Y.Text
 *  4 implicit delete: no tombstone + blank merged text (R4)
 *  5 derived boundElements, excluding 2/4
 *  6 text derivation (wrap, size, container grows only, bound position)
 *  8 invariant report (dangling bindings — report only, never repaired)
 *  9 local monotone version stamp (R7)
 * 10 order by (index, id) — indices are never rewritten
 */
import {
  computeBoundTextPosition,
  computeContainerDimensionForBoundText,
  getBoundTextMaxHeight,
  getBoundTextMaxWidth,
  hashString,
  refreshTextDimensions,
} from "@excalidraw/element";

import type {
  ElementsMap,
  ExcalidrawElement,
  ExcalidrawTextElement,
} from "@excalidraw/element/types";

import { compareCandidates } from "./sceneDoc";

import type { RegisterCandidate, VaultSceneDoc } from "./sceneDoc";

type Shape = Record<string, unknown> & { id: string; type: string };

export type VaultConflict = {
  readonly elementId: string;
  readonly field: string;
  readonly winner: RegisterCandidate;
  readonly losers: readonly RegisterCandidate[];
};

export type VaultDanglingBinding = {
  readonly elementId: string;
  readonly field: "startBinding" | "endBinding" | "containerId" | "frameId";
  readonly targetId: string;
};

export type VaultMaterializeReport = {
  /** register fields with ≥1 concurrent loser of a different value (ADR §2.6) */
  readonly conflicts: readonly VaultConflict[];
  /** references to deleted/missing elements (ADR §2.7, report only) */
  readonly danglingBindings: readonly VaultDanglingBinding[];
  /** text elements hidden because their merged text is blank (R4) */
  readonly implicitlyDeleted: readonly string[];
};

export type VaultMaterializeResult = {
  /** all elements (including deleted), ordered by (index, id) */
  readonly elements: readonly ExcalidrawElement[];
  /** ids whose output object changed in this pass */
  readonly changedIds: ReadonlySet<string>;
  readonly report: VaultMaterializeReport;
};

type Cached = {
  shape: Shape | null;
  element: ExcalidrawElement | null;
  digest: string;
  conflicts: VaultConflict[];
  implicitlyDeleted: boolean;
};

const VOLATILE = new Set(["version", "versionNonce"]);

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
};

const contentDigest = (shape: Shape) => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(shape)) {
    if (!VOLATILE.has(key)) {
      out[key] = value;
    }
  }
  return stableStringify(out);
};

const isBlank = (text: string) => text.trim() === "";

const bindingTarget = (value: unknown): string | null =>
  value &&
  typeof value === "object" &&
  typeof (value as any).elementId === "string"
    ? (value as { elementId: string }).elementId
    : null;

const CONTAINER_TYPES = new Set(["rectangle", "diamond", "ellipse", "arrow"]);

export type MaterializerOptions = {
  /**
   * current `version` of an element in the editor, if any. The stamp must
   * stay above it (the editor bumps versions on local mutation, R7).
   */
  readonly editorVersion?: (id: string) => number | undefined;
};

export class VaultSceneMaterializer {
  private readonly cache = new Map<string, Cached>();
  /** last emitted stamps (R7) */
  private readonly stamps = new Map<
    string,
    { version: number; versionNonce: number }
  >();
  private ordered: ExcalidrawElement[] = [];
  private dirty = new Set<string>();
  private all = true;
  private readonly unobserve: () => void;

  constructor(
    private readonly scene: VaultSceneDoc,
    private readonly options: MaterializerOptions = {},
  ) {
    const elements = scene.elements;
    const texts = scene.texts;
    const collect = (root: unknown) => (events: any[]) => {
      for (const event of events) {
        if (event.target === root) {
          for (const key of event.keysChanged as Set<string>) {
            this.dirty.add(key);
          }
          continue;
        }
        const id = event.path[0];
        if (typeof id === "string") {
          this.dirty.add(id);
        }
      }
    };
    const onElements = collect(elements);
    const onTexts = collect(texts);
    elements.observeDeep(onElements);
    texts.observeDeep(onTexts);
    this.unobserve = () => {
      elements.unobserveDeep(onElements);
      texts.unobserveDeep(onTexts);
    };
  }

  dispose() {
    this.unobserve();
  }

  /** forces the next pass to recompute everything (e.g. after fonts loaded, W1 §5.2) */
  invalidateAll() {
    this.all = true;
  }

  get pendingDirtyCount() {
    return this.all ? this.scene.elements.size : this.dirty.size;
  }

  // ---------------------------------------------------------------- step 1–4

  private readShape(id: string): {
    shape: Shape | null;
    conflicts: VaultConflict[];
    implicit: boolean;
  } {
    const candidates = this.scene.readCandidates(id);
    const typeCandidates = candidates.get("type");
    if (!typeCandidates?.length) {
      return { shape: null, conflicts: [], implicit: false };
    }
    const shape: Shape = { id, type: "" };
    const conflicts: VaultConflict[] = [];
    for (const [field, list] of candidates) {
      const sorted = [...list].sort(compareCandidates);
      const winner = sorted[sorted.length - 1];
      shape[field] = winner.value;
      const winnerValue = stableStringify(winner.value);
      const losers = sorted.filter(
        (candidate) =>
          candidate !== winner &&
          stableStringify(candidate.value) !== winnerValue,
      );
      if (losers.length > 0) {
        conflicts.push({ elementId: id, field, winner, losers });
      }
    }
    let isDeleted = this.scene.readTombstones(id).size > 0;
    let implicit = false;
    if (shape.type === "text") {
      const originalText = this.scene.readText(id) ?? "";
      shape.originalText = originalText;
      if (!isDeleted && isBlank(originalText)) {
        isDeleted = true;
        implicit = true;
      }
    }
    shape.isDeleted = isDeleted;
    return { shape, conflicts, implicit };
  }

  // ---------------------------------------------------------------- closure

  private closureOf(
    dirty: Iterable<string>,
    shapes: Map<string, Shape | null>,
  ) {
    const out = new Set<string>();
    const visit = (shape: Shape | null | undefined) => {
      if (!shape) {
        return;
      }
      if (typeof shape.containerId === "string") {
        out.add(shape.containerId);
      }
      for (const target of [
        bindingTarget(shape.startBinding),
        bindingTarget(shape.endBinding),
      ]) {
        if (target) {
          out.add(target);
        }
      }
    };
    for (const id of dirty) {
      out.add(id);
      visit(this.cache.get(id)?.shape);
      visit(shapes.get(id));
    }
    // reverse references (labels of a dirty container, arrows bound to it,
    // frame members): their derived/dangling state depends on the target
    for (const [id, cached] of this.cache) {
      const shape = shapes.has(id) ? shapes.get(id) : cached.shape;
      if (!shape) {
        continue;
      }
      const refs = [
        shape.containerId,
        bindingTarget(shape.startBinding),
        bindingTarget(shape.endBinding),
        shape.frameId,
      ];
      if (refs.some((ref) => typeof ref === "string" && out.has(ref))) {
        out.add(id);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- pass

  materialize(): VaultMaterializeResult {
    const ids = this.all
      ? new Set(this.scene.elements.keys())
      : new Set(this.dirty);
    if (this.all) {
      for (const id of this.cache.keys()) {
        ids.add(id);
      }
    }
    this.dirty = new Set();
    const full = this.all;
    this.all = false;

    // 1–4 for the dirty set
    const fresh = new Map<string, Shape | null>();
    const read = new Map<
      string,
      { conflicts: VaultConflict[]; implicit: boolean }
    >();
    for (const id of ids) {
      const { shape, conflicts, implicit } = this.readShape(id);
      fresh.set(id, shape);
      read.set(id, { conflicts, implicit });
    }
    const closure = full ? ids : this.closureOf(ids, fresh);
    for (const id of closure) {
      if (!fresh.has(id)) {
        const { shape, conflicts, implicit } = this.readShape(id);
        fresh.set(id, shape);
        read.set(id, { conflicts, implicit });
      }
    }

    const shapeOf = (id: string): Shape | null | undefined =>
      fresh.has(id) ? fresh.get(id) : this.cache.get(id)?.shape;

    // 5 boundElements for the closure, from all live referrers
    const bound = new Map<string, { type: string; id: string }[]>();
    const push = (target: string, entry: { type: string; id: string }) => {
      if (!closure.has(target)) {
        return;
      }
      const list = bound.get(target) ?? [];
      if (!list.some((existing) => existing.id === entry.id)) {
        list.push(entry);
      }
      bound.set(target, list);
    };
    const allIds = new Set([...this.cache.keys(), ...fresh.keys()]);
    for (const id of allIds) {
      const shape = shapeOf(id);
      if (!shape || shape.isDeleted) {
        continue;
      }
      if (shape.type === "line" || shape.type === "arrow") {
        for (const target of [
          bindingTarget(shape.startBinding),
          bindingTarget(shape.endBinding),
        ]) {
          if (target) {
            push(target, { type: shape.type, id });
          }
        }
      }
      if (shape.type === "text" && typeof shape.containerId === "string") {
        push(shape.containerId, { type: "text", id });
      }
    }

    // working copies of the closure (derivation mutates containers)
    const work = new Map<string, Shape>();
    for (const id of closure) {
      const shape = shapeOf(id);
      if (shape) {
        const list = bound.get(id);
        work.set(id, {
          ...shape,
          boundElements: list
            ? list.sort((a, b) =>
                a.type === b.type
                  ? a.id < b.id
                    ? -1
                    : 1
                  : a.type < b.type
                  ? -1
                  : 1,
              )
            : null,
        });
      }
    }

    // 6 text derivation: free text first, then bound text (containers final)
    const elementsMap = new Map<string, ExcalidrawElement>();
    for (const element of this.ordered) {
      elementsMap.set(element.id, element);
    }
    for (const [id, shape] of work) {
      elementsMap.set(id, shape as unknown as ExcalidrawElement);
    }
    const texts = [...work.values()].filter((shape) => shape.type === "text");
    texts.sort(
      (a, b) =>
        Number(typeof a.containerId === "string") -
        Number(typeof b.containerId === "string"),
    );
    for (const text of texts) {
      this.deriveText(text, work, elementsMap as unknown as ElementsMap);
    }

    // 8 + 9 + identity reuse
    const changedIds = new Set<string>();
    for (const id of closure) {
      const shape = work.get(id) ?? null;
      const previous = this.cache.get(id);
      const info = read.get(id) ?? {
        conflicts: previous?.conflicts ?? [],
        implicit: previous?.implicitlyDeleted ?? false,
      };
      if (!shape) {
        if (previous?.element) {
          changedIds.add(id);
        }
        this.cache.delete(id);
        this.stamps.delete(id);
        continue;
      }
      const digest = contentDigest(shape);
      const editorVersion = this.options.editorVersion?.(id);
      const stamp = this.stamps.get(id);
      const editorAhead =
        editorVersion !== undefined &&
        stamp !== undefined &&
        editorVersion > stamp.version;
      if (previous?.element && previous.digest === digest && !editorAhead) {
        this.cache.set(id, {
          ...previous,
          shape,
          conflicts: info.conflicts,
          implicitlyDeleted: info.implicit,
        });
        continue;
      }
      const next = this.stamp(id, shape, digest, editorVersion);
      this.cache.set(id, {
        shape,
        element: next,
        digest,
        conflicts: info.conflicts,
        implicitlyDeleted: info.implicit,
      });
      changedIds.add(id);
    }

    if (changedIds.size > 0 || full) {
      this.ordered = [...this.cache.values()]
        .map((entry) => entry.element)
        .filter((element): element is ExcalidrawElement => !!element)
        .sort((a, b) => {
          const ai = (a.index as string | null) ?? "";
          const bi = (b.index as string | null) ?? "";
          return ai < bi
            ? -1
            : ai > bi
            ? 1
            : a.id < b.id
            ? -1
            : a.id > b.id
            ? 1
            : 0;
        });
    }

    return { elements: this.ordered, changedIds, report: this.report() };
  }

  // ---------------------------------------------------------------- step 6

  private deriveText(
    text: Shape,
    work: Map<string, Shape>,
    elementsMap: ElementsMap,
  ) {
    const originalText = (text.originalText as string) ?? "";
    text.text ??= originalText;
    text.width ??= 0;
    text.height ??= 0;
    if (text.isDeleted) {
      text.text = originalText;
      return;
    }
    const container =
      typeof text.containerId === "string"
        ? work.get(text.containerId)
        : undefined;
    const live =
      container && !container.isDeleted && CONTAINER_TYPES.has(container.type)
        ? container
        : undefined;
    const refreshed = refreshTextDimensions(
      text as unknown as ExcalidrawTextElement,
      (live ?? null) as never,
      elementsMap,
      originalText,
    );
    if (refreshed) {
      text.text = refreshed.text;
      text.width = refreshed.width;
      text.height = refreshed.height;
      // free text keeps its stored x/y (same as the W0 spike); bound text is placed below
    }
    if (!live) {
      return;
    }
    if (live.type !== "arrow") {
      // grow like redrawTextBoundingBox(), never shrink (R1)
      const maxHeight = getBoundTextMaxHeight(live as never, text as never);
      if ((text.height as number) > maxHeight) {
        live.height = computeContainerDimensionForBoundText(
          text.height as number,
          live.type as never,
        );
      }
      const maxWidth = getBoundTextMaxWidth(live as never, text as never);
      if ((text.width as number) > maxWidth) {
        live.width = computeContainerDimensionForBoundText(
          text.width as number,
          live.type as never,
        );
      }
    }
    const position = computeBoundTextPosition(
      live as never,
      text as never,
      elementsMap,
    );
    text.x = position.x;
    text.y = position.y;
  }

  // ---------------------------------------------------------------- step 9

  private stamp(
    id: string,
    shape: Shape,
    digest: string,
    editorVersion: number | undefined,
  ): ExcalidrawElement {
    const deps = [id];
    if (typeof shape.containerId === "string") {
      deps.push(shape.containerId);
    }
    for (const entry of (shape.boundElements as
      | { type: string; id: string }[]
      | null) ?? []) {
      if (entry.type === "text") {
        deps.push(entry.id);
      }
    }
    let closureSum = 0;
    const parts: string[] = [];
    for (const dep of deps) {
      const clocks = this.scene.readClocks(dep);
      const keys = Object.keys(clocks).sort();
      for (const key of keys) {
        closureSum += clocks[key];
      }
      parts.push(
        `${dep}:${keys.map((key) => `${key}=${clocks[key]}`).join(",")}`,
      );
    }
    const previous = this.stamps.get(id);
    const version = Math.max(
      (previous?.version ?? 0) + 1,
      1 + closureSum,
      (editorVersion ?? 0) + 1,
    );
    const versionNonce = hashString(`${parts.join("|")}#${digest}`);
    this.stamps.set(id, { version, versionNonce });
    return { ...shape, version, versionNonce } as unknown as ExcalidrawElement;
  }

  // ---------------------------------------------------------------- report

  private report(): VaultMaterializeReport {
    const conflicts: VaultConflict[] = [];
    const implicitlyDeleted: string[] = [];
    const danglingBindings: VaultDanglingBinding[] = [];
    const isGone = (target: string) => {
      const shape = this.cache.get(target)?.shape;
      return !shape || shape.isDeleted === true;
    };
    for (const [id, cached] of this.cache) {
      conflicts.push(...cached.conflicts);
      if (cached.implicitlyDeleted) {
        implicitlyDeleted.push(id);
      }
      const shape = cached.shape;
      if (!shape || shape.isDeleted) {
        continue;
      }
      const refs: [VaultDanglingBinding["field"], unknown][] = [
        ["startBinding", bindingTarget(shape.startBinding)],
        ["endBinding", bindingTarget(shape.endBinding)],
        ["containerId", shape.containerId],
        ["frameId", shape.frameId],
      ];
      for (const [field, target] of refs) {
        if (typeof target === "string" && isGone(target)) {
          danglingBindings.push({ elementId: id, field, targetId: target });
        }
      }
    }
    return { conflicts, danglingBindings, implicitlyDeleted };
  }
}
