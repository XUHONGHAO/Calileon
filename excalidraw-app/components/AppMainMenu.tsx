import {
  CastIcon,
  checkIcon,
  emptyIcon,
  loginIcon,
  eyeIcon,
  LockedIcon,
  MagicIcon,
  P3EmbedIcon,
  PlusIcon,
  SingleFileBoardIcon,
} from "@excalidraw/excalidraw/components/icons";
import { t } from "@excalidraw/excalidraw/i18n";
import { MainMenu } from "@excalidraw/excalidraw/index";
import React from "react";

import { isDevEnv } from "@excalidraw/common";

import type { Theme } from "@excalidraw/element/types";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawProps,
} from "@excalidraw/excalidraw/types";

import { LanguageList } from "../app-language/LanguageList";
import { AI_OPEN_SETTINGS_EVENT } from "../ai/workflowEvents";

import { useCloudAuth } from "../auth/useCloudAuth";
import { isExcalidrawPlusSignedUser } from "../app_constants";
import { BRAND_PAGE_URLS } from "../brand-pages/routes";
import { readVaultClientConfig } from "../data/vault";
import { isVaultV2Enabled } from "../data/vault/v2/flag";

import { AISettings, confirmDiscardAISettingsChanges } from "./AISettings";
import { AppDialog } from "./ui";
import { ManyMindsDialog } from "./ManyMindsDialog";

import { CastDialog } from "./CastDialog";
import { saveDebugState } from "./DebugCanvas";
import { VaultDependencyDialog } from "./VaultDependencyDialog";
import { useShowLabs } from "./labsPreference";
// Labs wave 1: one line per feature, owned by that feature's branch.
import { RorschachHost, RorschachMenuItem } from "./labs/rorschach";
import { ShelfLifeHost, ShelfLifeMenuItem } from "./labs/shelfLife";
import { SynesthesiaHost, SynesthesiaMenuItem } from "./labs/synesthesia";

import type { AISettingsTab } from "../ai/workflowEvents";

import type { ActiveCloudSceneInfo } from "./AuthDialog";

