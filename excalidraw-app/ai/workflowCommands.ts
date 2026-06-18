import { DEFAULT_SIDEBAR } from "@excalidraw/common";

import {
  brainIcon,
  clipboard,
  MagicIcon,
  messageCircleIcon,
  presentationIcon,
  settingsIcon,
  share,
  usersIcon,
} from "@excalidraw/excalidraw/components/icons";
import { getSelectedElements } from "@excalidraw/element";

import type { CommandPaletteItem } from "@excalidraw/excalidraw/components/CommandPalette/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { createAIOpenSettingsEvent } from "./workflowEvents";

import type { AIGenerationLogEntry, AISkill, PromptTemplate } from "./types";
import type { AISettingsTab } from "./workflowEvents";

export const truncateCommandText = (value: string, maxLength = 72) => {
  const normalized = value.replace(/\s+/g, " ").trim();

  return normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(0, maxLength - 3))}...`
    : normalized;
};

export const formatGenerationLogCommandLabel = (log: AIGenerationLogEntry) => {
  const summary = log.response.summary || log.prompt;
  const model = log.model.siteName || log.model.name;

  return truncateCommandText(
    `${log.mediaType} ${log.mode} - ${model} - ${summary}`,
  );
};

const openSidebarTab = (
  excalidrawAPI: ExcalidrawImperativeAPI | null,
  tab: string,
) => {
  excalidrawAPI?.toggleSidebar({
    name: DEFAULT_SIDEBAR.name,
    tab,
    force: true,
  });
};

type CoreAIWorkflowCommandOptions = {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  onAddSelectionAsReference?: () => void;
};

type AIWorkflowCommandOptions =
  | CoreAIWorkflowCommandOptions
  | ExcalidrawImperativeAPI
  | null;

const normalizeCoreAIWorkflowCommandOptions = (
  options: AIWorkflowCommandOptions,
): CoreAIWorkflowCommandOptions => {
  return options && "excalidrawAPI" in options
    ? options
    : { excalidrawAPI: options };
};

export const createCoreAIWorkflowCommands = (
  options: AIWorkflowCommandOptions,
): CommandPaletteItem[] => {
  const { excalidrawAPI, onAddSelectionAsReference } =
    normalizeCoreAIWorkflowCommandOptions(options);

  return [
    {
      label: "AI: Create",
      category: "AI",
      order: 0,
      keywords: [
        "ai",
        "generate",
        "image",
        "video",
        "audio",
        "reference",
        "inpaint",
        "workbench",
      ],
      icon: MagicIcon,
      perform: () => {
        openSidebarTab(excalidrawAPI, "ai-image");
      },
    },
    {
      label: "AI: Add selection as reference",
      category: "AI",
      order: 0,
      keywords: ["ai", "reference", "selection", "canvas", "context", "image"],
      icon: MagicIcon,
      predicate: (elements, appState) =>
        getSelectedElements(elements, appState).length > 0,
      perform: () => {
        onAddSelectionAsReference?.();
      },
    },
    {
      label: "AI: Assistant",
      category: "AI",
      order: 0,
      keywords: ["ai", "assistant", "agent", "skills", "chat"],
      icon: brainIcon,
      perform: () => {
        openSidebarTab(excalidrawAPI, "ai-assistant");
      },
    },
    {
      label: "AI: Generation history",
      category: "AI",
      order: 0,
      keywords: ["ai", "history", "logs", "recent", "reuse", "retry"],
      icon: clipboard,
      perform: () => {
        openSidebarTab(excalidrawAPI, "ai-generation-logs");
      },
    },
  ];
};

export const createAIPromptTemplateCommands = ({
  excalidrawAPI,
  templates,
  onApplyPromptTemplate,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  templates: PromptTemplate[];
  onApplyPromptTemplate?: (template: PromptTemplate) => void;
}): CommandPaletteItem[] =>
  templates.map((template) => ({
    label: `Template: ${template.label}`,
    category: "AI Templates",
    order: 1,
    keywords: [
      "ai",
      "prompt",
      "template",
      template.category || "custom",
      template.language || "multi",
      ...template.modes,
      template.template,
    ],
    icon: MagicIcon,
    perform: () => {
      if (onApplyPromptTemplate) {
        onApplyPromptTemplate(template);
        return;
      }

      openSidebarTab(excalidrawAPI, "ai-image");
    },
  }));

export const createAISkillCommands = ({
  excalidrawAPI,
  skills,
  onApplySkill,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  skills: AISkill[];
  onApplySkill?: (skill: AISkill) => void;
}): CommandPaletteItem[] =>
  skills.map((skill) => ({
    label: `Skill: ${skill.name}`,
    category: "AI Skills",
    order: 1,
    keywords: [
      "ai",
      "assistant",
      "agent",
      "skill",
      skill.name,
      skill.description,
      skill.initialPrompt || "",
      ...(skill.triggers || []),
    ],
    icon: brainIcon,
    perform: () => {
      if (onApplySkill) {
        onApplySkill(skill);
        return;
      }

      openSidebarTab(excalidrawAPI, "ai-assistant");
    },
  }));

export const createAIGenerationLogCommands = ({
  excalidrawAPI,
  logs,
  onReuseGenerationLog,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  logs: AIGenerationLogEntry[];
  onReuseGenerationLog?: (log: AIGenerationLogEntry) => void;
}): CommandPaletteItem[] =>
  logs.slice(0, 8).map((log) => ({
    label: `Reuse: ${formatGenerationLogCommandLabel(log)}`,
    category: "AI History",
    order: 2,
    keywords: [
      "ai",
      "history",
      "log",
      "reuse",
      "retry",
      log.mediaType,
      log.mode,
      log.status,
      log.model.name,
      log.model.siteName,
      log.prompt,
      log.response.summary,
    ],
    icon: clipboard,
    perform: () => {
      if (onReuseGenerationLog) {
        onReuseGenerationLog(log);
        return;
      }

      openSidebarTab(excalidrawAPI, "ai-image");
    },
  }));

const AI_SETTINGS_COMMAND_ENTRIES: Array<{
  label: string;
  keywords: string[];
  tab: AISettingsTab;
}> = [
  {
    label: "AI Settings: Models",
    keywords: ["ai", "settings", "models", "providers", "endpoint"],
    tab: "models",
  },
  {
    label: "AI Settings: Agents",
    keywords: ["ai", "settings", "agents", "skills", "assistant"],
    tab: "agents",
  },
  {
    label: "AI Settings: Prompt templates",
    keywords: ["ai", "settings", "prompt", "templates"],
    tab: "templates",
  },
];

export const createAISettingsCommands = (): CommandPaletteItem[] =>
  AI_SETTINGS_COMMAND_ENTRIES.map(
    (entry): CommandPaletteItem => ({
      label: entry.label,
      category: "AI Settings",
      order: 3,
      keywords: entry.keywords,
      icon: settingsIcon,
      perform: () => {
        window.dispatchEvent(createAIOpenSettingsEvent({ tab: entry.tab }));
      },
    }),
  );

type OfficeWorkflowCommandOptions = {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  onOpenCollaboration?: () => void;
  onOpenShare?: () => void;
  isCollaborationEnabled?: () => boolean;
};

export const createOfficeWorkflowCommands = (
  options: OfficeWorkflowCommandOptions | ExcalidrawImperativeAPI | null,
): CommandPaletteItem[] => {
  const commandOptions =
    options && "excalidrawAPI" in options
      ? options
      : { excalidrawAPI: options };
  const {
    excalidrawAPI,
    onOpenCollaboration,
    onOpenShare,
    isCollaborationEnabled,
  } = commandOptions;
  const commands: CommandPaletteItem[] = [
    {
      label: "Office: Comments",
      category: "Office",
      order: 4,
      keywords: ["comments", "review", "feedback", "team", "office"],
      icon: messageCircleIcon,
      perform: () => {
        openSidebarTab(excalidrawAPI, "comments");
      },
    },
  ];

  if (onOpenCollaboration) {
    commands.push({
      label: "Office: Live collaboration",
      category: "Office",
      order: 4,
      keywords: [
        "collaboration",
        "live",
        "team",
        "meeting",
        "review",
        "invite",
        "office",
      ],
      icon: usersIcon,
      predicate: isCollaborationEnabled,
      perform: onOpenCollaboration,
    });
  }

  if (onOpenShare) {
    commands.push({
      label: "Office: Share",
      category: "Office",
      order: 4,
      keywords: [
        "share",
        "link",
        "review",
        "export",
        "publish",
        "snapshot",
        "url",
        "collaborate",
        "invite",
        "office",
      ],
      icon: share,
      perform: onOpenShare,
    });
  }

  commands.push({
    label: "Office: Presentation",
    category: "Office",
    order: 4,
    keywords: ["present", "presentation", "slides", "office"],
    icon: presentationIcon,
    perform: () => {
      openSidebarTab(excalidrawAPI, "presentation");
    },
  });

  return commands;
};
