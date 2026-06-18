import { THEME } from "@excalidraw/excalidraw";
import { share } from "@excalidraw/excalidraw/components/icons";
import { LinkButton } from "@excalidraw/excalidraw/components/LinkButton";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";

type AppSidebarOfficePanelProps = {
  kind: "comments" | "presentation";
  onOpenCollaboration: () => void;
  onOpenCreate: () => void;
  onOpenShare: () => void;
  plusBaseURL?: string;
};

export const AppSidebarOfficePanel = ({
  kind,
  onOpenCollaboration,
  onOpenCreate,
  onOpenShare,
  plusBaseURL = import.meta.env.VITE_APP_PLUS_LP,
}: AppSidebarOfficePanelProps) => {
  const { theme } = useUIAppState();
  const isComments = kind === "comments";
  const title = isComments ? "Team review" : "Presentation handoff";
  const plusText = isComments
    ? "Make comments with Excalidraw+"
    : "Create presentations with Excalidraw+";

  return (
    <div className="app-sidebar-officePanel">
      <div className="app-sidebar-officePanel__header">
        <span>Office workflow</span>
        <strong>{title}</strong>
      </div>
      <div
        className="app-sidebar-officePanel__flow"
        role="list"
        aria-label="Office workflow"
      >
        <span role="listitem" className="is-active">
          {isComments ? "Review" : "Present"}
        </span>
        <span role="listitem" className="is-disabled" data-disabled="true">
          Share
        </span>
        <span role="listitem" className="is-disabled" data-disabled="true">
          Export
        </span>
      </div>
      <div className="app-sidebar-officePanel__actions">
        <button
          type="button"
          className="app-sidebar-officePanel__button"
          onClick={onOpenShare}
        >
          <span aria-hidden="true">{share}</span>
          Share
        </button>
        <button
          type="button"
          className="app-sidebar-officePanel__button"
          onClick={onOpenCollaboration}
        >
          Live
        </button>
        <button
          type="button"
          className="app-sidebar-officePanel__button"
          onClick={onOpenCreate}
        >
          Create
        </button>
      </div>
      <div
        className="app-sidebar-officePanel__image"
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
      <div className="app-sidebar-officePanel__promoText">{plusText}</div>
      <div className="app-sidebar-officePanel__promoAction">
        <LinkButton
          href={`${plusBaseURL}/plus?utm_source=excalidraw&utm_medium=app&utm_content=${
            isComments ? "comments" : "presentations"
          }_promo#excalidraw-redirect`}
        >
          Sign up now
        </LinkButton>
      </div>
    </div>
  );
};
