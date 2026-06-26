import type {
  SceneActivityCreateInput,
  SceneActivityOperation,
  SceneActivityRecord,
} from "../types";

export interface SceneActivityRow {
  id: string;
  owner_id: string;
  scene_id: string;
  element_id: string | null;
  actor_id: string;
  op_type: string;
  summary: string | null;
  created_at: string;
}

const OPERATIONS = new Set<SceneActivityOperation>([
  "create",
  "update",
  "delete",
  "bind",
  "status-change",
  "tone-change",
]);

const toEpochMs = (value: string | null): number => {
  if (!value) {
    return 0;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
};

const toOperation = (value: string): SceneActivityOperation =>
  OPERATIONS.has(value as SceneActivityOperation)
    ? (value as SceneActivityOperation)
    : "update";

export const rowToSceneActivityRecord = (
  row: SceneActivityRow,
): SceneActivityRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  sceneId: row.scene_id,
  elementId: row.element_id,
  actorId: row.actor_id,
  operation: toOperation(row.op_type),
  summary: row.summary,
  createdAt: toEpochMs(row.created_at),
});

export const sceneActivityToInsert = (
  input: SceneActivityCreateInput,
  ownerId: string,
): Omit<SceneActivityRow, "id" | "created_at"> => ({
  owner_id: ownerId,
  scene_id: input.sceneId,
  element_id: input.elementId,
  actor_id: input.actorId,
  op_type: input.operation,
  summary: input.summary,
});
