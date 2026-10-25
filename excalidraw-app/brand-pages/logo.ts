import {
  CALILEON_GRADIENT,
  CALILEON_MARK_EYE,
  CALILEON_MARK_PATH,
  CALILEON_MARK_VIEWBOX,
  CALILEON_WORDMARK_EMBOLDEN,
  CALILEON_WORDMARK_PATH,
  CALILEON_WORDMARK_VIEWBOX,
} from "@excalidraw/excalidraw/components/calileonLogoPaths";

const SVG_NS = "http://www.w3.org/2000/svg";

const svgEl = (tag: string, attrs: Record<string, string | number>) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) {
    el.setAttribute(name, String(value));
  }
  return el;
};

let logoCount = 0;

/**
 * Calileon lockup built from the generated path data (scripts/brand), so the
 * brand pages stay in step with the in-app logo without loading React.
 */
export const createBrandLogo = (): SVGSVGElement[] => {
  // unique per instance: a shared gradient id breaks if the first copy hides
  const gradientId = `brand-logo-gradient-${++logoCount}`;

  const mark = svgEl("svg", {
    viewBox: CALILEON_MARK_VIEWBOX,
    class: "brand-logo__mark",
    "aria-hidden": "true",
    focusable: "false",
  }) as SVGSVGElement;
  const defs = svgEl("defs", {});
  const gradient = svgEl("linearGradient", {
    id: gradientId,
    x1: 420,
    y1: 70,
    x2: 120,
    y2: 470,
    gradientUnits: "userSpaceOnUse",
  });
  for (const [offset, color] of CALILEON_GRADIENT) {
    const stop = svgEl("stop", { offset });
    // the tail stop follows the theme, like ExcalidrawLogo does
    stop.setAttribute(
      "style",
      `stop-color: ${
        offset === 1 ? `var(--color-logo-tail, ${color})` : color
      }`,
    );
    gradient.appendChild(stop);
  }
  defs.appendChild(gradient);
  mark.append(
    defs,
    svgEl("path", { d: CALILEON_MARK_PATH, fill: `url(#${gradientId})` }),
    svgEl("circle", {
      cx: CALILEON_MARK_EYE.cx,
      cy: CALILEON_MARK_EYE.cy,
      r: CALILEON_MARK_EYE.r,
      fill: "#fff",
    }),
    svgEl("circle", {
      cx: CALILEON_MARK_EYE.cx,
      cy: CALILEON_MARK_EYE.cy,
      r: CALILEON_MARK_EYE.pupil,
      fill: CALILEON_GRADIENT[3][1],
    }),
  );

  const wordmark = svgEl("svg", {
    viewBox: CALILEON_WORDMARK_VIEWBOX,
    class: "brand-logo__wordmark",
    role: "img",
    "aria-label": "Calileon",
  }) as SVGSVGElement;
  wordmark.appendChild(
    svgEl("path", {
      d: CALILEON_WORDMARK_PATH,
      fill: "currentColor",
      stroke: "currentColor",
      "stroke-width": CALILEON_WORDMARK_EMBOLDEN,
      "stroke-linejoin": "round",
    }),
  );

  return [mark, wordmark];
};
