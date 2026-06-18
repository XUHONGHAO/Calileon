import { DEFAULT_SIDEBAR } from "@excalidraw/common";
import { vi } from "vitest";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  createAIGenerationLogCommands,
  createAIPromptTemplateCommands,
  createAISkillCommands,
  createAISettingsCommands,
  createCoreAIWorkflowCommands,
  createOfficeWorkflowCommands,
  formatGenerationLogCommandLabel,
} from "./workflowCommands";
import { AI_OPEN_SETTINGS_EVENT } from "./workflowEvents";

import type {
  AIGenerationLogEntry,
  AIImageGenerationParams,
  AISkill,
  PromptTemplate,
} from "./types";

const baseParams = (): AIImageGenerationParams => ({
  size: "1024x1024",
  n: 1,
  seed: null,
  quality: "auto",
  style: "",
  referenceStrength: 0.6,
  duration: 5,
  fps: 24,
  resolution: "auto",
  aspectRatio: "auto",
  audioFormat: "mp3",
  voice: "",
});

const createAPI = () =>
  ({
    toggleSidebar: vi.fn(),
  } as unknown as ExcalidrawImperativeAPI);

const createTemplate = (
  overrides: Partial<PromptTemplate> = {},
): PromptTemplate => ({
  id: "template-1",
  label: "Storyboard",
  template: "Create a storyboard from {user_input}",
  category: "custom",
  modes: ["text-to-image"],
  createdAt: 0,
  isBuiltIn: false,
  ...overrides,
});

const createSkill = (overrides: Partial<AISkill> = {}): AISkill => ({
  id: "skill-1",
  name: "Storyboard Coach",
  icon: "AI",
  description: "Turn planning notes into visual storyboard prompts.",
  triggers: ["storyboard", "shot list"],
  agentId: "custom-agent-1",
  initialPrompt: "Help turn {user_input} into a storyboard.",
  ...overrides,
});

const createLog = (
  overrides: Partial<AIGenerationLogEntry> = {},
): AIGenerationLogEntry => ({
  id: "log-1",
  mediaType: "image",
  mode: "text-to-image",
  status: "success",
  model: {
    id: "model-1",
    name: "gpt-image-test",
    siteName: "Example",
  },
  prompt: "A compact product launch diagram",
  negativePrompt: "",
  params: baseParams(),
  request: {
    baseURL: "https://api.example.test",
    endpoint: "https://api.example.test/v1/images/generations",
  },
  response: {
    summary: "Generated a launch diagram",
    details: {
      outputCount: 1,
    },
  },
  submittedAt: "2026-06-18T00:00:00.000Z",
  completedAt: "2026-06-18T00:00:01.000Z",
  ...overrides,
});

