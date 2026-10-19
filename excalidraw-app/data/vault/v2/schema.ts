/**
 * Vault v2 (P4c) converged-document schema. ADR 0030 §1–§2, W1 design §3.
 *
 * Which element fields enter the CRDT document, per element type. Anything not
 * listed is either derived at materialization (ADR 0030 §2.3 R1, §2.7, §2.8)
 * or local-only. Unknown element types are rejected (fail-closed), never
 * silently dropped.
 */

export const VAULT_SCENE_SCHEMA_VERSION = 2;

/** Y.Doc root keys */
export const ROOT_ELEMENTS = "elements";
export const ROOT_TEXTS = "texts";
export const ROOT_APP_STATE = "appState";
export const ROOT_META = "meta";

/** keys inside one element map (W1 §3, ADR 0030 R6: flat, created with the element) */
export const ELEMENT_FIELDS = "__fields";
export const ELEMENT_CLOCKS = "__clocks";
export const ELEMENT_DELETE = "__delete";

/** separator of the flat register key `field + SEP + actorId` (R6) */
export const REGISTER_KEY_SEPARATOR = "\u0000";

const BASE_FIELDS = [
  "type",
  "x",
  "y",
  "width",
  "height",
  "angle",
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "roundness",
  "seed",
  "groupIds",
  "frameId",
  "index",
  "link",
  "locked",
  "updated",
  "created",
  "customData",
] as const;

const TEXT_FIELDS = [
  "fontSize",
  "fontFamily",
  "textAlign",
  "verticalAlign",
  "containerId",
  "lineHeight",
  "autoResize",
] as const;

const LINEAR_FIELDS = [
  "points",
  "startBinding",
  "endBinding",
  "startArrowhead",
  "endArrowhead",
] as const;

const FIELDS_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
  rectangle: BASE_FIELDS,
  diamond: BASE_FIELDS,
  ellipse: BASE_FIELDS,
  embeddable: BASE_FIELDS,
  iframe: BASE_FIELDS,
  frame: [...BASE_FIELDS, "name"],
  magicframe: [...BASE_FIELDS, "name"],
  text: [...BASE_FIELDS, ...TEXT_FIELDS],
  line: [...BASE_FIELDS, ...LINEAR_FIELDS, "polygon"],
  arrow: [
    ...BASE_FIELDS,
    ...LINEAR_FIELDS,
    "elbowed",
    "fixedSegments",
    "startIsSpecial",
    "endIsSpecial",
  ],
  freedraw: [...BASE_FIELDS, "points", "pressures", "simulatePressure"],
  image: [...BASE_FIELDS, "fileId", "status", "scale", "crop"],
};

/**
 * Derived for every text element (R1). For *bound* text `width`/`height`/`x`/`y`
 * are derived too; for free text they stay registers (they carry the user's
 * placement and, with `autoResize: false`, the wrap width).
 */
export const DERIVED_TEXT_FIELDS = ["text", "originalText"] as const;
export const DERIVED_BOUND_TEXT_FIELDS = ["x", "y", "width", "height"] as const;

/** never stored: identity, local version stamp (R7), derived bindings (S10) */
export const NEVER_STORED_FIELDS = new Set([
  "id",
  "version",
  "versionNonce",
  "boundElements",
  "isDeleted",
]);

/** the 5 `server: true` appState keys (ADR 0030 §1) */
export const CONVERGED_APP_STATE_KEYS = [
  "gridSize",
  "gridStep",
  "gridModeEnabled",
  "viewBackgroundColor",
  "lockedMultiSelections",
] as const;
export type ConvergedAppStateKey = typeof CONVERGED_APP_STATE_KEYS[number];

export const isSupportedElementType = (type: unknown): type is string =>
  typeof type === "string" && Object.hasOwn(FIELDS_BY_TYPE, type);

/** register fields of one element type; throws on unknown types (fail-closed) */
export const registerFieldsForType = (type: string): readonly string[] => {
  const fields = FIELDS_BY_TYPE[type];
  if (!fields) {
    throw new VaultSchemaError(`unsupported element type: ${type}`);
  }
  return fields;
};

/** whether `field` is stored as a register for this element */
export const isRegisterField = (
  type: string,
  field: string,
  isBoundText: boolean,
): boolean => {
  if (NEVER_STORED_FIELDS.has(field)) {
    return false;
  }
  if (type === "text") {
    if ((DERIVED_TEXT_FIELDS as readonly string[]).includes(field)) {
      return false;
    }
    if (
      isBoundText &&
      (DERIVED_BOUND_TEXT_FIELDS as readonly string[]).includes(field)
    ) {
      return false;
    }
  }
  return registerFieldsForType(type).includes(field);
};

export class VaultSchemaError extends Error {
  readonly code = "VAULT_SCENE_SCHEMA_INVALID";
}
