import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { vi } from "vitest";

import { AppMainMenu } from "./AppMainMenu";

const authMock = vi.hoisted((): { state: any } => ({
  state: {
    isAuthAvailable: false,
    isSignedIn: false,
    signOut: vi.fn(),
    status: "signed-out",
    user: null,
  },
}));

const vaultConfigMock = vi.hoisted(() => ({ enabled: false }));

const makeAuthState = (overrides: Record<string, unknown> = {}) => ({
  isAuthAvailable: false,
  isSignedIn: false,
  signOut: vi.fn(),
  status: "signed-out",
  user: null,
  ...overrides,
});

vi.mock("../auth/useCloudAuth", () => ({
  useCloudAuth: () => authMock.state,
}));

vi.mock("../data/vault", () => ({
  readVaultClientConfig: () => ({
    enabled: vaultConfigMock.enabled,
    persistenceCapabilitiesUrl: null,
    roomCapabilitiesUrl: null,
    roomProvisionUrl: null,
  }),
}));

vi.mock("../app_constants", () => ({
  isExcalidrawPlusSignedUser: false,
}));

vi.mock("../ai/workflowEvents", () => ({
  AI_OPEN_SETTINGS_EVENT: "excalidraw-ai-open-settings",
}));

vi.mock("../app-language/LanguageList", () => ({
  LanguageList: () => <div>Language</div>,
}));

vi.mock("@excalidraw/common", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@excalidraw/common")>()),
  isDevEnv: () => false,
}));

vi.mock("@excalidraw/excalidraw/components/icons", () => ({
  CastIcon: null,
  CloseIcon: null,
  loginIcon: null,
  ExcalLogo: null,
  eyeIcon: null,
  LockedIcon: <svg data-testid="vault-icon" />,
  MagicIcon: null,
  P3EmbedIcon: <svg data-testid="p3-embed-icon" />,
  SingleFileBoardIcon: <svg data-testid="single-file-board-icon" />,
  LoadIcon: null,
  save: null,
}));

vi.mock("@excalidraw/excalidraw/i18n", () => ({
  t: (key: string, replacement?: Record<string, string | number>) => {
    const value =
      {
        "ai.common.globalSettings": "AI settings",
        "ai.common.settings": "AI settings",
        "buttons.close": "Close",
        "buttons.signIn": "Sign in",
        "buttons.signUp": "Sign up",
        "cloud.auth.cancel": "Cancel",
        "cloud.auth.account": "Account",
        "cloud.auth.accountIntro": "Manage cloud account.",
        "cloud.auth.accountMenu": "Cloud account",
        "cloud.auth.accountTitle": "Cloud account",
        "cloud.auth.cloudWhiteboards": "Cloud whiteboards",
        "cloud.auth.cloudWhiteboardsCount": "{{count}} saved",
        "cloud.auth.cloudWhiteboardsLoading": "Loading...",
        "cloud.auth.cloudWhiteboardsUnavailable": "Unavailable",
        "cloud.auth.email": "Email",
        "cloud.auth.genericError": "Sign-in failed. Please try again.",
        "cloud.auth.latestCloudWhiteboard": "Latest: {{title}}",
        "cloud.auth.password": "Password",
        "cloud.auth.signedInAs": "Signed in as",
        "cloud.auth.signIn": "Cloud sign in",
        "cloud.auth.signInAction": "Sign in",
        "cloud.auth.signInIntro":
          "Sign in to sync your whiteboards across devices.",
        "cloud.auth.signInTitle": "Sign in to the cloud",
        "cloud.auth.signingIn": "Signing in...",
        "cloud.auth.signOut": "Cloud sign out",
        "cloud.auth.signingOut": "Signing out...",
        "cloud.scenes.menu": "Cloud whiteboards",
        "cloud.scenes.saveToCloud": "Save to cloud",
        "labels.experimental.embedWhiteboard": "Embed whiteboard",
        "labels.experimental.embedPresets.view": "Read-only preview",
        "labels.experimental.embedPresets.edit": "Editable embed",
        "labels.experimental.embedPresets.compact": "Compact embed",
        "labels.experimental.embedPresets.presentation": "Presentation mode",
        "labels.experimental.singleFileBoard": "Single-file board",
        "vault.menu": "Vault (experimental)",
      }[key] ?? key;

    return value.replace(/\{\{(\w+)\}\}/g, (_, name) =>
      String(replacement?.[name] ?? ""),
    );
  },
}));

