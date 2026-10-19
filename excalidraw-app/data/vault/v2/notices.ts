/**
 * Vault v2 (P4c) W6 notices: what the App tells the user about merges.
 *
 * - concurrent edits (decision 2a-2, ADR 0030 §2.6): an element with a
 *   register conflict is listed (the status pill can select it) and a one-off
 *   toast says the newer value was kept. Character-level text merges are not
 *   conflicts (no loser), so they never show here.
 * - tombstone-wins (decision 2d-1, ADR 0030 §2.5): when someone deleted an
 *   element that this session edited after the deleter's view of it, the edit
 *   is recorded but not shown; a one-off toast says so.
 *
 * Conflicts already present when the Vault finishes its first sync are taken
 * as known: reopening a Vault never replays old toasts.
 */
import type { VaultMaterializeReport } from "./materialize";
import type { VaultSceneDoc } from "./sceneDoc";

export type VaultV2Notice =
  | { kind: "conflict"; elementIds: readonly string[] }
  | { kind: "deletedEdits"; elementIds: readonly string[] };

const conflictKey = (conflict: VaultMaterializeReport["conflicts"][number]) =>
  `${conflict.elementId}\0${conflict.field}\0${conflict.winner.actorId}\0${conflict.winner.clock}`;

/** true when another actor's tombstone did not see this actor's last edit */
export const hasDeletedLocalEdit = (scene: VaultSceneDoc, id: string) => {
  const tombstones = scene.readTombstones(id);
  if (tombstones.size === 0) {
    return false;
  }
  const own = scene.readClocks(id)[scene.actorId];
  if (own === undefined) {
    return false;
  }
  let observed = 0;
  for (const tombstone of tombstones.values()) {
    observed = Math.max(observed, tombstone.o[scene.actorId] ?? 0);
  }
  return own > observed;
};

export class VaultV2NoticeTracker {
  private readonly seenConflicts = new Set<string>();
  private readonly seenDeleted = new Set<string>();
  private armed = false;
  private conflictIds: readonly string[] = [];

  constructor(private readonly scene: VaultSceneDoc) {}

  /** elements that currently hold a concurrent loser */
  get conflictElementIds(): readonly string[] {
    return this.conflictIds;
  }

  /**
   * Call after every materialize. Until `arm()` (first sync done) it only
   * records what exists; afterwards it returns the new notices.
   */
  update(
    report: VaultMaterializeReport,
    changedIds: Iterable<string>,
  ): VaultV2Notice[] {
    const ids = new Set<string>();
    const fresh = new Set<string>();
    for (const conflict of report.conflicts) {
      ids.add(conflict.elementId);
      const key = conflictKey(conflict);
      if (!this.seenConflicts.has(key)) {
        this.seenConflicts.add(key);
        fresh.add(conflict.elementId);
      }
    }
    this.conflictIds = [...ids].sort();

    const deleted: string[] = [];
    for (const id of changedIds) {
      if (!this.seenDeleted.has(id) && hasDeletedLocalEdit(this.scene, id)) {
        this.seenDeleted.add(id);
        deleted.push(id);
      }
    }

    if (!this.armed) {
      return [];
    }
    const notices: VaultV2Notice[] = [];
    if (fresh.size > 0) {
      notices.push({ kind: "conflict", elementIds: [...fresh].sort() });
    }
    if (deleted.length > 0) {
      notices.push({ kind: "deletedEdits", elementIds: deleted.sort() });
    }
    return notices;
  }

  /** after the first sync: from now on new conflicts/deletes are announced */
  arm() {
    this.armed = true;
  }
}
