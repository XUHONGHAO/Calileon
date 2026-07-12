import clsx from "clsx";
import { useSyncExternalStore } from "react";

import { THEME, arrayToMap } from "@excalidraw/common";

import type { Theme } from "@excalidraw/element/types";

import {
  actionAddLightSource,
  actionAddSun,
  actionResetLuminaGame,
  actionClearCanvas,
  actionLoadScene,
  actionSaveToActiveFile,
  actionSetLuminaGameMode,
  actionShortcuts,
  actionToggleArrowBinding,
  actionToggleGridMode,
  actionToggleLumina,
  actionToggleLuminaCaustics,
  actionCreateEchoAnchor,
  actionBindEchoSelection,
  actionUnbindEchoSelection,
  actionDuplicateEchoIndependent,
  actionSetEchoStatus,
  actionToggleMidpointSnapping,
  actionToggleObjectsSnapMode,
  actionToggleSearchMenu,
  actionToggleStats,
  actionToggleTheme,
  actionToggleZenMode,
} from "../../actions";
import { actionToggleViewMode } from "../../actions/actionToggleViewMode";
import { getShortcutFromShortcutName } from "../../actions/shortcuts";
import { trackEvent } from "../../analytics";
import { useUIAppState } from "../../context/ui-appState";
import { useSetAtom } from "../../editor-jotai";
import { useI18n } from "../../i18n";
import { activeConfirmDialogAtom } from "../ActiveConfirmDialog";
import {
  useExcalidrawSetAppState,
  useExcalidrawActionManager,
  useExcalidrawElements,
  useAppProps,
  useApp,
} from "../App";
import { evaluateLuminaGame } from "../../renderer/lumina/game";
import {
  getLuminaGameSessionSnapshot,
  subscribeLuminaGameSession,
} from "../../renderer/lumina/gameSession";
import { openConfirmModal } from "../OverwriteConfirm/OverwriteConfirmState";
import Trans from "../Trans";
import DropdownMenuItem from "../dropdownMenu/DropdownMenuItem";
import DropdownMenuItemCheckbox from "../dropdownMenu/DropdownMenuItemCheckbox";
import DropdownMenuItemContentRadio from "../dropdownMenu/DropdownMenuItemContentRadio";
import DropdownMenuItemLink from "../dropdownMenu/DropdownMenuItemLink";
import DropdownMenuSub from "../dropdownMenu/DropdownMenuSub";
import {
  GithubIcon,
  DiscordIcon,
  XBrandIcon,
  settingsIcon,
  emptyIcon,
  ExperimentIcon,
  CloseIcon,
} from "../icons";
import {
  adjustmentsIcon,
  boltIcon,
  LightBulbIcon,
  DeviceDesktopIcon,
  ExportIcon,
  ExportImageIcon,
  HelpIcon,
  LoadIcon,
  laserPointerToolIcon,
  MoonIcon,
  pencilIcon,
  playerPlayIcon,
  RetryIcon,
  DuplicateIcon,
  elementLinkIcon,
  save,
  searchIcon,
  SunIcon,
  TrashIcon,
  usersIcon,
} from "../icons";

import "./DefaultItems.scss";

export const LoadScene = () => {
  const { t } = useI18n();
  const actionManager = useExcalidrawActionManager();
  const elements = useExcalidrawElements();

  if (!actionManager.isActionEnabled(actionLoadScene)) {
    return null;
  }

  const handleSelect = async () => {
    if (
      !elements.length ||
      (await openConfirmModal({
        title: t("overwriteConfirm.modal.loadFromFile.title"),
        actionLabel: t("overwriteConfirm.modal.loadFromFile.button"),
        color: "warning",
        description: (
          <Trans
            i18nKey="overwriteConfirm.modal.loadFromFile.description"
            bold={(text) => <strong>{text}</strong>}
            br={() => <br />}
          />
        ),
      }))
    ) {
      actionManager.executeAction(actionLoadScene);
    }
  };

  return (
    <DropdownMenuItem
      icon={LoadIcon}
      onSelect={handleSelect}
      data-testid="load-button"
      shortcut={getShortcutFromShortcutName("loadScene")}
      aria-label={t("buttons.load")}
    >
      {t("buttons.load")}
    </DropdownMenuItem>
  );
};
LoadScene.displayName = "LoadScene";