describe("AI workflow command factories", () => {
  it("opens core AI workflow sidebar tabs", () => {
    const excalidrawAPI = createAPI();
    const commands = createCoreAIWorkflowCommands(excalidrawAPI);

    commands
      .find((command) => command.label === "AI: Create")
      ?.perform({} as Parameters<typeof commands[number]["perform"]>[0]);
    commands
      .find((command) => command.label === "AI: Assistant")
      ?.perform({} as Parameters<typeof commands[number]["perform"]>[0]);
    commands
      .find((command) => command.label === "AI: Generation history")
      ?.perform({} as Parameters<typeof commands[number]["perform"]>[0]);

    expect(excalidrawAPI.toggleSidebar).toHaveBeenNthCalledWith(1, {
      name: DEFAULT_SIDEBAR.name,
      tab: "ai-image",
      force: true,
    });
    expect(excalidrawAPI.toggleSidebar).toHaveBeenNthCalledWith(2, {
      name: DEFAULT_SIDEBAR.name,
      tab: "ai-assistant",
      force: true,
    });
    expect(excalidrawAPI.toggleSidebar).toHaveBeenNthCalledWith(3, {
      name: DEFAULT_SIDEBAR.name,
      tab: "ai-generation-logs",
      force: true,
    });
  });

  it("adds selected canvas content as an AI reference from commands", () => {
    const excalidrawAPI = createAPI();
    const onAddReference = vi.fn();
    const addSelectionCommand = createCoreAIWorkflowCommands({
      excalidrawAPI,
      onAddSelectionAsReference: onAddReference,
    }).find((command) => command.label === "AI: Add selection as reference");

    const predicate = addSelectionCommand?.predicate;
    expect(typeof predicate).toBe("function");
    expect(
      typeof predicate === "function" &&
        predicate(
          [{ id: "element-1" }] as any,
          { selectedElementIds: {} } as any,
          {} as any,
          {} as any,
        ),
    ).toBe(false);
    expect(
      typeof predicate === "function" &&
        predicate(
          [{ id: "element-1" }] as any,
          { selectedElementIds: { "element-1": true } } as any,
          {} as any,
          {} as any,
        ),
    ).toBe(true);

    addSelectionCommand?.perform(
      {} as Parameters<NonNullable<typeof addSelectionCommand>["perform"]>[0],
    );
    expect(onAddReference).toHaveBeenCalledTimes(1);
    expect(excalidrawAPI.toggleSidebar).not.toHaveBeenCalled();
  });

  it("opens the AI create tab and hands off prompt templates", () => {
    const excalidrawAPI = createAPI();
    const template = createTemplate();
    const onTemplate = vi.fn();

    const [command] = createAIPromptTemplateCommands({
      excalidrawAPI,
      templates: [template],
      onApplyPromptTemplate: onTemplate,
    });

    command.perform({} as Parameters<typeof command.perform>[0]);
    expect(onTemplate).toHaveBeenCalledWith(template);
    expect(excalidrawAPI.toggleSidebar).not.toHaveBeenCalled();
  });

  it("opens the AI assistant tab and hands off skills", () => {
    const excalidrawAPI = createAPI();
    const skill = createSkill();
    const onSkill = vi.fn();

    const [command] = createAISkillCommands({
      excalidrawAPI,
      skills: [skill],
      onApplySkill: onSkill,
    });

    expect(command).toMatchObject({
      label: "Skill: Storyboard Coach",
      category: "AI Skills",
    });
    expect(command.keywords).toEqual(
      expect.arrayContaining(["assistant", "skill", "storyboard"]),
    );

    command.perform({} as Parameters<typeof command.perform>[0]);

    expect(onSkill).toHaveBeenCalledWith(skill);
    expect(excalidrawAPI.toggleSidebar).not.toHaveBeenCalled();
  });

  it("limits history commands and hands off generation log reuse", () => {
    const excalidrawAPI = createAPI();
    const logs = Array.from({ length: 9 }, (_, index) =>
      createLog({ id: `log-${index}` }),
    );
    const onReuse = vi.fn();

    const commands = createAIGenerationLogCommands({
      excalidrawAPI,
      logs,
      onReuseGenerationLog: onReuse,
    });

    expect(commands).toHaveLength(8);
    commands[0].perform({} as Parameters<typeof commands[0]["perform"]>[0]);
    expect(onReuse).toHaveBeenCalledWith(logs[0]);
    expect(excalidrawAPI.toggleSidebar).not.toHaveBeenCalled();
  });

  it("dispatches AI settings tab commands", () => {
    const onOpenSettings = vi.fn();
    window.addEventListener(AI_OPEN_SETTINGS_EVENT, onOpenSettings);

    const templatesCommand = createAISettingsCommands().find(
      (command) => command.label === "AI Settings: Prompt templates",
    );

    templatesCommand?.perform(
      {} as Parameters<NonNullable<typeof templatesCommand>["perform"]>[0],
    );
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect((onOpenSettings.mock.calls[0][0] as CustomEvent).detail).toEqual({
      tab: "templates",
    });

    window.removeEventListener(AI_OPEN_SETTINGS_EVENT, onOpenSettings);
  });

  it("opens office workflow sidebar tabs", () => {
    const excalidrawAPI = createAPI();
    const [commentsCommand, presentationCommand] =
      createOfficeWorkflowCommands(excalidrawAPI);

    commentsCommand.perform(
      {} as Parameters<typeof commentsCommand.perform>[0],
    );
    presentationCommand.perform(
      {} as Parameters<typeof presentationCommand.perform>[0],
    );

    expect(excalidrawAPI.toggleSidebar).toHaveBeenNthCalledWith(1, {
      name: DEFAULT_SIDEBAR.name,
      tab: "comments",
      force: true,
    });
    expect(excalidrawAPI.toggleSidebar).toHaveBeenNthCalledWith(2, {
      name: DEFAULT_SIDEBAR.name,
      tab: "presentation",
      force: true,
    });
  });

  it("exposes collaboration and share as office workflow commands", () => {
    const excalidrawAPI = createAPI();
    const onOpenCollaboration = vi.fn();
    const onOpenShare = vi.fn();
    const commands = createOfficeWorkflowCommands({
      excalidrawAPI,
      onOpenCollaboration,
      onOpenShare,
      isCollaborationEnabled: () => true,
    });

    expect(commands.map((command) => command.label)).toEqual([
      "Office: Comments",
      "Office: Live collaboration",
      "Office: Share",
      "Office: Presentation",
    ]);
    expect(commands.every((command) => command.category === "Office")).toBe(
      true,
    );
    expect(
      commands.find((command) => command.label === "Office: Share")?.keywords,
    ).toEqual(expect.arrayContaining(["share", "review", "export", "office"]));

    const collaborationCommand = commands.find(
      (command) => command.label === "Office: Live collaboration",
    );
    expect(
      typeof collaborationCommand?.predicate === "function" &&
        collaborationCommand.predicate([], {} as any, {} as any, {} as any),
    ).toBe(true);

    collaborationCommand?.perform(
      {} as Parameters<NonNullable<typeof collaborationCommand>["perform"]>[0],
    );
    commands
      .find((command) => command.label === "Office: Share")
      ?.perform({} as Parameters<typeof commands[number]["perform"]>[0]);

    expect(onOpenCollaboration).toHaveBeenCalledTimes(1);
    expect(onOpenShare).toHaveBeenCalledTimes(1);
  });

  it("keeps generation log labels compact", () => {
    const label = formatGenerationLogCommandLabel(
      createLog({
        response: {
          summary:
            "A very long generated summary that should be compact enough for the command palette row",
          details: {
            outputCount: 1,
          },
        },
      }),
    );

    expect(label).toHaveLength(72);
    expect(label.endsWith("...")).toBe(true);
  });
});
