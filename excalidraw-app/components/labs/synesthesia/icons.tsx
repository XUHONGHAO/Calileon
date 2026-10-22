import { createIcon } from "@excalidraw/excalidraw/components/icons";
export const soundIcon = createIcon(
  <path d="M3 10v4m4-8v12m5-15v18m5-15v12m4-8v4" />,
  { width: 24, height: 24 },
);
export const styleIcons = {
  lines: createIcon(<path d="M3 17C8 2 13 22 21 5" />, {
    width: 24,
    height: 24,
  }),
  blocks: createIcon(
    <>
      <rect x="3" y="4" width="10" height="10" />
      <rect x="11" y="12" width="10" height="8" />
    </>,
    { width: 24, height: 24 },
  ),
  stars: createIcon(
    <>
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="8" r="1" />
      <circle cx="12" cy="18" r="3" />
    </>,
    { width: 24, height: 24 },
  ),
};