export const SaveToActiveFile = () => {
  const { t } = useI18n();
  const actionManager = useExcalidrawActionManager();

  if (!actionManager.isActionEnabled(actionSaveToActiveFile)) {
    return null;
  }

  return (
    <DropdownMenuItem
      shortcut={getShortcutFromShortcutName("saveScene")}
      data-testid="save-button"
      onSelect={() => actionManager.executeAction(actionSaveToActiveFile)}
      icon={save}
      aria-label={`${t("buttons.save")}`}
    >{`${t("buttons.save")}`}</DropdownMenuItem>
  );
};
SaveToActiveFile.displayName = "SaveToActiveFile";

export const SaveAsImage = () => {
  const setAppState = useExcalidrawSetAppState();
  const { t } = useI18n();
  return (
    <DropdownMenuItem
      icon={ExportImageIcon}
      data-testid="image-export-button"
      onSelect={() => setAppState({ openDialog: { name: "imageExport" } })}
      shortcut={getShortcutFromShortcutName("imageExport")}
      aria-label={t("buttons.exportImage")}
    >
      {t("buttons.exportImage")}
    </DropdownMenuItem>
  );
};
SaveAsImage.displayName = "SaveAsImage";

export const CommandPalette = (opts?: { className?: string }) => {
  const setAppState = useExcalidrawSetAppState();
  const { t } = useI18n();

  return (
    <DropdownMenuItem
      icon={boltIcon}
      data-testid="command-palette-button"
      onSelect={() => {
        trackEvent("command_palette", "open", "menu");
        setAppState({ openDialog: { name: "commandPalette" } });
      }}
      shortcut={getShortcutFromShortcutName("commandPalette")}
      aria-label={t("commandPalette.title")}
      className={opts?.className}
    >
      {t("commandPalette.title")}
    </DropdownMenuItem>
  );
};
CommandPalette.displayName = "CommandPalette";

export const SearchMenu = (opts?: { className?: string }) => {
  const { t } = useI18n();
  const actionManager = useExcalidrawActionManager();

  return (
    <DropdownMenuItem
      icon={searchIcon}
      data-testid="search-menu-button"
      onSelect={() => {
        actionManager.executeAction(actionToggleSearchMenu);
      }}
      shortcut={getShortcutFromShortcutName("searchMenu")}
      aria-label={t("search.title")}
      className={opts?.className}
    >
      {t("search.title")}
    </DropdownMenuItem>
  );
};
SearchMenu.displayName = "SearchMenu";

export const Help = () => {
  const { t } = useI18n();

  const actionManager = useExcalidrawActionManager();

  return (
    <DropdownMenuItem
      data-testid="help-menu-item"
      icon={HelpIcon}
      onSelect={() => actionManager.executeAction(actionShortcuts)}
      shortcut="?"
      aria-label={t("helpDialog.title")}
    >
      {t("helpDialog.title")}
    </DropdownMenuItem>
  );
};
Help.displayName = "Help";

export const ClearCanvas = () => {
  const { t } = useI18n();

  const setActiveConfirmDialog = useSetAtom(activeConfirmDialogAtom);
  const actionManager = useExcalidrawActionManager();

  if (!actionManager.isActionEnabled(actionClearCanvas)) {
    return null;
  }

  return (
    <DropdownMenuItem
      icon={TrashIcon}
      onSelect={() => setActiveConfirmDialog("clearCanvas")}
      data-testid="clear-canvas-button"
      aria-label={t("buttons.clearReset")}
    >
      {t("buttons.clearReset")}
    </DropdownMenuItem>
  );
};
ClearCanvas.displayName = "ClearCanvas";