export const AppMainMenu: React.FC<{
  onCollabDialogOpen: () => any;
  isCollaborating: boolean;
  isCollabEnabled: boolean;
  theme: Theme | "system";
  refresh: () => void;
  onCloudAccountOpen?: () => void;
  onSingleFileDialogOpen: () => void;
  onEmbedOpen: (options: {
    mode: "view" | "edit";
    preset: "full" | "compact" | "presentation";
  }) => void;
  manyMindsPersistenceScopeId?: string | null;
  excalidrawAPI?: ExcalidrawImperativeAPI | null;
  activeCloudScene?: ActiveCloudSceneInfo | null;
  langCode?: ExcalidrawProps["langCode"];
  externalFeaturesDisabled?: boolean;
}> = React.memo((props) => {
  const [isAISettingsOpen, setIsAISettingsOpen] = React.useState(false);
  const [isCastDialogOpen, setIsCastDialogOpen] = React.useState(false);
  const [isManyMindsOpen, setIsManyMindsOpen] = React.useState(false);
  const [isVaultDependencyDialogOpen, setIsVaultDependencyDialogOpen] =
    React.useState(false);
  const [initialAISettingsTab, setInitialAISettingsTab] =
    React.useState<AISettingsTab>("models");
  // Unsaved edits inside AI settings: Esc, the backdrop and the close button
  // all confirm before throwing them away.
  const aiSettingsDirtyRef = React.useRef(false);
  const handleAISettingsDirtyChange = React.useCallback((dirty: boolean) => {
    aiSettingsDirtyRef.current = dirty;
  }, []);
  const confirmCloseAISettings = React.useCallback(
    async () =>
      !aiSettingsDirtyRef.current || (await confirmDiscardAISettingsChanges()),
    [],
  );

  const [showLabs, setShowLabs] = useShowLabs();
  const { isAuthAvailable, isSignedIn } = useCloudAuth();
  const vaultEnabled = readVaultClientConfig().enabled;

  React.useEffect(() => {
    const openAISettings = (
      event: WindowEventMap[typeof AI_OPEN_SETTINGS_EVENT],
    ) => {
      if (props.externalFeaturesDisabled) {
        return;
      }
      setInitialAISettingsTab(event.detail?.tab || "models");
      setIsAISettingsOpen(true);
    };

    window.addEventListener(AI_OPEN_SETTINGS_EVENT, openAISettings);

    return () => {
      window.removeEventListener(AI_OPEN_SETTINGS_EVENT, openAISettings);
    };
  }, [props.externalFeaturesDisabled]);

  React.useEffect(() => {
    if (props.externalFeaturesDisabled) {
      setIsAISettingsOpen(false);
      setIsCastDialogOpen(false);
      setIsManyMindsOpen(false);
    }
  }, [props.externalFeaturesDisabled]);

  return (
    <>
      <MainMenu>
        <MainMenu.DefaultItems.LoadScene />
        <MainMenu.DefaultItems.SaveToActiveFile />
        <MainMenu.DefaultItems.Export />
        <MainMenu.DefaultItems.SaveAsImage />
        <MainMenu.Separator />
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
        ) : null}
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
        {/* Vault is a storage/security feature, not a Lab: turning Labs off
            must not hide the way into an encrypted board. */}
        {vaultEnabled && (
          <MainMenu.Item
            icon={LockedIcon}
            onSelect={() => setIsVaultDependencyDialogOpen(true)}
            data-testid="vault-menu-item"
            aria-label={t("vault.menu")}
          >
            {t("vault.menu")}
          </MainMenu.Item>
        )}
        {showLabs && (
          <MainMenu.DefaultItems.ExperimentalFeatures>
            <MainMenu.DefaultItems.ExperimentalFeatures.Lumina />
            <MainMenu.DefaultItems.ExperimentalFeatures.Echo />
            <MainMenu.DefaultItems.ExperimentalFeatures.LineTone />
            {!props.externalFeaturesDisabled && (
              <>
                <MainMenu.Item
                  icon={SingleFileBoardIcon}
                  onSelect={props.onSingleFileDialogOpen}
                >
                  {t("labels.experimental.singleFileBoard")}
                </MainMenu.Item>
                <MainMenu.Sub>
                  <MainMenu.Sub.Trigger icon={P3EmbedIcon}>
                    {t("labels.experimental.embedWhiteboard")}
                  </MainMenu.Sub.Trigger>
                  <MainMenu.Sub.Content>
                    <MainMenu.Item
                      onSelect={() =>
                        props.onEmbedOpen({ mode: "view", preset: "full" })
                      }
                      data-testid="embed-view-menu-item"
                    >
                      {t("labels.experimental.embedPresets.view")}
                    </MainMenu.Item>
                    <MainMenu.Item
                      onSelect={() =>
                        props.onEmbedOpen({ mode: "edit", preset: "full" })
                      }
                      data-testid="embed-edit-menu-item"
                    >
                      {t("labels.experimental.embedPresets.edit")}
                    </MainMenu.Item>
                    <MainMenu.Item
                      onSelect={() =>
                        props.onEmbedOpen({ mode: "edit", preset: "compact" })
                      }
                      data-testid="embed-compact-menu-item"
                    >
                      {t("labels.experimental.embedPresets.compact")}
                    </MainMenu.Item>
                    <MainMenu.Item
                      onSelect={() =>
                        props.onEmbedOpen({
                          mode: "view",
                          preset: "presentation",
                        })
                      }
                      data-testid="embed-presentation-menu-item"
                    >
                      {t("labels.experimental.embedPresets.presentation")}
                    </MainMenu.Item>
                  </MainMenu.Sub.Content>
                </MainMenu.Sub>
                <MainMenu.Item
                  icon={CastIcon}
                  onSelect={() => setIsCastDialogOpen(true)}
                  data-testid="cast-menu-item"
                  aria-label={t("labels.experimental.cast")}
                >
                  {t("labels.experimental.cast")}
                </MainMenu.Item>
                <MainMenu.Item
                  icon={MagicIcon}
                  onSelect={() => setIsManyMindsOpen(true)}
                  data-testid="many-minds-menu-item"
                  aria-label={t("ai.manyMinds.title")}
                >
                  {t("ai.manyMinds.title")}
                </MainMenu.Item>
              </>
            )}
            <RorschachMenuItem
              externalFeaturesDisabled={!!props.externalFeaturesDisabled}
            />
            <ShelfLifeMenuItem
              externalFeaturesDisabled={!!props.externalFeaturesDisabled}
            />
            <SynesthesiaMenuItem
              externalFeaturesDisabled={!!props.externalFeaturesDisabled}
            />
          </MainMenu.DefaultItems.ExperimentalFeatures>
        )}
        <MainMenu.DefaultItems.Preferences
          additionalItems={
            <>
              <MainMenu.Item
                icon={showLabs ? checkIcon : emptyIcon}
                aria-pressed={showLabs}
                data-testid="show-labs-menu-item"
                onSelect={(event) => {
                  setShowLabs(!showLabs);
                  event.preventDefault();
                }}
              >
                {t("ui.showLabs")}
              </MainMenu.Item>
              {!props.externalFeaturesDisabled && (
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
              )}
            </>
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
        <MainMenu.Separator />
        {!props.externalFeaturesDisabled && (
          <MainMenu.ItemLink
            icon={PlusIcon}
            href={BRAND_PAGE_URLS.plus}
            className=""
          >
            Calileon+
          </MainMenu.ItemLink>
        )}
        {!isAuthAvailable && !props.externalFeaturesDisabled && (
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
        <MainMenu.DefaultItems.Socials />
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
      </MainMenu>

      {!props.externalFeaturesDisabled && isAISettingsOpen && (
        <AppDialog
          className="AISettingsDialog"
          title={t("ai.common.settings")}
          size="wide"
          onBeforeClose={confirmCloseAISettings}
          onCloseRequest={() => setIsAISettingsOpen(false)}
        >
          <AISettings
            key={initialAISettingsTab}
            initialTab={initialAISettingsTab}
            onDirtyChange={handleAISettingsDirtyChange}
          />
        </AppDialog>
      )}
      <CastDialog
        open={!props.externalFeaturesDisabled && isCastDialogOpen}
        onClose={() => setIsCastDialogOpen(false)}
        excalidrawAPI={props.excalidrawAPI ?? null}
        activeCloudScene={props.activeCloudScene}
        langCode={props.langCode}
      />
      <ManyMindsDialog
        open={!props.externalFeaturesDisabled && isManyMindsOpen}
        onClose={() => setIsManyMindsOpen(false)}
        excalidrawAPI={props.excalidrawAPI ?? null}
        persistenceScopeId={props.manyMindsPersistenceScopeId ?? null}
      />
      <RorschachHost
        excalidrawAPI={props.excalidrawAPI ?? null}
        externalFeaturesDisabled={!!props.externalFeaturesDisabled}
      />
      <ShelfLifeHost
        excalidrawAPI={props.excalidrawAPI ?? null}
        externalFeaturesDisabled={!!props.externalFeaturesDisabled}
      />
      <SynesthesiaHost
        excalidrawAPI={props.excalidrawAPI ?? null}
        externalFeaturesDisabled={!!props.externalFeaturesDisabled}
      />
      <VaultDependencyDialog
        open={isVaultDependencyDialogOpen}
        onClose={() => setIsVaultDependencyDialogOpen(false)}
        canCreate={isSignedIn}
        onSignIn={() => {
          setIsVaultDependencyDialogOpen(false);
          props.onCloudAccountOpen?.();
        }}
        onCreateV2={
          isVaultV2Enabled()
            ? async () =>
                (
                  await import("../data/vault/v2/appBinding")
                ).createVaultV2ForApp()
            : undefined
        }
      />
    </>
  );
});
