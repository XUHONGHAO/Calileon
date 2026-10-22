import { createIcon } from "@excalidraw/excalidraw/components/icons";

/** The mirror itself: a glass with an ink blot inside. */
export const RorschachIcon = createIcon(
  <>
    <path d="M4 7a8 8 0 0 1 16 0c0 4.4-2.9 7.6-5.5 9.6L13 20H9l-1.5-3.4C4.9 14.6 4 11.3 4 7z" />
    <path d="M8.5 8.5c1.2-1.1 2-1.6 2.9-1.1c.9.5.6 1.7-.2 2.4c-.8.7-.4 1.6.6 1.8c1 .2 1.7-.5 2.3.4c.6.9-.1 1.9-1.2 2.2" />
  </>,
  {
    width: 20,
    height: 20,
    stroke: "currentColor",
    fill: "none",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
);

/** Gentle counselor: a soft speech bubble with a tiny heart. */
export const RorschachGentlePersonaIcon = createIcon(
  <>
    <path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-6l-4 3v-3H5A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5z" />
    <path d="M12 13.2s-2.2-1.3-2.2-2.7c0-.9.7-1.5 1.5-1.5c.4 0 .7.2.9.5c.2-.3.5-.5.9-.5c.8 0 1.5.6 1.5 1.5c0 1.4-2.2 2.7-2.2 2.7z" />
  </>,
  {
    width: 24,
    height: 24,
    stroke: "currentColor",
    fill: "none",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
);

/** Mystic master: a sparkle over a crescent. */
export const RorschachMysticPersonaIcon = createIcon(
  <>
    <path d="M15.5 3.5a7 7 0 1 0 5 11.6a5.6 5.6 0 0 1-5-11.6z" />
    <path d="M17.5 14.5l.9 2.2l2.1.9l-2.1.9l-.9 2.1l-.9-2.1l-2.1-.9l2.1-.9z" />
  </>,
  {
    width: 24,
    height: 24,
    stroke: "currentColor",
    fill: "none",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
);

/** Grim diviner: an eye with smoke. */
export const RorschachGrimPersonaIcon = createIcon(
  <>
    <path d="M2.5 11.5s3.6-5.5 9.5-5.5s9.5 5.5 9.5 5.5s-3.6 5.5-9.5 5.5s-9.5-5.5-9.5-5.5z" />
    <path d="M12 9.5a2 2 0 1 0 0 4a2 2 0 0 0 0-4z" />
    <path d="M5.5 19.5c1.6-1 1.2-2 2.6-2.6c1.4-.6 2.4.5 3.9 0" />
  </>,
  {
    width: 24,
    height: 24,
    stroke: "currentColor",
    fill: "none",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
);

export const RORSCHACH_PERSONA_ICONS = {
  gentleCounselor: RorschachGentlePersonaIcon,
  mysticMaster: RorschachMysticPersonaIcon,
  grimDiviner: RorschachGrimPersonaIcon,
} as const;