export const ToggleTheme = (
  props:
    | {
        allowSystemTheme: true;
        /**
         * Controls the theme of this UI component only.
         * You should subscribe to `props.onThemeChange` and control the theme
         * upstream.
         */
        theme: Theme | "system";
      }
    | {
        allowSystemTheme: false;
      },
) => {
  const { t } = useI18n();
  const appState = useUIAppState();
  const actionManager = useExcalidrawActionManager();
  const shortcut = getShortcutFromShortcutName("toggleTheme");
  const appProps = useAppProps();

  if (!actionManager.isActionEnabled(actionToggleTheme)) {
    return null;
  }

  if (props?.allowSystemTheme) {
    return (
      <DropdownMenuItemContentRadio
        name="theme"
        value={props.theme}
        onChange={(value: Theme | "system") => {
          if (appProps.onThemeChange) {
            appProps.onThemeChange(value);
            return;
          }

          console.warn(
            "MainMenu.DefaultItems.ToggleTheme: `<Excalidraw/> props.onThemeChange` must be defined to use system theme selection.",
          );
        }}
        choices={[
          {
            value: THEME.LIGHT,
            label: SunIcon,
            ariaLabel: `${t("buttons.lightMode")} - ${shortcut}`,
          },
          {
            value: THEME.DARK,
            label: MoonIcon,
            ariaLabel: `${t("buttons.darkMode")} - ${shortcut}`,
          },
          {
            value: "system",
            label: DeviceDesktopIcon,
            ariaLabel: t("buttons.systemMode"),
          },
        ]}
      >
        {t("labels.theme")}
      </DropdownMenuItemContentRadio>
    );
  }

  return (
    <DropdownMenuItem
      onSelect={(event) => {
        // do not close the menu when changing theme
        event.preventDefault();

        actionManager.executeAction(actionToggleTheme);
      }}
      icon={appState.theme === THEME.DARK ? SunIcon : MoonIcon}
      data-testid="toggle-dark-mode"
      shortcut={shortcut}
      aria-label={
        appState.theme === THEME.DARK
          ? t("buttons.lightMode")
          : t("buttons.darkMode")
      }
    >
      {appState.theme === THEME.DARK
        ? t("buttons.lightMode")
        : t("buttons.darkMode")}
    </DropdownMenuItem>
  );
};
ToggleTheme.displayName = "ToggleTheme";

export const ChangeCanvasBackground = () => {
  const { t } = useI18n();
  const appState = useUIAppState();
  const actionManager = useExcalidrawActionManager();
  const appProps = useAppProps();

  if (
    appState.viewModeEnabled ||
    !appProps.UIOptions.canvasActions.changeViewBackgroundColor
  ) {
    return null;
  }
  return (
    <div style={{ marginTop: "0.75rem" }}>
      <div
        data-testid="canvas-background-label"
        style={{
          fontSize: "0.875rem",
          marginBottom: "0.25rem",
          marginLeft: "0.5rem",
        }}
      >
        {t("labels.canvasBackground")}
      </div>
      <div style={{ padding: "0 0.625rem" }}>
        {actionManager.renderAction("changeViewBackgroundColor")}
      </div>
    </div>
  );
};
ChangeCanvasBackground.displayName = "ChangeCanvasBackground";

export const Export = () => {
  const { t } = useI18n();
  const setAppState = useExcalidrawSetAppState();
  return (
    <DropdownMenuItem
      icon={ExportIcon}
      onSelect={() => {
        setAppState({ openDialog: { name: "jsonExport" } });
      }}
      data-testid="json-export-button"
      aria-label={t("buttons.export")}
    >
      {t("buttons.export")}
    </DropdownMenuItem>
  );
};
Export.displayName = "Export";

export const Socials = () => {
  const { t } = useI18n();

  return (
    <>
      <DropdownMenuItemLink
        icon={GithubIcon}
        href="https://github.com/excalidraw/excalidraw"
        aria-label="GitHub"
      >
        GitHub
      </DropdownMenuItemLink>
      <DropdownMenuItemLink
        icon={XBrandIcon}
        href="https://x.com/excalidraw"
        aria-label="X"
      >
        {t("labels.followUs")}
      </DropdownMenuItemLink>
      <DropdownMenuItemLink
        icon={DiscordIcon}
        href="https://discord.gg/UexuTaE"
        aria-label="Discord"
      >
        {t("labels.discordChat")}
      </DropdownMenuItemLink>
    </>
  );
};
Socials.displayName = "Socials";

export const LiveCollaborationTrigger = ({
  onSelect,
  isCollaborating,
}: {
  onSelect: () => void;
  isCollaborating: boolean;
}) => {
  const { t } = useI18n();
  return (
    <DropdownMenuItem
      data-testid="collab-button"
      icon={usersIcon}
      className={clsx({
        "active-collab": isCollaborating,
      })}
      onSelect={onSelect}
    >
      {t("labels.liveCollaboration")}
    </DropdownMenuItem>
  );
};

LiveCollaborationTrigger.displayName = "LiveCollaborationTrigger";

const PreferencesToggleToolLockItem = () => {
  const { t } = useI18n();
  const app = useApp();
  const appState = useUIAppState();

  return (
    <DropdownMenuItemCheckbox
      checked={appState.activeTool.locked}
      shortcut={getShortcutFromShortcutName("toolLock")}
      onSelect={(event) => {
        app.toggleLock();
        event.preventDefault();
      }}
    >
      {t("labels.preferences_toolLock")}
    </DropdownMenuItemCheckbox>
  );
};

