import { DEFAULT_SIDEBAR } from "@excalidraw/common";
import { DefaultSidebar, Sidebar } from "@excalidraw/excalidraw";
import {
  clipboard,
  brainIcon,
  messageCircleIcon,
  MagicIcon,
  presentationIcon,
  settingsIcon,
  sidebarRightIcon,
} from "@excalidraw/excalidraw/components/icons";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawFreeDrawElement } from "@excalidraw/element/types";

import { createAIOpenSettingsEvent } from "../ai/workflowEvents";
import { useSetAtom } from "../app-jotai";
import { shareDialogStateAtom } from "../share/ShareDialog";

import {
  AIImageWorkbench,
  createInitialAIImageWorkbenchDraftState,
} from "./AIImageWorkbench";
import {
  applyPromptTemplateToWorkbenchDraft,
  reuseGenerationLogInWorkbenchDraft,
  sendPromptToWorkbenchDraft,
} from "./AIImageWorkbenchDraft";
import { AIGenerationLogPanel } from "./AIGenerationLogPanel";
import { AppSidebarOfficePanel } from "./AppSidebarOfficePanel";
import { CustomAgentChat } from "./CustomAgentChat/CustomAgentChat";

import "./AppSidebar.scss";

import type { AIImageWorkbenchDraftState } from "./AIImageWorkbench";
import type {
  AIGenerationLogEntry,
  AIMaskReadyPayload,
  AISkill,
  PromptTemplate,
} from "../ai/types";

export type AIReferenceAddRequest = {
  id: number;
};

export type AssistantSkillRequest = {
  id: number;
  skill: AISkill;
};

export type PromptTemplateRequest = {
  id: number;
  template: PromptTemplate;
};

export type GenerationLogReuseRequest = {
  id: number;
  log: AIGenerationLogEntry;
};

type AppSidebarProps = {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  referenceAddRequest?: AIReferenceAddRequest | null;
  assistantSkillRequest?: AssistantSkillRequest | null;
  promptTemplateRequest?: PromptTemplateRequest | null;
  generationLogReuseRequest?: GenerationLogReuseRequest | null;
  onAddSelectionAsReference?: () => void;
  onEnterMaskEditing?: (
    imageId: string,
    maskElements?: readonly ExcalidrawFreeDrawElement[],
  ) => void;
  onMaskReady?: (
    handler: ((payload: AIMaskReadyPayload) => void) | null,
  ) => void;
};

type AssistantIncomingPrompt = {
  id: number;
  prompt: string;
};

