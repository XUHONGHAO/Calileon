/**
 * Vault v2 (P4c) converged scene document over Yjs.
 *
 * ADR 0030 §2 + W1 design §3–§4. One `Y.Doc` per Vault:
 *
 *   elements/<id>/__fields/<field>\0<actorId> = { v, c, s }   explicit-clock registers (R6: flat)
 *   elements/<id>/__clocks/<actorId>         = number         per-actor max clock for the element
 *   elements/<id>/__delete/<actorId>         = { c, o }       explicit-delete tombstones
 *   texts/<id>                               = Y.Text         text `originalText` (R1)
 *   appState/<key>\0<actorId>                = { v, c, s }    the 5 converged appState keys
 *   meta                                     = { schemaVersion }
 *
 * - every write to a register first deletes the other actors' entries of that
 *   register (R5 `prune`): what remains is pairwise concurrent;
 * - one Lamport clock per transaction (one user action);
 * - element maps and their sub-maps are created exactly once, by the element's
 *   creator (S2, R6). Writing to an element this replica does not know throws.
 */
import * as Y from "yjs";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import {
  CONVERGED_APP_STATE_KEYS,
  ELEMENT_CLOCKS,
  ELEMENT_DELETE,
  ELEMENT_FIELDS,
  REGISTER_KEY_SEPARATOR,
  ROOT_APP_STATE,
  ROOT_ELEMENTS,
  ROOT_META,
  ROOT_TEXTS,
  VAULT_SCENE_SCHEMA_VERSION,
  VaultSchemaError,
  isRegisterField,
  isSupportedElementType,
  registerFieldsForType,
} from "./schema";
import { diffText, isNoop } from "./textDiff";

import type { ConvergedAppStateKey } from "./schema";
import type { Splice } from "./textDiff";

export type RegisterEntry = {
  readonly v: unknown;
  /** Lamport clock of the write */
  readonly c: number;
  /** strongest tombstone clock the writer had seen (ADR 0030 §2.1 `s`) */
  readonly s: number;
};

export type Tombstone = {
  readonly c: number;
  /** per-actor clocks of this element the deleter had observed */
  readonly o: Readonly<Record<string, number>>;
};

export type RegisterCandidate = {
  readonly actorId: string;
  readonly clock: number;
  readonly value: unknown;
};

/** transaction origins (W1 §2) */
export const VAULT_V2_LOCAL_ORIGIN = "vault-v2:local";
export const VAULT_V2_REMOTE_ORIGIN = "vault-v2:remote";
/** text edits made by the local text binding; the only origin Y.UndoManager tracks (R2) */
export const VAULT_V2_LOCAL_TEXT_ORIGIN = "vault-v2:local-text";

type ElementMap = Y.Map<unknown>;

export const registerKey = (field: string, actorId: string) =>
  `${field}${REGISTER_KEY_SEPARATOR}${actorId}`;

export const splitRegisterKey = (key: string): [string, string] => {
  const at = key.indexOf(REGISTER_KEY_SEPARATOR);
  return at < 0 ? [key, ""] : [key.slice(0, at), key.slice(at + 1)];
};

/** `(c, actorId)` order; ADR 0030 §2.1 */
export const compareCandidates = (
  a: { clock: number; actorId: string },
  b: { clock: number; actorId: string },
) =>
  a.clock !== b.clock
    ? a.clock - b.clock
    : a.actorId < b.actorId
    ? -1
    : a.actorId > b.actorId
    ? 1
    : 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** plain JSON copy: registers must never hold live editor objects */
const toStored = (value: unknown): unknown =>
  value === undefined ? null : JSON.parse(JSON.stringify(value));

export class VaultSceneDoc {
  readonly doc: Y.Doc;
  readonly actorId: string;

  private maxClock = 0;
  /** clock of the running local transaction (one per user action) */
  private txClock: number | null = null;
  private txDepth = 0;

  constructor(options: { actorId: string; doc?: Y.Doc }) {
    if (!options.actorId || options.actorId.includes(REGISTER_KEY_SEPARATOR)) {
      throw new VaultSchemaError("invalid actorId");
    }
    this.actorId = options.actorId;
    this.doc = options.doc ?? new Y.Doc();
    this.scanAllClocks();
    this.elements.observeDeep((events) => this.noteEvents(events));
    this.appState.observe((event) => this.noteEvents([event]));
  }

  get elements(): Y.Map<ElementMap> {
    return this.doc.getMap<ElementMap>(ROOT_ELEMENTS);
  }