const PreferencesBoxSelectionModeItem = () => {
  const { t } = useI18n();
  const appState = useUIAppState();
  const setAppState = useExcalidrawSetAppState();

  return (
    <DropdownMenuItemContentRadio<"contain" | "overlap">
      name="boxSelectionMode"
      icon={emptyIcon}
      value={appState.boxSelectionMode}
      onChange={(value) => {
        setAppState({
          boxSelectionMode: value,
        });
      }}
      choices={[
        {
          value: "contain",
          label: t("labels.boxSelectionContain"),
          ariaLabel: t("labels.boxSelectionContain"),
        },
        {
          value: "overlap",
          label: t("labels.boxSelectionOverlap"),
          ariaLabel: t("labels.boxSelectionOverlap"),
        },
      ]}
    >
      {t("labels.boxSelectionMode")}
    </DropdownMenuItemContentRadio>
  );
};

const PreferencesToggleSnapModeItem = () => {
  const { t } = useI18n();
  const actionManager = useExcalidrawActionManager();
  const appState = useUIAppState();
  return (
    <DropdownMenuItemCheckbox
      checked={appState.objectsSnapModeEnabled}
      shortcut={getShortcutFromShortcutName("objectsSnapMode")}
      onSelect={(event) => {
        actionManager.executeAction(actionToggleObjectsSnapMode);
        event.preventDefault();
      }}
    >
      {t("buttons.objectsSnapMode")}
    </DropdownMenuItemCheckbox>
  );
};

const PreferencesToggleArrowBindingItem = () => {
  const { t } = useI18n();
  const actionManager = useExcalidrawActionManager();
  const appState = useUIAppState();
  return (
    <DropdownMenuItemCheckbox
      checked={appState.bindingPreference === "enabled"}
      onSelect={(event) => {
        actionManager.executeAction(actionToggleArrowBinding);
        event.preventDefault();
      }}
    >
      {t("labels.arrowBinding")}
    </DropdownMenuItemCheckbox>
  );
};

const PreferencesToggleMidpointSnappingItem = () => {
  const { t } = useI18n();
  const actionManager = useExcalidrawActionManager();
  const appState = useUIAppState();
  return (
    <DropdownMenuItemCheckbox
      checked={appState.isMidpointSnappingEnabled}
      onSelect={(event) => {
        actionManager.executeAction(actionToggleMidpointSnapping);
        event.preventDefault();
      }}
    >
      {t("labels.midpointSnapping")}
    </DropdownMenuItemCheckbox>
  );
};

export const PreferencesToggleGridModeItem = () => {
  const { t } = useI18n();
  const actionManager = useExcalidrawActionManager();
  const appState = useUIAppState();

  return (
    <DropdownMenuItemCheckbox
      checked={appState.gridModeEnabled}
      shortcut={getShortcutFromShortcutName("gridMode")}
      onSelect={(event) => {
        actionManager.executeAction(actionToggleGridMode);
        event.preventDefault();
      }}
    >
      {t("labels.toggleGrid")}
    </DropdownMenuItemCheckbox>
  );
};

export const PreferencesToggleZenModeItem = () => {
  const { t } = useI18n();
  const actionManager = useExcalidrawActionManager();
  const appState = useUIAppState();
  return (
    <DropdownMenuItemCheckbox
      checked={appState.zenModeEnabled}
      shortcut={getShortcutFromShortcutName("zenMode")}
      onSelect={(event) => {
        actionManager.executeAction(actionToggleZenMode);
        event.preventDefault();
      }}
    >
      {t("buttons.zenMode")}
    </DropdownMenuItemCheckbox>
  );
};

const PreferencesToggleViewModeItem = () => {
  const { t } = useI18n();
  const actionManager = useExcalidrawActionManager();
  const appState = useUIAppState();
  return (
    <DropdownMenuItemCheckbox
      checked={appState.viewModeEnabled}
      shortcut={getShortcutFromShortcutName("viewMode")}
      onSelect={(event) => {
        actionManager.executeAction(actionToggleViewMode);
        event.preventDefault();
      }}
    >
      {t("labels.viewMode")}
    </DropdownMenuItemCheckbox>
  );
};

