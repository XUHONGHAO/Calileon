import { THEME } from "@excalidraw/excalidraw";
import { share } from "@excalidraw/excalidraw/components/icons";
import { LinkButton } from "@excalidraw/excalidraw/components/LinkButton";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";
import { t } from "@excalidraw/excalidraw/i18n";

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
  const title = isComments
    ? t("ai.office.teamReview")
    : t("ai.office.presentationHandoff");
  const plusText = isComments
    ? t("ai.office.makeCommentsWithPlus")
    : t("ai.office.createPresentationsWithPlus");

  return (
    <div className="app-sidebar-officePanel">
      <div className="app-sidebar-officePanel__header">
        <span>{t("ai.office.workflow")}</span>
        <strong>{title}</strong>
      </div>
      <div
        className="app-sidebar-officePanel__flow"
        role="list"
        aria-label={t("ai.office.workflow")}
      >
        <span role="listitem" className="is-active">
          {isComments ? t("ai.office.review") : t("ai.sidebar.present")}
        </span>
        <span role="listitem" className="is-disabled" data-disabled="true">
          {t("ai.office.share")}
        </span>
        <span role="listitem" className="is-disabled" data-disabled="true">
          {t("ai.office.export")}
        </span>
      </div>
      <div className="app-sidebar-officePanel__actions">
        <button
          type="button"
          className="app-sidebar-officePanel__button"
          onClick={onOpenShare}
        >
          <span aria-hidden="true">{share}</span>
          {t("ai.office.share")}
        </button>
        <button
          type="button"
          className="app-sidebar-officePanel__button"
          onClick={onOpenCollaboration}
        >
          {t("ai.office.live")}
        </button>
        <button
          type="button"
          className="app-sidebar-officePanel__button"
          onClick={onOpenCreate}
        >
          {t("ai.common.create")}
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
          {t("ai.office.signUpNow")}
        </LinkButton>
      </div>
    </div>
  );
};