vi.mock("@excalidraw/excalidraw/components/Dialog", () => ({
  Dialog: ({
    children,
    title,
  }: {
    children: React.ReactNode;
    title: React.ReactNode;
  }) => (
    <div role="dialog">
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));

vi.mock("@excalidraw/excalidraw/index", () => {
  const MainMenu = ({ children }: { children: React.ReactNode }) => (
    <nav>{children}</nav>
  );

  MainMenu.Item = ({
    children,
    className,
    onSelect,
    icon,
  }: {
    children: React.ReactNode;
    className?: string;
    onSelect: () => void;
    icon?: React.ReactNode;
  }) => (
    <button className={className} type="button" onClick={onSelect}>
      {icon}
      {children}
    </button>
  );

  MainMenu.ItemLink = ({
    children,
    className,
    href,
  }: {
    children: React.ReactNode;
    className?: string;
    href: string;
  }) => (
    <a className={className} href={href}>
      {children}
    </a>
  );

  MainMenu.ItemCustom = ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  );

  MainMenu.Separator = () => <hr />;
  const MainMenuSub = ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  );
  MainMenuSub.Trigger = ({
    children,
    icon,
  }: {
    children: React.ReactNode;
    icon?: React.ReactNode;
  }) => (
    <div>
      {icon}
      {children}
    </div>
  );
  MainMenuSub.Content = ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  );
  MainMenu.Sub = MainMenuSub;

  const ExperimentalFeatures = ({
    children,
  }: {
    children?: React.ReactNode;
  }) => (
    <div>
      Experimental features
      {children}
    </div>
  );
  ExperimentalFeatures.Lumina = () => <div>Lumina submenu</div>;
  ExperimentalFeatures.Echo = () => <div>Echo submenu</div>;
  ExperimentalFeatures.LineTone = () => <div>Line tone submenu</div>;

  MainMenu.DefaultItems = {
    ChangeCanvasBackground: () => (
      <button type="button">Canvas background</button>
    ),
    ClearCanvas: () => <button type="button">Clear canvas</button>,
    CommandPalette: () => <button type="button">Command palette</button>,
    Export: () => <button type="button">Export</button>,
    ExperimentalFeatures,
    Help: () => <button type="button">Help</button>,
    LiveCollaborationTrigger: ({ onSelect }: { onSelect: () => void }) => (
      <button type="button" onClick={onSelect}>
        Live collaboration
      </button>
    ),
    LoadScene: () => <button type="button">Load scene</button>,
    Preferences: ({
      additionalItems,
    }: {
      additionalItems?: React.ReactNode;
    }) => (
      <div>
        Preferences
        {additionalItems}
      </div>
    ),
    SaveAsImage: () => <button type="button">Save as image</button>,
    SaveToActiveFile: () => <button type="button">Save to active file</button>,
    SearchMenu: () => <button type="button">Search</button>,
    Socials: () => <div>Social links</div>,
    ToggleTheme: () => <button type="button">Theme</button>,
  };

  return { MainMenu };
});

vi.mock("./AISettings", () => ({
  AISettings: () => <div>AI settings panel</div>,
}));

vi.mock("./CastDialog", () => ({
  CastDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog">Cast dialog</div> : null,
}));

vi.mock("./DebugCanvas", () => ({
  saveDebugState: vi.fn(),
}));

vi.mock("./VaultDependencyDialog", () => ({
  VaultDependencyDialog: ({
    open,
    canCreate,
    onSignIn,
  }: {
    open: boolean;
    canCreate: boolean;
    onSignIn?: () => void;
  }) =>
    open ? (
      <div role="dialog">
        Vault dependency dialog {canCreate ? "signed-in" : "signed-out"}
        {!canCreate && onSignIn && (
          <button type="button" onClick={onSignIn}>
            Vault sign in
          </button>
        )}
      </div>
    ) : null,
}));

const renderMenu = (
  props: {
    onCloudAccountOpen?: () => void;
    onEmbedOpen?: (options: {
      mode: "view" | "edit";
      preset: "full" | "compact" | "presentation";
    }) => void;
    onSingleFileDialogOpen?: () => void;
    externalFeaturesDisabled?: boolean;
  } = {},
) =>
  render(
    <AppMainMenu
      isCollabEnabled={false}
      isCollaborating={false}
      onCollabDialogOpen={vi.fn()}
      onCloudAccountOpen={props.onCloudAccountOpen}
      onEmbedOpen={props.onEmbedOpen ?? vi.fn()}
      onSingleFileDialogOpen={props.onSingleFileDialogOpen ?? vi.fn()}
      externalFeaturesDisabled={props.externalFeaturesDisabled}
      refresh={vi.fn()}
      theme="light"
    />,
  );

beforeEach(() => {
  vaultConfigMock.enabled = false;
});