const PreferencesToggleElementPropertiesItem = () => {
  const { t } = useI18n();
  const actionManager = useExcalidrawActionManager();
  const appState = useUIAppState();
  return (
    <DropdownMenuItemCheckbox
      checked={appState.stats.open}
      shortcut={getShortcutFromShortcutName("stats")}
      onSelect={(event) => {
        actionManager.executeAction(actionToggleStats);
        event.preventDefault();
      }}
    >
      {t("stats.fullTitle")}
    </DropdownMenuItemCheckbox>
  );
};

const ExperimentalToggleLuminaItem = () => {
  const { t } = useI18n();
  const actionManager = useExcalidrawActionManager();
  const appState = useUIAppState();
  return (
    <DropdownMenuItem
      icon={boltIcon}
      selected={appState.luminaEnabled}
      aria-pressed={appState.luminaEnabled}
      data-testid="lumina-toggle-menu-item"
      onSelect={(event) => {
        actionManager.executeAction(actionToggleLumina);
        event.preventDefault();
      }}
    >
      {t("labels.lumina.toggle")}
    </DropdownMenuItem>
  );
};

const ExperimentalAddLightSourceItem = () => {
  const { t } = useI18n();
  const actionManager = useExcalidrawActionManager();
  return (
    <DropdownMenuItem
      icon={LightBulbIcon}
      onSelect={() => {
        actionManager.executeAction(actionAddLightSource);
      }}
      data-testid="lumina-add-light-menu-item"
      aria-label={t("labels.lumina.addLight")}
    >
      {t("labels.lumina.addLight")}
    </DropdownMenuItem>
  );
};

const ExperimentalToggleLuminaCausticsItem = () => {
  const { t } = useI18n();
  const actionManager = useExcalidrawActionManager();
  const appState = useUIAppState();
  if (!appState.luminaEnabled) {
    return null;
  }
  return (
    <DropdownMenuItem
      icon={adjustmentsIcon}
      selected={appState.luminaCaustics}
      aria-pressed={appState.luminaCaustics}
      data-testid="lumina-caustics-menu-item"
      onSelect={(event) => {
        actionManager.executeAction(actionToggleLuminaCaustics);
        event.preventDefault();
      }}
    >
      {t("labels.lumina.caustics")}
    </DropdownMenuItem>
  );
};

const ExperimentalAddSunItem = () => {
  const { t } = useI18n();
  const actionManager = useExcalidrawActionManager();
  return (
    <DropdownMenuItem
      icon={SunIcon}
      onSelect={() => {
        actionManager.executeAction(actionAddSun);
      }}
      data-testid="lumina-add-sun-menu-item"
      aria-label={t("labels.lumina.addSun")}
    >
      {t("labels.lumina.addSun")}
    </DropdownMenuItem>
  );
};

const LuminaGameStatusItem = () => {
  const { t } = useI18n();
  const appState = useUIAppState();
  const elements = useExcalidrawElements();
  const gameSession = useSyncExternalStore(
    subscribeLuminaGameSession,
    () => getLuminaGameSessionSnapshot(appState.luminaGameMode),
    () => getLuminaGameSessionSnapshot(null),
  );

  if (!appState.luminaEnabled || appState.luminaGameMode?.phase !== "play") {
    return null;
  }

  const evaluation = evaluateLuminaGame(elements, arrayToMap(elements), {
    luminaEnabled: appState.luminaEnabled,
    luminaAmbient: appState.luminaAmbient,
    luminaCaustics: appState.luminaCaustics,
    luminaGameMode: appState.luminaGameMode,
  });

  return (
    <div
      className="dropdown-menu-section-title"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {appState.luminaGameMode.style === "dark-room"
        ? t("labels.lumina.game.status.darkRoomProgress", {
            discovered: gameSession.discoveredIds.filter((id) =>
              gameSession.requiredIds.includes(id),
            ).length,
            required: gameSession.requiredIds.length,
          })
        : appState.luminaGameMode.style === "shadow-reveal"
        ? evaluation.solved
          ? t("labels.lumina.game.status.shadowMatched")
          : t("labels.lumina.game.status.shadowUnmatched")
        : evaluation.solved
        ? t("labels.lumina.game.status.solved")
        : t("labels.lumina.game.status.unsolved")}
    </div>
  );
};