  get texts(): Y.Map<Y.Text> {
    return this.doc.getMap<Y.Text>(ROOT_TEXTS);
  }

  get appState(): Y.Map<RegisterEntry> {
    return this.doc.getMap<RegisterEntry>(ROOT_APP_STATE);
  }

  get meta(): Y.Map<unknown> {
    return this.doc.getMap<unknown>(ROOT_META);
  }

  /** highest Lamport clock this replica has observed */
  get observedMaxClock(): number {
    return this.maxClock;
  }

  // ------------------------------------------------------------- clocks

  private observeClock(clock: unknown) {
    if (typeof clock === "number" && clock > this.maxClock) {
      this.maxClock = clock;
    }
  }

  private noteValue(value: unknown) {
    if (typeof value === "number") {
      this.observeClock(value);
    } else if (value instanceof Y.Map) {
      this.scanElement(value);
    } else if (isRecord(value)) {
      this.observeClock(value.c);
    }
  }

  private noteEvents(events: readonly Y.YEvent<any>[]) {
    for (const event of events) {
      if (!(event.target instanceof Y.Map)) {
        continue;
      }
      for (const key of (event as Y.YMapEvent<unknown>).keysChanged) {
        this.noteValue(event.target.get(key));
      }
    }
  }

  private scanElement(element: ElementMap) {
    for (const key of [ELEMENT_FIELDS, ELEMENT_CLOCKS, ELEMENT_DELETE]) {
      const map = element.get(key);
      if (map instanceof Y.Map) {
        for (const value of map.values()) {
          this.noteValue(value);
        }
      }
    }
  }

  private scanAllClocks() {
    for (const element of this.elements.values()) {
      this.scanElement(element);
    }
    for (const entry of this.appState.values()) {
      this.noteValue(entry);
    }
  }

  private clock(): number {
    if (this.txDepth === 0) {
      throw new Error("VaultSceneDoc writes must run inside transact()");
    }
    if (this.txClock === null) {
      this.maxClock += 1;
      this.txClock = this.maxClock;
    }
    return this.txClock;
  }

  /**
   * Runs `body` as ONE Yjs transaction with ONE Lamport clock (W1 §4.1 step 3).
   * Nested calls join the outer transaction.
   */
  transact<T>(body: () => T, origin: unknown = VAULT_V2_LOCAL_ORIGIN): T {
    if (this.txDepth > 0) {
      return body();
    }
    let result!: T;
    this.txDepth = 1;
    try {
      this.doc.transact(() => {
        result = body();
      }, origin);
    } finally {
      this.txDepth = 0;
      this.txClock = null;
    }
    return result;
  }

  /** applies a remote Yjs update (never part of the local undo stack) */
  applyRemoteUpdate(update: Uint8Array) {
    Y.applyUpdate(this.doc, update, VAULT_V2_REMOTE_ORIGIN);
  }

  // ------------------------------------------------------------- reads

  hasElement(id: string): boolean {
    return this.elements.has(id);
  }

  private elementMap(id: string): ElementMap {
    const element = this.elements.get(id);
    if (!element) {
      throw new VaultSchemaError(`unknown element ${id}`);
    }
    return element;
  }

  private subMap<V>(element: ElementMap, key: string): Y.Map<V> {
    const map = element.get(key);
    if (!(map instanceof Y.Map)) {
      throw new VaultSchemaError(`element map is missing ${key}`);
    }
    return map as Y.Map<V>;
  }

  /** all register candidates of one element, grouped by field */
  readCandidates(id: string): Map<string, RegisterCandidate[]> {
    const out = new Map<string, RegisterCandidate[]>();
    const element = this.elements.get(id);
    const fields = element?.get(ELEMENT_FIELDS);
    if (!(fields instanceof Y.Map)) {
      return out;
    }
    for (const [key, entry] of (fields as Y.Map<RegisterEntry>).entries()) {
      const [field, actorId] = splitRegisterKey(key);
      const list = out.get(field) ?? [];
      list.push({ actorId, clock: entry.c, value: entry.v });
      out.set(field, list);
    }
    return out;
  }

  readClocks(id: string): Record<string, number> {
    const out: Record<string, number> = {};
    const clocks = this.elements.get(id)?.get(ELEMENT_CLOCKS);
    if (clocks instanceof Y.Map) {
      for (const [actorId, clock] of (clocks as Y.Map<number>).entries()) {
        out[actorId] = clock;
      }
    }
    return out;
  }

