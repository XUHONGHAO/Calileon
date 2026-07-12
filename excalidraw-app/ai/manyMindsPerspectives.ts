import { createManyMindsId, type ManyMindsPerspective } from "./manyMindsTypes";

const STORAGE_KEY = "excalidraw-many-minds-perspectives-v1";
const MAX_NAME_LENGTH = 80;
const MAX_PROMPT_LENGTH = 4000;

export const sanitizeManyMindsText = (value: string) =>
  stripControlCharacters(
    value
      .replace(
        /https?:\/\/[^\s"'<>]+[?&](?:x-amz-signature|x-goog-signature|signature|sig|token)=[^\s"'<>]+/gi,
        "[signed-url-redacted]",
      )
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
      .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/gi, "[redacted]")
      .replace(
        /\b(api[_ -]?key|authorization|access[_ -]?token)\s*[:=]\s*[^\s,;]+/gi,
        "$1=[redacted]",
      )
      .replace(
        /([?&](?:x-amz-signature|x-goog-signature|signature|sig|token)=)[^&#\s]+/gi,
        "$1[redacted]",
      )
      .trim(),
  );

const stripControlCharacters = (value: string) =>
  [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("");

const sanitizePerspectiveParams = (params: ManyMindsPerspective["params"]) =>
  params
    ? (Object.fromEntries(
        Object.entries(params).map(([key, value]) => [
          key,
          typeof value === "string" ? sanitizeManyMindsText(value) : value,
        ]),
      ) as unknown as ManyMindsPerspective["params"])
    : undefined;

const builtIn = (
  id: string,
  name: string,
  icon: string,
  prompt: string,
): ManyMindsPerspective => ({
  id,
  name,
  icon,
  prompt,
  isBuiltIn: true,
});

export const BUILTIN_MANY_MINDS_PERSPECTIVES: readonly ManyMindsPerspective[] =
  Object.freeze([
    builtIn(
      "clarify",
      "Clarify",
      "focus",
      "Clarify the visual hierarchy and make the main idea immediately legible.",
    ),
    builtIn(
      "simplify",
      "Simplify",
      "minus",
      "Remove nonessential detail while preserving the subject and intent.",
    ),
    builtIn(
      "expand",
      "Expand",
      "plus",
      "Explore a richer version with additional context and supporting detail.",
    ),
    builtIn(
      "reframe",
      "Reframe",
      "frame",
      "Reframe the composition from a meaningfully different viewpoint.",
    ),
    builtIn(
      "contrast",
      "Contrast",
      "contrast",
      "Strengthen separation, rhythm, and visual contrast without changing the subject.",
    ),
    builtIn(
      "atmosphere",
      "Atmosphere",
      "cloud",
      "Explore a distinct atmosphere through light, color, texture, and depth.",
    ),
    builtIn(
      "material",
      "Material",
      "layers",
      "Explore alternative materials and surface qualities appropriate to the subject.",
    ),
    builtIn(
      "narrative",
      "Narrative",
      "story",
      "Make the image imply a clearer moment, context, or visual story.",
    ),
  ]);

const sanitizePerspective = (
  perspective: ManyMindsPerspective,
): ManyMindsPerspective | null => {
  const name = sanitizeManyMindsText(perspective.name).slice(
    0,
    MAX_NAME_LENGTH,
  );
  const prompt = sanitizeManyMindsText(perspective.prompt).slice(
    0,
    MAX_PROMPT_LENGTH,
  );
  if (!name || !prompt || perspective.isBuiltIn) {
    return null;
  }
  return {
    id: perspective.id || createManyMindsId("many-minds-perspective"),
    name,
    icon: sanitizeManyMindsText(perspective.icon || "sparkles").slice(0, 40),
    prompt,
    recommendedModelId: perspective.recommendedModelId
      ? sanitizeManyMindsText(perspective.recommendedModelId).slice(0, 200)
      : undefined,
    params: sanitizePerspectiveParams(perspective.params),
    isBuiltIn: false,
    createdAt: perspective.createdAt || Date.now(),
    updatedAt: perspective.updatedAt || Date.now(),
  };
};

export const loadCustomManyMindsPerspectives = (
  storage: Pick<Storage, "getItem"> = localStorage,
): ManyMindsPerspective[] => {
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(value)
      ? value
          .map((entry) => sanitizePerspective(entry as ManyMindsPerspective))
          .filter((entry): entry is ManyMindsPerspective => !!entry)
      : [];
  } catch {
    return [];
  }
};

export const saveCustomManyMindsPerspectives = (
  perspectives: readonly ManyMindsPerspective[],
  storage: Pick<Storage, "setItem"> = localStorage,
) => {
  const sanitized = perspectives
    .map(sanitizePerspective)
    .filter((entry): entry is ManyMindsPerspective => !!entry);
  storage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
  return sanitized;
};

export const createCustomManyMindsPerspective = (
  input: Pick<ManyMindsPerspective, "name" | "prompt"> &
    Partial<
      Pick<ManyMindsPerspective, "icon" | "recommendedModelId" | "params">
    >,
  now = Date.now(),
) =>
  sanitizePerspective({
    id: createManyMindsId("many-minds-perspective"),
    name: input.name,
    icon: input.icon || "sparkles",
    prompt: input.prompt,
    recommendedModelId: input.recommendedModelId,
    params: input.params,
    isBuiltIn: false,
    createdAt: now,
    updatedAt: now,
  });

export const deleteCustomManyMindsPerspective = (
  perspectiveId: string,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
) => {
  const next = loadCustomManyMindsPerspectives(storage).filter(
    (perspective) => perspective.id !== perspectiveId,
  );
  saveCustomManyMindsPerspectives(next, storage);
  return next;
};