const LuminaGameEditItem = () => {
  const { t } = useI18n();
  const actionManager = useExcalidrawActionManager();
  const appState = useUIAppState();

  if (!appState.luminaEnabled) {
    return null;
  }

  const selected =
    appState.luminaGameMode?.style === "laser" &&
    appState.luminaGameMode.phase === "edit";

  return (
    <DropdownMenuItem
      icon={pencilIcon}
      selected={selected}
      aria-pressed={selected}
      data-testid="lumina-game-edit-menu-item"
      onSelect={(event) => {
        actionManager.executeAction(actionSetLuminaGameMode, "ui", {
          style: "laser",
          phase: "edit",
        });
        event.preventDefault();
      }}
    >
      {t("labels.lumina.game.mode.edit")}
    </DropdownMenuItem>
  );
};

const LuminaShadowGameEditItem = () => {
  const { t } = useI18n();
  const actionManager = useExcalidrawActionManager();
  const appState = useUIAppState();

  if (!appState.luminaEnabled) {
    return null;
  }

  const selected =
    appState.luminaGameMode?.style === "shadow-reveal" &&
    appState.luminaGameMode.phase === "edit";

  return (
    <DropdownMenuItem
      icon={adjustmentsIcon}
      selected={selected}
      aria-pressed={selected}
      data-testid="lumina-shadow-game-edit-menu-item"
      onSelect={(event) => {
        actionManager.executeAction(actionSetLuminaGameMode, "ui", {
          style: "shadow-reveal",
          phase: "edit",
        });
        event.preventDefault();
      }}
    >
      {t("labels.lumina.game.mode.shadowEdit")}
    </DropdownMenuItem>
  );
};

const LuminaGamePlayItem = () => {
  const { t } = useI18n();
  const actionManager = useExcalidrawActionManager();
  const appState = useUIAppState();

  if (!appState.luminaEnabled) {
    return null;
  }

  const selected =
    appState.luminaGameMode?.style === "laser" &&
    appState.luminaGameMode.phase === "play";

  return (
    <DropdownMenuItem
      icon={laserPointerToolIcon}
      selected={selected}
      aria-pressed={selected}
      data-testid="lumina-game-play-menu-item"
      onSelect={(event) => {
        actionManager.executeAction(actionSetLuminaGameMode, "ui", {
          style: "laser",
          phase: "play",
        });
        event.preventDefault();
      }}
    >
      {t("labels.lumina.game.mode.play")}
    </DropdownMenuItem>
  );
};

const LuminaShadowGamePlayItem = () => {
  const { t } = useI18n();
  const actionManager = useExcalidrawActionManager();
  const appState = useUIAppState();

  if (!appState.luminaEnabled) {
    return null;
  }

  const selected =
    appState.luminaGameMode?.style === "shadow-reveal" &&
    appState.luminaGameMode.phase === "play";

  return (
    <DropdownMenuItem
      icon={playerPlayIcon}
      selected={selected}
      aria-pressed={selected}
      data-testid="lumina-shadow-game-play-menu-item"
      onSelect={(event) => {
        actionManager.executeAction(actionSetLuminaGameMode, "ui", {
          style: "shadow-reveal",
          phase: "play",
        });
        event.preventDefault();
      }}
    >
      {t("labels.lumina.game.mode.shadowPlay")}
    </DropdownMenuItem>
  );
};

const LuminaDarkRoomEditItem = () => {
  const { t } = useI18n();
  const actionManager = useExcalidrawActionManager();
  const appState = useUIAppState();

  if (!appState.luminaEnabled) {
    return null;
  }

  const selected =
    appState.luminaGameMode?.style === "dark-room" &&
    appState.luminaGameMode.phase === "edit";

  return (
    <DropdownMenuItem
      icon={LightBulbIcon}
      selected={selected}
      aria-pressed={selected}
      data-testid="lumina-dark-room-edit-menu-item"
      onSelect={(event) => {
        actionManager.executeAction(actionSetLuminaGameMode, "ui", {
          style: "dark-room",
          phase: "edit",
        });
        event.preventDefault();
      }}
    >
      {t("labels.lumina.game.mode.darkRoomEdit")}
    </DropdownMenuItem>
  );
};