export const AppSidebar = memo(
  ({
    excalidrawAPI,
    referenceAddRequest,
    assistantSkillRequest,
    promptTemplateRequest,
    generationLogReuseRequest,
    onAddSelectionAsReference,
    onEnterMaskEditing,
    onMaskReady,
  }: AppSidebarProps) => {
    const [workbenchDraftState, setWorkbenchDraftState] =
      useState<AIImageWorkbenchDraftState>(
        createInitialAIImageWorkbenchDraftState,
      );
    const [assistantIncomingPrompt, setAssistantIncomingPrompt] =
      useState<AssistantIncomingPrompt | null>(null);
    const nextAssistantPromptRequestIdRef = useRef(0);
    const lastPromptTemplateRequestIdRef = useRef<number | null>(null);
    const lastGenerationLogReuseRequestIdRef = useRef<number | null>(null);
    const setShareDialogState = useSetAtom(shareDialogStateAtom);
    const sendPromptToWorkbench = useCallback((prompt: string) => {
      setWorkbenchDraftState((current) =>
        sendPromptToWorkbenchDraft(current, prompt),
      );
    }, []);
    const sendPromptToAssistant = useCallback(
      (prompt: string) => {
        setAssistantIncomingPrompt({
          id: ++nextAssistantPromptRequestIdRef.current,
          prompt,
        });
        excalidrawAPI?.toggleSidebar({
          name: DEFAULT_SIDEBAR.name,
          tab: "ai-assistant",
          force: true,
        });
        excalidrawAPI?.setToast({
          message: "Prompt loaded in AI Assistant.",
          duration: 3000,
        });
      },
      [excalidrawAPI],
    );
    const applyPromptTemplateToWorkbench = useCallback(
      (template: PromptTemplate) => {
        setWorkbenchDraftState((current) =>
          applyPromptTemplateToWorkbenchDraft(current, template),
        );
        excalidrawAPI?.setToast({
          message: `${template.label} sent to AI Workbench.`,
          duration: 3000,
        });
      },
      [excalidrawAPI],
    );
    const reuseGenerationLog = useCallback(
      (log: AIGenerationLogEntry) => {
        setWorkbenchDraftState((current) =>
          reuseGenerationLogInWorkbenchDraft(current, log),
        );
        excalidrawAPI?.toggleSidebar({
          name: DEFAULT_SIDEBAR.name,
          tab: "ai-image",
          force: true,
        });
        excalidrawAPI?.setToast({
          message: "Generation settings loaded in AI Workbench.",
          duration: 3000,
        });
      },
      [excalidrawAPI],
    );

    useEffect(() => {
      if (
        !promptTemplateRequest ||
        promptTemplateRequest.id === lastPromptTemplateRequestIdRef.current
      ) {
        return;
      }

      lastPromptTemplateRequestIdRef.current = promptTemplateRequest.id;
      applyPromptTemplateToWorkbench(promptTemplateRequest.template);
    }, [applyPromptTemplateToWorkbench, promptTemplateRequest]);

    useEffect(() => {
      if (
        !generationLogReuseRequest ||
        generationLogReuseRequest.id ===
          lastGenerationLogReuseRequestIdRef.current
      ) {
        return;
      }

      lastGenerationLogReuseRequestIdRef.current = generationLogReuseRequest.id;
      reuseGenerationLog(generationLogReuseRequest.log);
    }, [generationLogReuseRequest, reuseGenerationLog]);

    const openAISettings = useCallback(() => {
      window.dispatchEvent(createAIOpenSettingsEvent({ tab: "models" }));
    }, []);
    const openCreateTab = useCallback(() => {
      excalidrawAPI?.toggleSidebar({
        name: DEFAULT_SIDEBAR.name,
        tab: "ai-image",
        force: true,
      });
    }, [excalidrawAPI]);
    const openShareDialog = useCallback(() => {
      setShareDialogState({ isOpen: true, type: "share" });
    }, [setShareDialogState]);
    const openCollaborationDialog = useCallback(() => {
      setShareDialogState({ isOpen: true, type: "collaborationOnly" });
    }, [setShareDialogState]);
    const addSelectionAsReference = useCallback(() => {
      onAddSelectionAsReference?.();
    }, [onAddSelectionAsReference]);

    return (
      <>
        <AppSidebarTrigger />
        <DefaultSidebar
          className="app-sidebar-dock"
          docked
          closeOnOutsideClick={false}
          closeOnEscape={false}
        >
          <AppSidebarTabTriggers />
          <Sidebar.Tab tab="comments" className="AppSidebarOfficeTab">
            <AppSidebarOfficePanel
              kind="comments"
              onOpenCollaboration={openCollaborationDialog}
              onOpenCreate={openCreateTab}
              onOpenShare={openShareDialog}
            />
          </Sidebar.Tab>
          <Sidebar.Tab tab="ai-image" className="AIImageWorkbenchTab">
            <AppSidebarCommandHeader
              activeArea="Create"
              onAddSelectionAsReference={addSelectionAsReference}
              onOpenAISettings={openAISettings}
            />
            <AIImageWorkbench
              excalidrawAPI={excalidrawAPI}
              draftState={workbenchDraftState}
              onDraftStateChange={setWorkbenchDraftState}
              onEnterMaskEditing={onEnterMaskEditing}
              onMaskReady={onMaskReady}
              onSendPromptToAssistant={sendPromptToAssistant}
              referenceAddRequest={referenceAddRequest}
            />
          </Sidebar.Tab>
          <Sidebar.Tab
            tab="ai-generation-logs"
            className="AIGenerationLogPanelTab"
          >
            <AppSidebarCommandHeader
              activeArea="History"
              onAddSelectionAsReference={addSelectionAsReference}
              onOpenAISettings={openAISettings}
            />
            <AIGenerationLogPanel onReuseLog={reuseGenerationLog} />
          </Sidebar.Tab>
          <Sidebar.Tab tab="ai-assistant" className="CustomAgentChatTab">
            <AppSidebarCommandHeader
              activeArea="Assistant"
              onAddSelectionAsReference={addSelectionAsReference}
              onOpenAISettings={openAISettings}
            />
            <CustomAgentChat
              excalidrawAPI={excalidrawAPI}
              incomingPrompt={assistantIncomingPrompt}
              incomingSkill={assistantSkillRequest}
              onSendPromptToWorkbench={sendPromptToWorkbench}
            />
          </Sidebar.Tab>
          <Sidebar.Tab tab="presentation" className="AppSidebarOfficeTab">
            <AppSidebarOfficePanel
              kind="presentation"
              onOpenCollaboration={openCollaborationDialog}
              onOpenCreate={openCreateTab}
              onOpenShare={openShareDialog}
            />
          </Sidebar.Tab>
        </DefaultSidebar>
      </>
    );
  },
);

