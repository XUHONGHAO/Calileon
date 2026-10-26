import { DEFAULT_SIDEBAR } from "@excalidraw/common";
import { Sidebar } from "@excalidraw/excalidraw";
import { messageCircleIcon } from "@excalidraw/excalidraw/components/icons";
import { t } from "@excalidraw/excalidraw/i18n";
import { memo } from "react";

import { useCommentsBadge } from "../../comments/useSceneComments";

import "./CommentsPanel.scss";

import type { CommentsController } from "../../comments/commentsController";

/**
 * View mode (read-only `#cloud=` links) hides the editor's sidebar trigger,
 * so visitors who may comment (C8) get this one, opening the comments tab.
 */
export const CommentsViewModeTrigger = memo(
  ({ controller }: { controller: CommentsController | null }) => {
    const badge = useCommentsBadge(controller);
    return (
      <span className="CommentsViewModeTrigger">
        <Sidebar.Trigger
          name={DEFAULT_SIDEBAR.name}
          tab="comments"
          icon={messageCircleIcon}
          title={badge ? t("comments.tabBadge") : t("ai.sidebar.comments")}
        />
        {badge && (
          <span className="CommentsViewModeTrigger__badge" aria-hidden="true" />
        )}
      </span>
    );
  },
);

CommentsViewModeTrigger.displayName = "CommentsViewModeTrigger";
