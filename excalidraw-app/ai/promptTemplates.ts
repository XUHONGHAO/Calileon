import type {
  AIImageGenerationMode,
  PromptTemplate,
  PromptTemplateCategory,
  PromptTemplateLanguage,
} from "./types";

export const AI_PROMPT_TEMPLATES_STORAGE_KEY = "ai-prompt-templates";
export const AI_PROMPT_TEMPLATES_UPDATED_EVENT = "ai-prompt-templates-updated";

const BUILT_IN_CREATED_AT = 1718380800000;

export const BUILT_IN_TEMPLATES: PromptTemplate[] = [
  {
    id: "text-photorealistic",
    label: "Photorealistic scene",
    template:
      "A photorealistic image of [subject], [lighting], highly detailed, 8k resolution",
    modes: ["text-to-image"],
    category: "composition",
    language: "en",
    createdAt: BUILT_IN_CREATED_AT,
    isBuiltIn: true,
  },
  {
    id: "text-artistic",
    label: "Artistic style",
    template:
      "[subject] in the style of [artist/style], [medium], vibrant colors",
    modes: ["text-to-image"],
    category: "style",
    language: "en",
    createdAt: BUILT_IN_CREATED_AT,
    isBuiltIn: true,
  },
  {
    id: "text-scene-zh",
    label: "场景描述",
    template: "一个[场景]，包含[主体]，[光线]，高清细节",
    modes: ["text-to-image"],
    category: "composition",
    language: "zh",
    createdAt: BUILT_IN_CREATED_AT,
    isBuiltIn: true,
  },
  {
    id: "ref-combine",
    label: "Combine elements",
    template:
      "Combine elements from #1 and #2, maintaining the composition of #1",
    modes: ["image-to-image"],
    category: "composition",
    language: "en",
    createdAt: BUILT_IN_CREATED_AT,
    isBuiltIn: true,
  },
  {
    id: "ref-style-transfer",
    label: "Style transfer",
    template:
      "Apply the style of #1 to the content of #2, keep the structure intact",
    modes: ["image-to-image"],
    category: "style",
    language: "en",
    createdAt: BUILT_IN_CREATED_AT,
    isBuiltIn: true,
  },
  {
    id: "ref-object-replace",
    label: "Object replacement",
    template: "Replace the [object] in #1 with the [object] from #2",
    modes: ["image-to-image"],
    category: "editing",
    language: "en",
    createdAt: BUILT_IN_CREATED_AT,
    isBuiltIn: true,
  },
  {
    id: "ref-combine-zh",
    label: "元素组合",
    template: "把图#1中的[物体]放到图#2的[位置]上",
    modes: ["image-to-image"],
    category: "composition",
    language: "zh",
    createdAt: BUILT_IN_CREATED_AT,
    isBuiltIn: true,
  },
  {
    id: "ref-style-zh",
    label: "风格迁移",
    template: "将图#1的风格应用到图#2的内容上，保持#2的构图",
    modes: ["image-to-image"],
    category: "style",
    language: "zh",
    createdAt: BUILT_IN_CREATED_AT,
    isBuiltIn: true,
  },
  {
    id: "inpaint-remove",
    label: "Remove object",
    template:
      "Remove the [object] from the image, fill with appropriate background",
    modes: ["inpaint"],
    category: "editing",
    language: "en",
    createdAt: BUILT_IN_CREATED_AT,
    isBuiltIn: true,
  },
  {
    id: "inpaint-replace",
    label: "Replace region",
    template:
      "Replace the masked region with [description], match the lighting and style",
    modes: ["inpaint"],
    category: "editing",
    language: "en",
    createdAt: BUILT_IN_CREATED_AT,
    isBuiltIn: true,
  },
  {
    id: "inpaint-enhance",
    label: "Enhance details",
    template:
      "Enhance the details in the masked region, improve quality and sharpness",
    modes: ["inpaint"],
    category: "editing",
    language: "en",
    createdAt: BUILT_IN_CREATED_AT,
    isBuiltIn: true,
  },
  {
    id: "inpaint-remove-zh",
    label: "移除对象",
    template: "移除图中的[对象]，用合适的背景填充",
    modes: ["inpaint"],
    category: "editing",
    language: "zh",
    createdAt: BUILT_IN_CREATED_AT,
    isBuiltIn: true,
  },
  {
    id: "inpaint-replace-zh",
    label: "替换区域",
    template: "将遮罩区域替换为[描述]，保持光线和风格一致",
    modes: ["inpaint"],
    category: "editing",
    language: "zh",
    createdAt: BUILT_IN_CREATED_AT,
    isBuiltIn: true,
  },
  {
    id: "universal-quality",
    label: "High quality boost",
    template:
      "[your description], highly detailed, professional photography, 8k, HDR",
    modes: ["text-to-image", "image-to-image", "inpaint"],
    category: "style",
    language: "en",
    createdAt: BUILT_IN_CREATED_AT,
    isBuiltIn: true,
  },
  {
    id: "universal-artistic",
    label: "Artistic enhancement",
    template:
      "[your description], artistic, trending on artstation, concept art",
    modes: ["text-to-image", "image-to-image", "inpaint"],
    category: "style",
    language: "en",
    createdAt: BUILT_IN_CREATED_AT,
    isBuiltIn: true,
  },
];

