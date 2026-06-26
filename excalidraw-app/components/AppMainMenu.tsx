import {
  loginIcon,
  ExcalLogo,
  eyeIcon,
  MagicIcon,
} from "@excalidraw/excalidraw/components/icons";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { t } from "@excalidraw/excalidraw/i18n";
import { MainMenu } from "@excalidraw/excalidraw/index";
import React from "react";

import { isDevEnv } from "@excalidraw/common";

import type { Theme } from "@excalidraw/element/types";

import { LanguageList } from "../app-language/LanguageList";
import { AI_OPEN_SETTINGS_EVENT } from "../ai/workflowEvents";
import { useCloudAuth } from "../auth/useCloudAuth";
import { isExcalidrawPlusSignedUser } from "../app_constants";

import { AISettings } from "./AISettings";
import { saveDebugState } from "./DebugCanvas";

export const AppMainMenu: React.FC<{
  onCollabDialogOpen: () => any;
  isCollaborating: boolean;
  isCollabEnabled: boolean;
  theme: Theme | "system";
  refresh: () => void;
  onCloudAccountOpen?: () => void;
}> = React.memo((props) => {
  const [isAISettingsOpen, setIsAISettingsOpen] = React.useState(false);
  const [initialAISettingsTab, setInitialAISettingsTab] = React.useState<
    "models" | "agents" | "templates"
  >("models");

  const { isAuthAvailable, isSignedIn } = useCloudAuth();

  React.useEffect(() => {
    const openAISettings = (
      event: WindowEventMap[typeof AI_OPEN_SETTINGS_EVENT],
    ) => {
      setInitialAISettingsTab(event.detail?.tab || "models");
      setIsAISettingsOpen(true);
    };

    window.addEventListener(AI_OPEN_SETTINGS_EVENT, openAISettings);

    return () => {
      window.removeEventListener(AI_OPEN_SETTINGS_EVENT, openAISettings);
    };
  }, []);

  return (
    <>
      <MainMenu>
        <MainMenu.DefaultItems.LoadScene />
        <MainMenu.DefaultItems.SaveToActiveFile />
        <MainMenu.DefaultItems.Export />
        <MainMenu.DefaultItems.SaveAsImage />
        {props.isCollabEnabled && (
          <MainMenu.DefaultItems.LiveCollaborationTrigger
            isCollaborating={props.isCollaborating}
            onSelect={() => props.onCollabDialogOpen()}
          />
        )}
        <MainMenu.DefaultItems.CommandPalette className="highlighted" />
        <MainMenu.DefaultItems.SearchMenu />
        <MainMenu.DefaultItems.Help />
        <MainMenu.DefaultItems.ClearCanvas />
        <MainMenu.Separator />
        <MainMenu.ItemLink
          icon={ExcalLogo}
          href={`${
            import.meta.env.VITE_APP_PLUS_LP
          }/plus?utm_source=excalidraw&utm_medium=app&utm_content=hamburger`}
          className=""
        >
          Excalidraw+
        </MainMenu.ItemLink>
        <MainMenu.DefaultItems.Socials />
        {isAuthAvailable ? (
          isSignedIn ? (
            <MainMenu.Item
              icon={loginIcon}
              onSelect={() => props.onCloudAccountOpen?.()}
              className="highlighted"
            >
              {t("cloud.auth.accountMenu")}
            </MainMenu.Item>
          ) : (
            <MainMenu.Item
              icon={loginIcon}
              onSelect={() => props.onCloudAccountOpen?.()}
              className="highlighted"
            >
              {t("cloud.auth.signIn")}
            </MainMenu.Item>
          )
        ) : (
          <MainMenu.ItemLink
            icon={loginIcon}
            href={`${import.meta.env.VITE_APP_PLUS_APP}${
              isExcalidrawPlusSignedUser ? "" : "/sign-up"
            }?utm_source=signin&utm_medium=app&utm_content=hamburger`}
            className="highlighted"
          >
            {isExcalidrawPlusSignedUser
              ? t("buttons.signIn")
              : t("buttons.signUp")}
          </MainMenu.ItemLink>
        )}
        {isDevEnv() && (
          <MainMenu.Item
            icon={eyeIcon}
            onSelect={() => {
              if (window.visualDebug) {
                delete window.visualDebug;
                saveDebugState({ enabled: false });
              } else {
                window.visualDebug = { data: [] };
                saveDebugState({ enabled: true });
              }
              props?.refresh();
            }}
          >
            Visual Debug
          </MainMenu.Item>
        )}
        <MainMenu.Separator />
        <MainMenu.DefaultItems.Preferences
          additionalItems={
            <MainMenu.Item
              className="AppAISettingsMenuItem"
              icon={MagicIcon}
              onSelect={() => {
                setInitialAISettingsTab("models");
                setIsAISettingsOpen(true);
              }}
            >
              {t("ai.common.globalSettings")}
            </MainMenu.Item>
          }
        />
        <MainMenu.DefaultItems.ToggleTheme
          allowSystemTheme
          theme={props.theme}
        />
        <MainMenu.ItemCustom>
          <LanguageList style={{ width: "100%" }} />
        </MainMenu.ItemCustom>
        <MainMenu.DefaultItems.ChangeCanvasBackground />
      </MainMenu>

      {isAISettingsOpen && (
        <Dialog
          className="AISettingsDialog"
          title={t("ai.common.settings")}
          size="wide"
          onCloseRequest={() => setIsAISettingsOpen(false)}
        >
          <AISettings
            key={initialAISettingsTab}
            initialTab={initialAISettingsTab}
          />
        </Dialog>
      )}
    </>
  );
});