const LuminaDarkRoomPlayItem = () => {
  const { t } = useI18n();
  const actionManager = useExcalidrawActionManager();
  const appState = useUIAppState();

  if (!appState.luminaEnabled) {
    return null;
  }

  const selected =
    appState.luminaGameMode?.style === "dark-room" &&
    appState.luminaGameMode.phase === "play";

  return (
    <DropdownMenuItem
      icon={playerPlayIcon}
      selected={selected}
      aria-pressed={selected}
      data-testid="lumina-dark-room-play-menu-item"
      onSelect={(event) => {
        actionManager.executeAction(actionSetLuminaGameMode, "ui", {
          style: "dark-room",
          phase: "play",
        });
        event.preventDefault();
      }}
    >
      {t("labels.lumina.game.mode.darkRoomPlay")}
    </DropdownMenuItem>
  );
};

const LuminaGameOffItem = () => {
  const { t } = useI18n();
  const actionManager = useExcalidrawActionManager();
  const appState = useUIAppState();

  if (!appState.luminaEnabled || !appState.luminaGameMode) {
    return null;
  }

  return (
    <DropdownMenuItem
      icon={CloseIcon}
      onSelect={() => {
        actionManager.executeAction(actionSetLuminaGameMode, "ui", null);
      }}
      data-testid="lumina-game-off-menu-item"
      aria-label={t("labels.lumina.game.mode.off")}
    >
      {t("labels.lumina.game.mode.off")}
    </DropdownMenuItem>
  );
};

const LuminaGameResetItem = () => {
  const { t } = useI18n();
  const actionManager = useExcalidrawActionManager();
  const appState = useUIAppState();

  if (!appState.luminaEnabled || appState.luminaGameMode?.phase !== "play") {
    return null;
  }

  return (
    <DropdownMenuItem
      icon={RetryIcon}
      onSelect={() => {
        actionManager.executeAction(actionResetLuminaGame);
      }}
      data-testid="lumina-game-reset-menu-item"
      aria-label={t("labels.lumina.game.reset")}
    >
      {t("labels.lumina.game.reset")}
    </DropdownMenuItem>
  );
};

export const LuminaFeatureSubmenu = ({
  children,
}: {
  children?: React.ReactNode;
}) => {
  const { t } = useI18n();
  const appState = useUIAppState();
  return (
    <DropdownMenuSub>
      <DropdownMenuSub.Trigger icon={SunIcon}>
        {t("labels.experimental.lumina")}
      </DropdownMenuSub.Trigger>
      <DropdownMenuSub.Content>
        {children || (
          <>
            <div className="dropdown-menu-section-title">
              {t("labels.lumina.sections.lighting")}
            </div>
            <ExperimentalToggleLuminaItem />
            <ExperimentalToggleLuminaCausticsItem />
            <ExperimentalAddLightSourceItem />
            <ExperimentalAddSunItem />
            <LuminaGameStatusItem />
            {appState.luminaEnabled && (
              <>
                <div className="dropdown-menu-section-title">
                  {t("labels.lumina.sections.edit")}
                </div>
                <LuminaGameEditItem />
                <LuminaShadowGameEditItem />
                <LuminaDarkRoomEditItem />
                <div className="dropdown-menu-section-title">
                  {t("labels.lumina.sections.play")}
                </div>
                <LuminaGamePlayItem />
                <LuminaShadowGamePlayItem />
                <LuminaDarkRoomPlayItem />
                {appState.luminaGameMode && (
                  <>
                    <div className="dropdown-menu-section-title">
                      {t("labels.lumina.sections.session")}
                    </div>
                    <LuminaGameResetItem />
                    <LuminaGameOffItem />
                  </>
                )}
              </>
            )}
          </>
        )}
      </DropdownMenuSub.Content>
    </DropdownMenuSub>
  );
};

export const ExperimentalFeatures = ({
  children,
}: {
  children?: React.ReactNode;
}) => {
  const { t } = useI18n();
  return (
    <DropdownMenuSub>
      <DropdownMenuSub.Trigger icon={ExperimentIcon}>
        {t("labels.experimental.label")}
      </DropdownMenuSub.Trigger>
      <DropdownMenuSub.Content>
        {children || (
          <>
            <LuminaFeatureSubmenu />
            <EchoFeatureSubmenu />
          </>
        )}
      </DropdownMenuSub.Content>
    </DropdownMenuSub>
  );
};

