/**
 * Machine-readable relationship tone stored on ordinary line and arrow
 * elements. Missing data represents the normal, unmodified line style.
 */
export const LINE_TONES = [
  "certain",
  "possible",
  "blocked",
  "questioned",
] as const;

export type LineTone = typeof LINE_TONES[number];

/** Versioned payload persisted at `element.customData.lineTone`. */
export type LineToneData = {
  version: 1;
  tone: LineTone;
};

export type LineToneCustomData = {
  lineTone?: LineToneData;
};