export const getPromptTemplatesForMode = (
  mode: AIImageGenerationMode,
): PromptTemplate[] => {
  return getAllPromptTemplates().filter((template) =>
    template.modes.includes(mode),
  );
};

export const getAllPromptTemplates = (): PromptTemplate[] => {
  return [...BUILT_IN_TEMPLATES, ...loadCustomPromptTemplates()];
};

export const loadCustomPromptTemplates = (): PromptTemplate[] => {
  try {
    if (typeof localStorage === "undefined") {
      return [];
    }

    const rawValue = localStorage.getItem(AI_PROMPT_TEMPLATES_STORAGE_KEY);

    if (!rawValue) {
      return [];
    }

    const parsed = JSON.parse(rawValue);
    const templates: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.templates)
      ? parsed.templates
      : [];

    return templates
      .map(normalizePromptTemplate)
      .filter((template): template is PromptTemplate => !!template);
  } catch (error) {
    console.error("Could not load AI prompt templates", error);
    return [];
  }
};

export const saveCustomPromptTemplates = (templates: PromptTemplate[]) => {
  const customTemplates = templates
    .filter((template) => !template.isBuiltIn)
    .map((template) => ({
      ...template,
      isBuiltIn: false,
    }));

  if (typeof localStorage !== "undefined") {
    localStorage.setItem(
      AI_PROMPT_TEMPLATES_STORAGE_KEY,
      JSON.stringify({ version: 1, templates: customTemplates }),
    );
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(AI_PROMPT_TEMPLATES_UPDATED_EVENT));
  }

  return customTemplates;
};

export const upsertCustomPromptTemplate = (
  template: Omit<PromptTemplate, "id" | "createdAt" | "isBuiltIn"> &
    Partial<Pick<PromptTemplate, "id" | "createdAt">>,
) => {
  const customTemplates = loadCustomPromptTemplates();
  const savedTemplate: PromptTemplate = {
    ...template,
    id: template.id || createPromptTemplateId(),
    createdAt: template.createdAt || Date.now(),
    isBuiltIn: false,
  };
  const nextTemplates = customTemplates.some(
    (item) => item.id === savedTemplate.id,
  )
    ? customTemplates.map((item) =>
        item.id === savedTemplate.id ? savedTemplate : item,
      )
    : [savedTemplate, ...customTemplates];

  saveCustomPromptTemplates(nextTemplates);

  return savedTemplate;
};

export const deleteCustomPromptTemplate = (templateId: string) => {
  const nextTemplates = loadCustomPromptTemplates().filter(
    (template) => template.id !== templateId,
  );

  saveCustomPromptTemplates(nextTemplates);
};

export const parsePromptTemplateImport = (text: string): PromptTemplate[] => {
  const parsed = JSON.parse(text);
  const templates: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.templates)
    ? parsed.templates
    : [];

  return templates
    .map(normalizePromptTemplate)
    .filter((template): template is PromptTemplate => !!template)
    .map((template) => ({
      ...template,
      id: template.id || createPromptTemplateId(),
      createdAt: template.createdAt || Date.now(),
      isBuiltIn: false,
    }));
};

export const serializePromptTemplates = (templates: PromptTemplate[]) => {
  return JSON.stringify(
    {
      version: 1,
      templates: templates.filter((template) => !template.isBuiltIn),
    },
    null,
    2,
  );
};

const normalizePromptTemplate = (value: unknown): PromptTemplate | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const label = readString(candidate.label).trim();
  const template = readString(candidate.template).trim();
  const modes = Array.isArray(candidate.modes)
    ? candidate.modes.filter(isAIImageGenerationMode)
    : [];

  if (!label || !template || !modes.length) {
    return null;
  }

  return {
    id: readString(candidate.id).trim() || createPromptTemplateId(),
    label,
    template,
    modes,
    category: isPromptTemplateCategory(candidate.category)
      ? candidate.category
      : "custom",
    language: isPromptTemplateLanguage(candidate.language)
      ? candidate.language
      : "multi",
    createdAt:
      typeof candidate.createdAt === "number"
        ? candidate.createdAt
        : Date.now(),
    isBuiltIn: candidate.isBuiltIn === true,
  };
};

const readString = (value: unknown) => (typeof value === "string" ? value : "");

const isAIImageGenerationMode = (
  value: unknown,
): value is AIImageGenerationMode => {
  return (
    value === "text-to-image" ||
    value === "image-to-image" ||
    value === "inpaint"
  );
};

const isPromptTemplateCategory = (
  value: unknown,
): value is PromptTemplateCategory => {
  return (
    value === "composition" ||
    value === "style" ||
    value === "editing" ||
    value === "custom"
  );
};

const isPromptTemplateLanguage = (
  value: unknown,
): value is PromptTemplateLanguage => {
  return value === "en" || value === "zh" || value === "multi";
};

const createPromptTemplateId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};
