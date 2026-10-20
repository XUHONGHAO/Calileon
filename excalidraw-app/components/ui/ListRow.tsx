import clsx from "clsx";
import React from "react";

import { ActionMenu } from "./ActionMenu";

import type { ActionMenuItem } from "./ActionMenu";

/**
 * One row of a list (scenes, tasks, links, invitations): optional leading
 * thumbnail/icon, title with meta line and badges, one or two visible
 * actions and the rest in an overflow menu.
 */
export const ListRow = ({
  leading,
  title,
  meta,
  badges,
  actions,
  menu,
  current = false,
  className,
  as: Tag = "li",
}: {
  leading?: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  badges?: React.ReactNode;
  actions?: React.ReactNode;
  menu?: ActionMenuItem[];
  current?: boolean;
  className?: string;
  as?: "li" | "div";
}) => (
  <Tag
    className={clsx("UiListRow", { "UiListRow--current": current }, className)}
    aria-current={current || undefined}
  >
    {leading && <div className="UiListRow__leading">{leading}</div>}
    <div className="UiListRow__body">
      <div className="UiListRow__titleLine">
        <span className="UiListRow__title">{title}</span>
        {badges && <span className="UiListRow__badges">{badges}</span>}
      </div>
      {meta && <div className="UiListRow__meta">{meta}</div>}
    </div>
    {(actions || (menu && menu.length > 0)) && (
      <div className="UiListRow__actions">
        {actions}
        {menu && menu.length > 0 && <ActionMenu items={menu} />}
      </div>
    )}
  </Tag>
);
