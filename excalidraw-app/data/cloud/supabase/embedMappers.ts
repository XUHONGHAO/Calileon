import { normalizeEmbedOrigins } from "../embedOrigin";

import type {
  EmbedCreateInput,
  EmbedMode,
  EmbedRecord,
  EmbedSize,
  EmbedTheme,
  EmbedUpdateInput,
} from "../types";

export interface EmbedRow {
  id: string;
  owner_id: string;
  scene_id: string;
  mode: EmbedMode;
  token: string;
  allowed_origins: string[];
  theme: EmbedTheme;
  size: EmbedSize;
  revoked: boolean;
  created_at: string;
  updated_at: string;
}

export type EmbedInsertRow = Pick<
  EmbedRow,
  | "owner_id"
  | "scene_id"
  | "mode"
  | "token"
  | "allowed_origins"
  | "theme"
  | "size"
>;

export type EmbedUpdateRow = Partial<
  Pick<EmbedRow, "mode" | "allowed_origins" | "theme" | "size" | "revoked">
>;

const toEpochMs = (value: string | null): number => {
  if (!value) {
    return 0;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
};

const toEmbedMode = (value: string): EmbedMode =>
  value === "write" || value === "collab" ? value : "read";

const toEmbedTheme = (value: string): EmbedTheme =>
  value === "light" || value === "dark" ? value : "system";

const toEmbedSize = (value: string): EmbedSize =>
  value === "wide" || value === "compact" ? value : "responsive";

export const rowToEmbedRecord = (row: EmbedRow): EmbedRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  sceneId: row.scene_id,
  mode: toEmbedMode(row.mode),
  token: row.token,
  allowedOrigins: normalizeEmbedOrigins(row.allowed_origins ?? []),
  theme: toEmbedTheme(row.theme),
  size: toEmbedSize(row.size),
  revoked: row.revoked,
  createdAt: toEpochMs(row.created_at),
  updatedAt: toEpochMs(row.updated_at),
});

export const embedCreateToInsert = (
  input: EmbedCreateInput,
  ownerId: string,
  token: string,
): EmbedInsertRow => ({
  owner_id: ownerId,
  scene_id: input.sceneId,
  mode: input.mode,
  token,
  allowed_origins: normalizeEmbedOrigins(input.allowedOrigins),
  theme: input.theme ?? "system",
  size: input.size ?? "responsive",
});

export const embedUpdateToUpdate = (
  input: EmbedUpdateInput,
): EmbedUpdateRow => ({
  ...(input.mode !== undefined ? { mode: input.mode } : {}),
  ...(input.allowedOrigins !== undefined
    ? { allowed_origins: normalizeEmbedOrigins(input.allowedOrigins) }
    : {}),
  ...(input.theme !== undefined ? { theme: input.theme } : {}),
  ...(input.size !== undefined ? { size: input.size } : {}),
  ...(input.revoked !== undefined ? { revoked: input.revoked } : {}),
});
