/**
 * One microphone session at a time across the editor and the host app
 * (voice tool, text-box speech input, Synesthesia; ADR 0034 §4).
 *
 * A busy lock refuses new owners instead of preempting the holder, so a
 * running recording is never cut off by another feature.
 */

let holder: { owner: string } | null = null;

/** returns a release callback, or `null` when another owner holds the mic */
export const acquireMicLock = (owner: string): (() => void) | null => {
  if (holder) {
    return null;
  }
  const token = { owner };
  holder = token;
  return () => {
    if (holder === token) {
      holder = null;
    }
  };
};

export const getMicLockOwner = () => holder?.owner ?? null;
