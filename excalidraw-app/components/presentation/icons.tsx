import { createIcon } from "@excalidraw/excalidraw/components/icons";

// Tabler outline icons for the presentation surfaces (24px grid, 2px stroke).
const tabler = {
  width: 24,
  height: 24,
  fill: "none",
  strokeWidth: 2,
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export const playIcon = createIcon(<path d="M7 4v16l13 -8z" />, tabler);

export const pauseIcon = createIcon(
  <>
    <path d="M6 5h4v14h-4z" />
    <path d="M14 5h4v14h-4z" />
  </>,
  tabler,
);

export const resetIcon = createIcon(
  <>
    <path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4" />
    <path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />
  </>,
  tabler,
);

export const prevIcon = createIcon(<path d="M15 6l-6 6l6 6" />, tabler);

export const nextIcon = createIcon(<path d="M9 6l6 6l-6 6" />, tabler);

export const moveUpIcon = createIcon(<path d="M6 15l6 -6l6 6" />, tabler);

export const moveDownIcon = createIcon(<path d="M6 9l6 6l6 -6" />, tabler);

export const exitIcon = createIcon(
  <>
    <path d="M18 6l-12 12" />
    <path d="M6 6l12 12" />
  </>,
  tabler,
);

export const presenterIcon = createIcon(
  <>
    <path d="M3 4h18v12h-18z" />
    <path d="M8 20h8" />
    <path d="M12 16v4" />
    <path d="M7 8h6" />
    <path d="M7 12h10" />
  </>,
  tabler,
);

export const laserIcon = createIcon(
  <>
    <path d="M4 20l7 -7" />
    <path d="M14 10m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />
    <path d="M19 5l1 -1" />
    <path d="M14 3v1" />
    <path d="M21 10h-1" />
  </>,
  tabler,
);

export const pdfIcon = createIcon(
  <>
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z" />
    <path d="M12 11v6" />
    <path d="M9.5 14.5l2.5 2.5l2.5 -2.5" />
  </>,
  tabler,
);

export const hiddenIcon = createIcon(
  <>
    <path d="M10.585 10.587a2 2 0 0 0 2.829 2.828" />
    <path d="M16.681 16.673a8.717 8.717 0 0 1 -4.681 1.327c-3.6 0 -6.6 -2 -9 -6c1.272 -2.12 2.712 -3.678 4.32 -4.674m2.86 -1.146a9.055 9.055 0 0 1 1.82 -.18c3.6 0 6.6 2 9 6c-.666 1.11 -1.379 2.067 -2.138 2.87" />
    <path d="M3 3l18 18" />
  </>,
  tabler,
);

export const visibleIcon = createIcon(
  <>
    <path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0" />
    <path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6" />
  </>,
  tabler,
);

export const notesIcon = createIcon(
  <>
    <path d="M5 3m0 2a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2z" />
    <path d="M9 7l6 0" />
    <path d="M9 11l6 0" />
    <path d="M9 15l4 0" />
  </>,
  tabler,
);

export const frameIcon = createIcon(
  <>
    <path d="M4 7l16 0" />
    <path d="M4 17l16 0" />
    <path d="M7 4l0 16" />
    <path d="M17 4l0 16" />
  </>,
  tabler,
);