export const EchoFeatureSubmenu = () => {
  const { t } = useI18n();
  const actionManager = useExcalidrawActionManager();
  const runCreate = () =>
    actionManager.executeAction(
      actionCreateEchoAnchor as any,
      "ui",
      t("labels.echo.defaultName"),
    );
  return (
    <DropdownMenuSub>
      <DropdownMenuSub.Trigger icon={elementLinkIcon}>
        {t("labels.experimental.echo")}
      </DropdownMenuSub.Trigger>
      <DropdownMenuSub.Content>
        <DropdownMenuItem
          icon={elementLinkIcon}
          data-testid="echo-create-menu-item"
          onSelect={runCreate}
        >
          {t("labels.echo.createAnchor")}
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={elementLinkIcon}
          data-testid="echo-bind-menu-item"
          onSelect={() => actionManager.executeAction(actionBindEchoSelection)}
        >
          {t("labels.echo.bindSelection")}
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={DuplicateIcon}
          data-testid="echo-duplicate-independent-menu-item"
          onSelect={() =>
            actionManager.executeAction(actionDuplicateEchoIndependent)
          }
        >
          {t("labels.echo.duplicateIndependent")}
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={CloseIcon}
          data-testid="echo-unbind-menu-item"
          onSelect={() =>
            actionManager.executeAction(actionUnbindEchoSelection)
          }
        >
          {t("labels.echo.unbind")}
        </DropdownMenuItem>
        <div className="dropdown-menu-section-title">
          {t("labels.echo.status.label")}
        </div>
        {([null, "todo", "in-progress", "blocked", "done"] as const).map(
          (status) => (
            <DropdownMenuItem
              key={status ?? "none"}
              icon={adjustmentsIcon}
              onSelect={() =>
                actionManager.executeAction(
                  actionSetEchoStatus as any,
                  "ui",
                  status,
                )
              }
            >
              {t(`labels.echo.status.${status ?? "none"}`)}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuSub.Content>
    </DropdownMenuSub>
  );
};

ExperimentalFeatures.Lumina = LuminaFeatureSubmenu;
ExperimentalFeatures.Echo = EchoFeatureSubmenu;
ExperimentalFeatures.ToggleLumina = ExperimentalToggleLuminaItem;
ExperimentalFeatures.ToggleLuminaCaustics =
  ExperimentalToggleLuminaCausticsItem;
ExperimentalFeatures.AddLightSource = ExperimentalAddLightSourceItem;
ExperimentalFeatures.AddSun = ExperimentalAddSunItem;
ExperimentalFeatures.LuminaGameEdit = LuminaGameEditItem;
ExperimentalFeatures.LuminaGamePlay = LuminaGamePlayItem;
ExperimentalFeatures.LuminaShadowGameEdit = LuminaShadowGameEditItem;
ExperimentalFeatures.LuminaShadowGamePlay = LuminaShadowGamePlayItem;
ExperimentalFeatures.LuminaGameReset = LuminaGameResetItem;
ExperimentalFeatures.displayName = "ExperimentalFeatures";

export const Preferences = ({
  children,
  additionalItems,
}: {
  children?: React.ReactNode;
  additionalItems?: React.ReactNode;
}) => {
  const { t } = useI18n();
  return (
    <DropdownMenuSub>
      <DropdownMenuSub.Trigger icon={settingsIcon}>
        {t("labels.preferences")}
      </DropdownMenuSub.Trigger>
      <DropdownMenuSub.Content className="excalidraw-main-menu-preferences-submenu">
        {children || (
          <>
            <PreferencesBoxSelectionModeItem />
            <PreferencesToggleToolLockItem />
            <PreferencesToggleSnapModeItem />
            <PreferencesToggleGridModeItem />
            <PreferencesToggleZenModeItem />
            <PreferencesToggleViewModeItem />
            <PreferencesToggleElementPropertiesItem />
            <PreferencesToggleArrowBindingItem />
            <PreferencesToggleMidpointSnappingItem />
          </>
        )}
        {additionalItems}
      </DropdownMenuSub.Content>
    </DropdownMenuSub>
  );
};

Preferences.ToggleToolLock = PreferencesToggleToolLockItem;
Preferences.BoxSelectionMode = PreferencesBoxSelectionModeItem;
Preferences.ToggleSnapMode = PreferencesToggleSnapModeItem;
Preferences.ToggleArrowBinding = PreferencesToggleArrowBindingItem;
Preferences.ToggleMidpointSnapping = PreferencesToggleMidpointSnappingItem;
Preferences.ToggleGridMode = PreferencesToggleGridModeItem;
Preferences.ToggleZenMode = PreferencesToggleZenModeItem;
Preferences.ToggleViewMode = PreferencesToggleViewModeItem;
Preferences.ToggleElementProperties = PreferencesToggleElementPropertiesItem;

Preferences.displayName = "Preferences";