  readTombstones(id: string): Map<string, Tombstone> {
    const out = new Map<string, Tombstone>();
    const deletes = this.elements.get(id)?.get(ELEMENT_DELETE);
    if (deletes instanceof Y.Map) {
      for (const [actorId, tombstone] of (
        deletes as Y.Map<Tombstone>
      ).entries()) {
        out.set(actorId, tombstone);
      }
    }
    return out;
  }

  readText(id: string): string | undefined {
    return this.texts.get(id)?.toString();
  }

  getText(id: string): Y.Text | undefined {
    return this.texts.get(id);
  }

  /** winning value of one register field, or `undefined` */
  readWinner(id: string, field: string): unknown {
    const candidates = this.readCandidates(id).get(field);
    if (!candidates?.length) {
      return undefined;
    }
    return [...candidates].sort(compareCandidates)[candidates.length - 1].value;
  }

  readAppStateCandidates(): Map<ConvergedAppStateKey, RegisterCandidate[]> {
    const out = new Map<ConvergedAppStateKey, RegisterCandidate[]>();
    for (const [key, entry] of this.appState.entries()) {
      const [field, actorId] = splitRegisterKey(key);
      if (!(CONVERGED_APP_STATE_KEYS as readonly string[]).includes(field)) {
        continue;
      }
      const list = out.get(field as ConvergedAppStateKey) ?? [];
      list.push({ actorId, clock: entry.c, value: entry.v });
      out.set(field as ConvergedAppStateKey, list);
    }
    return out;
  }

  // ------------------------------------------------------------- writes

  private strongestDeleteClock(element: ElementMap): number {
    let max = 0;
    for (const tombstone of this.subMap<Tombstone>(
      element,
      ELEMENT_DELETE,
    ).values()) {
      max = Math.max(max, tombstone.c);
    }
    return max;
  }

  private touch(element: ElementMap, clock: number) {
    this.subMap<number>(element, ELEMENT_CLOCKS).set(this.actorId, clock);
  }

  /** prune (R5) + set; `registers` is a flat `field\0actor` map */
  private writeRegister(
    registers: Y.Map<RegisterEntry>,
    field: string,
    value: unknown,
    clock: number,
    seenDelete: number,
  ) {
    const prefix = `${field}${REGISTER_KEY_SEPARATOR}`;
    const mine = registerKey(field, this.actorId);
    for (const key of [...registers.keys()]) {
      if (key !== mine && key.startsWith(prefix)) {
        registers.delete(key);
      }
    }
    registers.set(mine, { v: toStored(value), c: clock, s: seenDelete });
  }

  /**
   * Creates an element (S2: exactly once, by its creator). All register
   * fields are written — for text also `x`/`y`/`width`/`height`, so a later
   * unbind has a placement to fall back to.
   */
  createElement(element: ExcalidrawElement) {
    if (!isSupportedElementType(element.type)) {
      throw new VaultSchemaError(`unsupported element type: ${element.type}`);
    }
    if (this.elements.has(element.id)) {
      throw new VaultSchemaError(`element ${element.id} already exists (S2)`);
    }
    const clock = this.clock();
    const map = new Y.Map<unknown>();
    const fields = new Y.Map<RegisterEntry>();
    map.set(ELEMENT_FIELDS, fields);
    map.set(ELEMENT_CLOCKS, new Y.Map<number>());
    map.set(ELEMENT_DELETE, new Y.Map<Tombstone>());
    this.elements.set(element.id, map);
    const record = element as unknown as Record<string, unknown>;
    for (const field of registerFieldsForType(element.type)) {
      if (record[field] !== undefined) {
        this.writeRegister(fields, field, record[field], clock, 0);
      }
    }
    this.touch(map, clock);
    if (element.type === "text") {
      this.texts.set(element.id, new Y.Text(element.originalText ?? ""));
    }
    if (element.isDeleted) {
      this.deleteElement(element.id);
    }
  }

