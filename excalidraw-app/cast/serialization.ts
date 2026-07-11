import { CAST_SCRIPT_VERSION, type CastScriptV1 } from "./types";

export class UnsupportedCastVersionError extends Error {}
export class InvalidCastScriptError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isNonNegativeNumber = (value: unknown): value is number =>
  isFiniteNumber(value) && value >= 0;

const isElementArray = (
  value: unknown,
): value is Array<Record<string, unknown>> =>
  Array.isArray(value) &&
  value.every((element) => isRecord(element) && typeof element.id === "string");

const isFiles = (value: unknown) =>
  isRecord(value) &&
  Object.values(value).every(
    (file) =>
      isRecord(file) &&
      typeof file.id === "string" &&
      typeof file.dataURL === "string",
  );

const hasSafeAppState = (value: unknown) => {
  if (!isRecord(value)) {
    return false;
  }
  if ("luminaGameMode" in value || "exportIncludeGameEffects" in value) {
    return false;
  }
  return (
    isFiniteNumber(value.scrollX) &&
    isFiniteNumber(value.scrollY) &&
    isFiniteNumber(value.zoom) &&
    value.zoom > 0
  );
};

const hasNoLuminaGameData = (elements: unknown) =>
  isElementArray(elements) &&
  elements.every(
    (element) =>
      !isRecord(element.customData) || !("luminaGame" in element.customData),
  );

const isPointer = (value: unknown) =>
  isRecord(value) &&
  isFiniteNumber(value.x) &&
  isFiniteNumber(value.y) &&
  typeof value.visible === "boolean";

const assertEvent = (
  event: unknown,
  previousAt: number,
  durationMs: number,
) => {
  if (
    !isRecord(event) ||
    !isNonNegativeNumber(event.at) ||
    event.at < previousAt ||
    event.at > durationMs
  ) {
    throw new InvalidCastScriptError("Invalid Cast event timeline");
  }
  switch (event.type) {
    case "scene":
      if (
        !hasNoLuminaGameData(event.changedElements) ||
        !Array.isArray(event.deletedElementIds) ||
        !event.deletedElementIds.every((id) => typeof id === "string") ||
        (event.addedFiles !== undefined && !isFiles(event.addedFiles)) ||
        (event.appState !== undefined && !isRecord(event.appState)) ||
        (isRecord(event.appState) &&
          ("luminaGameMode" in event.appState ||
            "exportIncludeGameEffects" in event.appState))
      ) {
        throw new InvalidCastScriptError("Invalid Cast scene event");
      }
      break;
    case "viewport":
      if (
        !isFiniteNumber(event.scrollX) ||
        !isFiniteNumber(event.scrollY) ||
        !isFiniteNumber(event.zoom) ||
        event.zoom <= 0
      ) {
        throw new InvalidCastScriptError("Invalid Cast viewport event");
      }
      break;
    case "pointer":
      if (!isPointer(event)) {
        throw new InvalidCastScriptError("Invalid Cast pointer event");
      }
      break;
    case "marker":
      if (event.label !== undefined && typeof event.label !== "string") {
        throw new InvalidCastScriptError("Invalid Cast marker event");
      }
      break;
    default:
      throw new InvalidCastScriptError("Unknown Cast event type");
  }
  return event.at;
};

const validate = (value: unknown): CastScriptV1 => {
  if (!isRecord(value)) {
    throw new InvalidCastScriptError("Invalid CastScript");
  }
  if (value.version !== CAST_SCRIPT_VERSION) {
    throw new UnsupportedCastVersionError(
      `Unsupported CastScript version: ${String(value.version)}`,
    );
  }
  if (
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    !isNonNegativeNumber(value.createdAt) ||
    !isNonNegativeNumber(value.durationMs) ||
    !isRecord(value.metadata) ||
    typeof value.metadata.appVersion !== "string" ||
    (value.metadata.locale !== undefined &&
      typeof value.metadata.locale !== "string") ||
    !isRecord(value.initial) ||
    !hasNoLuminaGameData(value.initial.elements) ||
    !hasSafeAppState(value.initial.appState) ||
    !isFiles(value.initial.files) ||
    !Array.isArray(value.events) ||
    !Array.isArray(value.checkpoints)
  ) {
    throw new InvalidCastScriptError("Invalid CastScript v1 payload");
  }

  let previousEventAt = 0;
  for (const event of value.events) {
    previousEventAt = assertEvent(event, previousEventAt, value.durationMs);
  }

  let previousCheckpointAt = 0;
  for (const checkpoint of value.checkpoints) {
    if (
      !isRecord(checkpoint) ||
      !isNonNegativeNumber(checkpoint.at) ||
      checkpoint.at < previousCheckpointAt ||
      checkpoint.at > value.durationMs ||
      !Number.isInteger(checkpoint.eventIndex) ||
      (checkpoint.eventIndex as number) < 0 ||
      (checkpoint.eventIndex as number) > value.events.length ||
      !hasNoLuminaGameData(checkpoint.elements) ||
      !hasSafeAppState(checkpoint.appState) ||
      !isFiles(checkpoint.files) ||
      (checkpoint.pointer !== null && !isPointer(checkpoint.pointer))
    ) {
      throw new InvalidCastScriptError("Invalid Cast checkpoint");
    }
    previousCheckpointAt = checkpoint.at;
  }

  return value as unknown as CastScriptV1;
};

export const serializeCastScript = (script: CastScriptV1) =>
  JSON.stringify(validate(script));

export const deserializeCastScript = (serialized: string) =>
  validate(JSON.parse(serialized));
