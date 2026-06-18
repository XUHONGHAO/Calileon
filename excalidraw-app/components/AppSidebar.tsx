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
import { useI18n } from "@excalidraw/excalidraw/i18n";
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
    const { t } = useI18n();
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
          message: t("ai.sidebar.promptLoadedInAssistant"),
          duration: 3000,
        });
      },
      [excalidrawAPI, t],
    );
    const applyPromptTemplateToWorkbench = useCallback(
      (template: PromptTemplate) => {
        setWorkbenchDraftState((current) =>
          applyPromptTemplateToWorkbenchDraft(current, template),
        );
        excalidrawAPI?.setToast({
          message: t("ai.sidebar.templateSentToWorkbench", {
            template: template.label,
          }),
          duration: 3000,
        });
      },
      [excalidrawAPI, t],
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
          message: t("ai.sidebar.generationSettingsLoaded"),
          duration: 3000,
        });
      },
      [excalidrawAPI, t],
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

const AppSidebarTrigger = memo(() => {
  const { t } = useI18n();

  return (
    <DefaultSidebar.Trigger
      icon={sidebarRightIcon}
      tab="ai-image"
      title={t("ai.sidebar.workbenchTitle")}
      closeOnToggle={false}
    />
  );
});

AppSidebarTrigger.displayName = "AppSidebarTrigger";

const AppSidebarTabTriggers = memo(() => {
  const { t } = useI18n();

  return (
    <DefaultSidebar.TabTriggers>
      <Sidebar.TabTrigger
        tab="ai-image"
        title={t("ai.sidebar.createWithAI")}
        aria-label={t("ai.sidebar.createWithAI")}
      >
        <AppSidebarTabTriggerContent
          icon={MagicIcon}
          label={t("ai.common.create")}
          kind="primary"
        />
      </Sidebar.TabTrigger>
      <Sidebar.TabTrigger
        tab="ai-assistant"
        title={t("ai.sidebar.assistant")}
        aria-label={t("ai.sidebar.assistant")}
      >
        <AppSidebarTabTriggerContent
          icon={brainIcon}
          label={t("ai.sidebar.assistantLabel")}
          kind="primary"
        />
      </Sidebar.TabTrigger>
      <Sidebar.TabTrigger
        tab="ai-generation-logs"
        title={t("ai.sidebar.generationHistory")}
        aria-label={t("ai.sidebar.generationHistory")}
      >
        <AppSidebarTabTriggerContent
          icon={clipboard}
          label={t("ai.sidebar.history")}
          kind="primary"
        />
      </Sidebar.TabTrigger>
      <Sidebar.TabTrigger
        tab="comments"
        title={t("ai.sidebar.comments")}
        aria-label={t("ai.sidebar.comments")}
      >
        <AppSidebarTabTriggerContent
          icon={messageCircleIcon}
          label={t("ai.sidebar.comments")}
          kind="secondary"
        />
      </Sidebar.TabTrigger>
      <Sidebar.TabTrigger
        tab="presentation"
        title={t("ai.sidebar.presentations")}
        aria-label={t("ai.sidebar.presentations")}
      >
        <AppSidebarTabTriggerContent
          icon={presentationIcon}
          label={t("ai.sidebar.present")}
          kind="secondary"
        />
      </Sidebar.TabTrigger>
    </DefaultSidebar.TabTriggers>
  );
});

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
}) => {
  const { t } = useI18n();
  const activeAreaLabel =
    activeArea === "Create"
      ? t("ai.common.create")
      : activeArea === "Assistant"
      ? t("ai.sidebar.assistantLabel")
      : t("ai.sidebar.history");

  return (
    <div className="app-sidebar-commandHeader">
      <div className="app-sidebar-commandHeader__title">
        <span>{t("ai.sidebar.officeWhiteboard")}</span>
        <strong>{activeAreaLabel}</strong>
      </div>
    <div className="app-sidebar-commandHeader__actions">
      <button
        type="button"
        className="app-sidebar-commandHeader__button"
        onClick={onAddSelectionAsReference}
      >
        {t("ai.sidebar.addSelection")}
      </button>
      <button
        type="button"
        className="app-sidebar-commandHeader__button"
        onClick={onOpenAISettings}
      >
        <span aria-hidden="true">{settingsIcon}</span>
        {t("ai.common.settings")}
      </button>
    </div>
    <div
      className="app-sidebar-commandHeader__flow"
      role="list"
      aria-label={t("ai.sidebar.workflow")}
    >
      <span
        role="listitem"
        className={activeArea === "Create" ? "is-active" : undefined}
      >
        {t("ai.common.create")}
      </span>
      <span role="listitem" className="is-disabled" data-disabled="true">
        {t("ai.sidebar.references")}
      </span>
      <span role="listitem" className="is-disabled" data-disabled="true">
        {t("ai.common.inpaint")}
      </span>
      <span
        role="listitem"
        className={activeArea === "Assistant" ? "is-active" : undefined}
      >
        {t("ai.sidebar.assistantLabel")}
      </span>
      <span
        role="listitem"
        className={activeArea === "History" ? "is-active" : undefined}
      >
        {t("ai.sidebar.history")}
      </span>
    </div>
  </div>
  );
};