AppSidebar.displayName = "AppSidebar";

const AppSidebarTrigger = memo(() => (
  <DefaultSidebar.Trigger
    icon={sidebarRightIcon}
    tab="ai-image"
    title="AI Workbench"
    closeOnToggle={false}
  />
));

AppSidebarTrigger.displayName = "AppSidebarTrigger";

const AppSidebarTabTriggers = memo(() => (
  <DefaultSidebar.TabTriggers>
    <Sidebar.TabTrigger
      tab="ai-image"
      title="Create with AI"
      aria-label="Create with AI"
    >
      <AppSidebarTabTriggerContent
        icon={MagicIcon}
        label="Create"
        kind="primary"
      />
    </Sidebar.TabTrigger>
    <Sidebar.TabTrigger
      tab="ai-assistant"
      title="AI assistant"
      aria-label="AI assistant"
    >
      <AppSidebarTabTriggerContent
        icon={brainIcon}
        label="Assistant"
        kind="primary"
      />
    </Sidebar.TabTrigger>
    <Sidebar.TabTrigger
      tab="ai-generation-logs"
      title="Generation history"
      aria-label="Generation history"
    >
      <AppSidebarTabTriggerContent
        icon={clipboard}
        label="History"
        kind="primary"
      />
    </Sidebar.TabTrigger>
    <Sidebar.TabTrigger tab="comments" title="Comments" aria-label="Comments">
      <AppSidebarTabTriggerContent
        icon={messageCircleIcon}
        label="Comments"
        kind="secondary"
      />
    </Sidebar.TabTrigger>
    <Sidebar.TabTrigger
      tab="presentation"
      title="Presentations"
      aria-label="Presentations"
    >
      <AppSidebarTabTriggerContent
        icon={presentationIcon}
        label="Present"
        kind="secondary"
      />
    </Sidebar.TabTrigger>
  </DefaultSidebar.TabTriggers>
));

AppSidebarTabTriggers.displayName = "AppSidebarTabTriggers";

const AppSidebarTabTriggerContent = ({
  icon,
  label,
  kind,
}: {
  icon: ReactNode;
  label: string;
  kind: "primary" | "secondary";
}) => (
  <span
    className={`app-sidebar-tab-trigger__content app-sidebar-tab-trigger__content--${kind}`}
  >
    <span className="app-sidebar-tab-trigger__icon" aria-hidden="true">
      {icon}
    </span>
    <span className="app-sidebar-tab-trigger__label">{label}</span>
  </span>
);

const AppSidebarCommandHeader = ({
  activeArea,
  onAddSelectionAsReference,
  onOpenAISettings,
}: {
  activeArea: "Create" | "Assistant" | "History";
  onAddSelectionAsReference: () => void;
  onOpenAISettings: () => void;
}) => (
  <div className="app-sidebar-commandHeader">
    <div className="app-sidebar-commandHeader__title">
      <span>AI office whiteboard</span>
      <strong>{activeArea}</strong>
    </div>
    <div className="app-sidebar-commandHeader__actions">
      <button
        type="button"
        className="app-sidebar-commandHeader__button"
        onClick={onAddSelectionAsReference}
      >
        Add selection
      </button>
      <button
        type="button"
        className="app-sidebar-commandHeader__button"
        onClick={onOpenAISettings}
      >
        <span aria-hidden="true">{settingsIcon}</span>
        Settings
      </button>
    </div>
    <div
      className="app-sidebar-commandHeader__flow"
      role="list"
      aria-label="AI workflow"
    >
      <span
        role="listitem"
        className={activeArea === "Create" ? "is-active" : undefined}
      >
        Create
      </span>
      <span role="listitem" className="is-disabled" data-disabled="true">
        References
      </span>
      <span role="listitem" className="is-disabled" data-disabled="true">
        Inpaint
      </span>
      <span
        role="listitem"
        className={activeArea === "Assistant" ? "is-active" : undefined}
      >
        Assistant
      </span>
      <span
        role="listitem"
        className={activeArea === "History" ? "is-active" : undefined}
      >
        History
      </span>
    </div>
  </div>
);
