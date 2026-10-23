import { createIcon } from "@excalidraw/excalidraw/components/icons";

// Line icons on a 24-unit grid. Without fill="none" + stroke they render as
// solid black blobs.
const lineIconProps = {
  width: 24,
  height: 24,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export const soundIcon = createIcon(
  <path d="M3 10v4m4-8v12m5-15v18m5-15v12m4-8v4" />,
  lineIconProps,
);
export const styleIcons = {
  lines: createIcon(<path d="M3 17C8 2 13 22 21 5" />, lineIconProps),
  blocks: createIcon(
    <>
      <rect x="3" y="4" width="10" height="10" rx="1.5" />
      <rect x="11" y="12" width="10" height="8" rx="1.5" />
    </>,
    lineIconProps,
  ),
  stars: createIcon(
    <>
      <circle cx="6" cy="6" r="1.5" fill="currentColor" />
      <circle cx="18" cy="8" r="1" fill="currentColor" />
      <circle cx="12" cy="17" r="2.5" />
      <path d="M6 6l6 11M18 8l-6 9" strokeDasharray="1 2.5" />
    </>,
    lineIconProps,
  ),
};
