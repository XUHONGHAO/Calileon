import { createIcon } from "@excalidraw/excalidraw/components/icons";

// Tabler outline icons for the comments panel (24px grid, 2px stroke).
const tabler = {
  width: 24,
  height: 24,
  fill: "none",
  strokeWidth: 2,
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export const replyIcon = createIcon(
  <path d="M9 14l-4 -4l4 -4M5 10h11a4 4 0 1 1 0 8h-1" />,
  tabler,
);

export const arrowDownIcon = createIcon(
  <path d="M12 5l0 14M18 13l-6 6M6 13l6 6" />,
  tabler,
);

export const sparklesIcon = createIcon(
  <path d="M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6z" />,
  tabler,
);

export const resolvedIcon = createIcon(
  <>
    <path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" />
    <path d="M9 12l2 2l4 -4" />
  </>,
  tabler,
);
