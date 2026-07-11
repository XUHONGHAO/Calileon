export interface LuminaRafScheduler {
  schedule: (callback: FrameRequestCallback) => void;
  cancel: () => void;
  isPending: () => boolean;
}

export const createLuminaRafScheduler = (
  requestFrame: (callback: FrameRequestCallback) => number,
  cancelFrame: (id: number) => void,
): LuminaRafScheduler => {
  let rafId = 0;
  let pendingCallback: FrameRequestCallback | null = null;

  return {
    schedule(callback) {
      pendingCallback = callback;
      if (rafId) {
        return;
      }
      rafId = requestFrame((timestamp) => {
        rafId = 0;
        const callbackForFrame = pendingCallback;
        pendingCallback = null;
        callbackForFrame?.(timestamp);
      });
    },
    cancel() {
      pendingCallback = null;
      if (rafId) {
        cancelFrame(rafId);
        rafId = 0;
      }
    },
    isPending() {
      return rafId !== 0;
    },
  };
};
