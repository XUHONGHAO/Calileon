import { DefaultSidebar, Sidebar, THEME } from "@excalidraw/excalidraw";
import {
  clipboard,
  brainIcon,
  messageCircleIcon,
  MagicIcon,
  presentationIcon,
  sidebarRightIcon,
} from "@excalidraw/excalidraw/components/icons";
import { LinkButton } from "@excalidraw/excalidraw/components/LinkButton";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";
import { memo, useCallback, useState } from "react";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawFreeDrawElement } from "@excalidraw/element/types";

import {
  AIImageWorkbench,
  createInitialAIImageWorkbenchDraftState,
} from "./AIImageWorkbench";
import { AIGenerationLogPanel } from "./AIGenerationLogPanel";
import { CustomAgentChat } from "./CustomAgentChat/CustomAgentChat";

import "./AppSidebar.scss";

import type { AIImageWorkbenchDraftState } from "./AIImageWorkbench";
import type { AIMaskReadyPayload } from "../ai/types";

type AppSidebarProps = {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  onEnterMaskEditing?: (
    imageId: string,
    maskElements?: readonly ExcalidrawFreeDrawElement[],
  ) => void;
  onMaskReady?: (
    handler: ((payload: AIMaskReadyPayload) => void) | null,
  ) => void;
};

export const AppSidebar = memo(
  ({ excalidrawAPI, onEnterMaskEditing, onMaskReady }: AppSidebarProps) => {
    const [workbenchDraftState, setWorkbenchDraftState] =
      useState<AIImageWorkbenchDraftState>(
        createInitialAIImageWorkbenchDraftState,
      );
    const sendPromptToWorkbench = useCallback((prompt: string) => {
      setWorkbenchDraftState((current) => ({
        ...current,
        mediaType: "image",
        mode: "text-to-image",
        imageModes: {
          ...current.imageModes,
          "text-to-image": {
            ...current.imageModes["text-to-image"],
            prompt,
          },
        },
      }));
    }, []);

    return (
      <>
        <AppSidebarTrigger />
        <DefaultSidebar
          docked
          closeOnOutsideClick={false}
          closeOnEscape={false}
        >
          <AppSidebarTabTriggers />
          <Sidebar.Tab tab="comments">
            <AppSidebarPromo kind="comments" />
          </Sidebar.Tab>
          <Sidebar.Tab tab="ai-image" className="AIImageWorkbenchTab">
            <AIImageWorkbench
              excalidrawAPI={excalidrawAPI}
              draftState={workbenchDraftState}
              onDraftStateChange={setWorkbenchDraftState}
              onEnterMaskEditing={onEnterMaskEditing}
              onMaskReady={onMaskReady}
            />
          </Sidebar.Tab>
          <Sidebar.Tab
            tab="ai-generation-logs"
            className="AIGenerationLogPanelTab"
          >
            <AIGenerationLogPanel />
          </Sidebar.Tab>
          <Sidebar.Tab tab="ai-assistant" className="CustomAgentChatTab">
            <CustomAgentChat
              excalidrawAPI={excalidrawAPI}
              onSendPromptToWorkbench={sendPromptToWorkbench}
            />
          </Sidebar.Tab>
          <Sidebar.Tab tab="presentation" className="px-3">
            <AppSidebarPromo kind="presentation" />
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
    title="AI"
    closeOnToggle={false}
  />
));

AppSidebarTrigger.displayName = "AppSidebarTrigger";

const AppSidebarTabTriggers = memo(() => (
  <DefaultSidebar.TabTriggers>
    <Sidebar.TabTrigger tab="ai-image">{MagicIcon}</Sidebar.TabTrigger>
    <Sidebar.TabTrigger tab="ai-assistant">{brainIcon}</Sidebar.TabTrigger>
    <Sidebar.TabTrigger tab="ai-generation-logs">
      {clipboard}
    </Sidebar.TabTrigger>
    <Sidebar.TabTrigger tab="comments">{messageCircleIcon}</Sidebar.TabTrigger>
    <Sidebar.TabTrigger tab="presentation">
      {presentationIcon}
    </Sidebar.TabTrigger>
  </DefaultSidebar.TabTriggers>
));

AppSidebarTabTriggers.displayName = "AppSidebarTabTriggers";

const AppSidebarPromo = ({ kind }: { kind: "comments" | "presentation" }) => {
  const { theme } = useUIAppState();
  const isComments = kind === "comments";

  return (
    <div className="app-sidebar-promo-container">
      <div
        className="app-sidebar-promo-image"
        style={{
          ["--image-source" as any]: isComments
            ? `url(/oss_promo_comments_${
                theme === THEME.DARK ? "dark" : "light"
              }.jpg)`
            : `url(/oss_promo_presentations_${
                theme === THEME.DARK ? "dark" : "light"
              }.svg)`,
          backgroundSize: isComments ? undefined : "60%",
          opacity: isComments ? 0.7 : 0.4,
        }}
      />
      <div className="app-sidebar-promo-text">
        {isComments
          ? "Make comments with Excalidraw+"
          : "Create presentations with Excalidraw+"}
      </div>
      <LinkButton
        href={`${
          import.meta.env.VITE_APP_PLUS_LP
        }/plus?utm_source=excalidraw&utm_medium=app&utm_content=${
          isComments ? "comments" : "presentations"
        }_promo#excalidraw-redirect`}
      >
        Sign up now
      </LinkButton>
    </div>
  );
};