  /**
   * Writes changed register fields of an existing element. Derived fields
   * (R1, S10, R7) are skipped. Unbinding a text (`containerId` → `null`) also
   * writes its placement, which was derived while bound.
   */
  writeFields(id: string, changes: Readonly<Record<string, unknown>>) {
    const element = this.elementMap(id);
    const type = this.readWinner(id, "type");
    if (!isSupportedElementType(type)) {
      throw new VaultSchemaError(`element ${id} has no supported type`);
    }
    const containerAfter =
      "containerId" in changes
        ? changes.containerId
        : this.readWinner(id, "containerId");
    const isBound = typeof containerAfter === "string";
    const unbinding = type === "text" && "containerId" in changes && !isBound;
    const clock = this.clock();
    const seen = this.strongestDeleteClock(element);
    const fields = this.subMap<RegisterEntry>(element, ELEMENT_FIELDS);
    let wrote = false;
    for (const [field, value] of Object.entries(changes)) {
      if (field === "type") {
        continue; // written once at creation
      }
      const placement =
        unbinding && ["x", "y", "width", "height"].includes(field);
      if (!placement && !isRegisterField(type, field, isBound)) {
        continue;
      }
      this.writeRegister(fields, field, value, clock, seen);
      wrote = true;
    }
    if (wrote) {
      this.touch(element, clock);
    }
  }

  /** explicit delete (ADR 0030 §2.5): a per-actor tombstone, tombstone-wins */
  deleteElement(id: string) {
    const element = this.elementMap(id);
    const clock = this.clock();
    const observed = { ...this.readClocks(id), [this.actorId]: clock };
    this.subMap<Tombstone>(element, ELEMENT_DELETE).set(this.actorId, {
      c: clock,
      o: observed,
    });
    this.touch(element, clock);
  }

  /**
   * Withdraws this actor's own tombstone (local undo of a local delete). Other
   * actors' tombstones still win; returns whether the element is now free of
   * tombstones.
   */
  retractDelete(id: string): boolean {
    const element = this.elementMap(id);
    const deletes = this.subMap<Tombstone>(element, ELEMENT_DELETE);
    if (deletes.has(this.actorId)) {
      deletes.delete(this.actorId);
      this.touch(element, this.clock());
    }
    return deletes.size === 0;
  }

  /**
   * Replaces a text's `originalText` with `next` as ONE splice (W0 diffText).
   * Clearing the text is an *implicit* delete: no tombstone (R4).
   */
  editText(
    id: string,
    next: string,
    options: { caretAfter?: number; base?: string } = {},
  ): Splice | null {
    const text = this.texts.get(id);
    if (!text) {
      throw new VaultSchemaError(`element ${id} has no text`);
    }
    const splice = diffText(
      options.base ?? text.toString(),
      next,
      options.caretAfter,
    );
    if (isNoop(splice)) {
      return null;
    }
    this.applySplice(id, splice);
    return splice;
  }

  /** bumps this actor's clock on an element (version stamp / observed clocks) */
  touchElement(id: string) {
    this.touch(this.elementMap(id), this.clock());
  }

  /** applies a splice to the element's Y.Text and bumps its clock */
  applySplice(id: string, splice: Splice) {
    const text = this.texts.get(id);
    if (!text) {
      throw new VaultSchemaError(`element ${id} has no text`);
    }
    if (splice.deleteCount > 0) {
      text.delete(splice.index, splice.deleteCount);
    }
    if (splice.insert.length > 0) {
      text.insert(splice.index, splice.insert);
    }
    this.touch(this.elementMap(id), this.clock());
  }

  writeAppState(key: ConvergedAppStateKey, value: unknown) {
    if (!(CONVERGED_APP_STATE_KEYS as readonly string[]).includes(key)) {
      throw new VaultSchemaError(`appState key ${key} does not converge`);
    }
    this.writeRegister(this.appState, key, value, this.clock(), 0);
  }

  /**
   * marks a brand-new document (first writer only); a migration also records
   * its source and run id, so a resumed run can recognise its own snapshot
   */
  initMeta(
    createdBy: "new" | "migration",
    migration?: { sourceVaultId: string; migrationId: string },
  ) {
    if (this.meta.has("schemaVersion")) {
      return;
    }
    this.meta.set("schemaVersion", VAULT_SCENE_SCHEMA_VERSION);
    this.meta.set("createdBy", createdBy);
    if (migration) {
      this.meta.set("sourceVaultId", migration.sourceVaultId);
      this.meta.set("migrationId", migration.migrationId);
    }
  }

  /** throws if the document was written by a newer/unknown schema (fail-closed) */
  assertSchema() {
    const version = this.meta.get("schemaVersion");
    if (version !== undefined && version !== VAULT_SCENE_SCHEMA_VERSION) {
      throw new VaultSchemaError(
        `unsupported scene schemaVersion ${String(version)}`,
      );
    }
  }

  encodeStateVector(): Uint8Array {
    return Y.encodeStateVector(this.doc);
  }

  encodeStateAsUpdate(stateVector?: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc, stateVector);
  }
}