describe("AppMainMenu experimental features", () => {
  beforeEach(() => {
    authMock.state = makeAuthState();
  });

  it("keeps Lumina, Echo, and line tone and opens the single-file board dialog", () => {
    const onSingleFileDialogOpen = vi.fn();
    renderMenu({ onSingleFileDialogOpen });

    expect(screen.getByText("Lumina submenu")).toBeInTheDocument();
    expect(screen.getByText("Echo submenu")).toBeInTheDocument();
    expect(screen.getByText("Line tone submenu")).toBeInTheDocument();
    expect(screen.getByTestId("single-file-board-icon")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Single-file board" }));

    expect(onSingleFileDialogOpen).toHaveBeenCalledTimes(1);
  });

  it("opens each iframe embed preset from its submenu", () => {
    const onEmbedOpen = vi.fn();
    renderMenu({ onEmbedOpen });

    expect(screen.getByTestId("p3-embed-icon")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Read-only preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Editable embed" }));
    fireEvent.click(screen.getByRole("button", { name: "Compact embed" }));
    fireEvent.click(screen.getByRole("button", { name: "Presentation mode" }));
    expect(onEmbedOpen.mock.calls).toEqual([
      [{ mode: "view", preset: "full" }],
      [{ mode: "edit", preset: "full" }],
      [{ mode: "edit", preset: "compact" }],
      [{ mode: "view", preset: "presentation" }],
    ]);
  });

  it("hides Vault by default and opens its dependency dialog only when explicitly enabled", () => {
    const { unmount } = renderMenu();

    expect(
      screen.queryByRole("button", { name: "Vault (experimental)" }),
    ).not.toBeInTheDocument();

    unmount();
    vaultConfigMock.enabled = true;
    renderMenu();

    expect(screen.getByTestId("vault-icon")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Vault (experimental)" }),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Vault dependency dialog signed-out",
    );
  });

  it("passes signed-in creation authorization and reuses the account dialog for sign-in", () => {
    const onCloudAccountOpen = vi.fn();
    vaultConfigMock.enabled = true;
    authMock.state = makeAuthState({ isAuthAvailable: true });
    const { unmount } = renderMenu({ onCloudAccountOpen });

    fireEvent.click(
      screen.getByRole("button", { name: "Vault (experimental)" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Vault sign in" }));
    expect(onCloudAccountOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    unmount();
    authMock.state = makeAuthState({
      isAuthAvailable: true,
      isSignedIn: true,
      status: "signed-in",
    });
    renderMenu({ onCloudAccountOpen });
    fireEvent.click(
      screen.getByRole("button", { name: "Vault (experimental)" }),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Vault dependency dialog signed-in",
    );
  });
});

describe("AppMainMenu Vault external feature isolation", () => {
  it("hides AI, iframe, remote workflow, plain export, and external product entries", () => {
    authMock.state = makeAuthState();
    renderMenu({ externalFeaturesDisabled: true });

    expect(
      screen.queryByRole("link", { name: "Excalidraw+" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Sign up" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Single-file board" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Read-only preview" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "labels.experimental.cast" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "AI settings" }),
    ).not.toBeInTheDocument();
  });
});

describe("AppMainMenu cloud auth account entry", () => {
  beforeEach(() => {
    authMock.state = makeAuthState();
  });

  it("keeps the Excalidraw+ sign-up link when cloud auth is unavailable", () => {
    renderMenu();

    expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute(
      "href",
      expect.stringContaining("/sign-up"),
    );
    expect(
      screen.queryByRole("button", { name: "Cloud sign in" }),
    ).not.toBeInTheDocument();
  });

  it("reuses the sign-up slot for cloud sign-in when cloud auth is available", () => {
    const onCloudAccountOpen = vi.fn();
    authMock.state = makeAuthState({ isAuthAvailable: true });
    renderMenu({ onCloudAccountOpen });

    expect(screen.getByRole("button", { name: "Cloud sign in" })).toHaveClass(
      "highlighted",
    );
    expect(
      screen.queryByRole("link", { name: "Sign up" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cloud sign in" }));

    expect(onCloudAccountOpen).toHaveBeenCalledTimes(1);
  });

  it("keeps only the cloud account entry when already signed in", () => {
    const onCloudAccountOpen = vi.fn();
    authMock.state = makeAuthState({
      isAuthAvailable: true,
      isSignedIn: true,
      status: "signed-in",
      user: {
        avatarUrl: null,
        createdAt: 0,
        displayName: null,
        email: "me@example.com",
        id: "u1",
        lastSignInAt: null,
      },
    });
    renderMenu({ onCloudAccountOpen });

    const accountButton = screen.getByRole("button", {
      name: "Cloud account",
    });
    expect(accountButton).toHaveClass("highlighted");
    expect(
      screen.queryByRole("link", { name: "Sign up" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Cloud whiteboards" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save to cloud" }),
    ).not.toBeInTheDocument();

    fireEvent.click(accountButton);

    expect(onCloudAccountOpen).toHaveBeenCalledTimes(1);
  });
});

describe("AppMainMenu Cast entry", () => {
  it("opens Cast from the Experimental menu", () => {
    renderMenu();

    fireEvent.click(
      screen.getByRole("button", { name: "labels.experimental.cast" }),
    );

    expect(screen.getByRole("dialog")).toHaveTextContent("Cast dialog");
  });
});
