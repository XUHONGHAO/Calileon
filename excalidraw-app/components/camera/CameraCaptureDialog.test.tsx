import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";

import { getMicLockOwner } from "@excalidraw/excalidraw/voice/micLock";

import { CameraCaptureDialog } from "./CameraCaptureDialog";
import {
  CAMERA_PREFS_KEY,
  closeCameraCapture,
  isCameraCaptureOpen,
  loadCameraPrefs,
  openCameraCapture,
} from "./cameraState";

vi.mock("@excalidraw/excalidraw/components/Dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

// jsdom can't decode frames: stub the canvas grabs, keep the rest real
vi.mock("./recorder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./recorder")>();
  return {
    ...actual,
    capturePhoto: vi.fn(
      async () => new File(["jpeg"], "photo.jpg", { type: "image/jpeg" }),
    ),
    capturePoster: vi.fn(() => "data:image/webp;base64,UklGRg=="),
    getVideoDimensions: vi.fn(() => ({ width: 1280, height: 720 })),
  };
});

const createTrack = (kind: "video" | "audio") => ({
  kind,
  stop: vi.fn(),
  onended: null as null | (() => void),
  getSettings: () =>
    kind === "video" ? { deviceId: "cam-1", facingMode: "user" } : {},
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
});

const createEnv = (
  opts: { getUserMedia?: () => Promise<any>; policy?: boolean } = {},
) => {
  let time = 0;
  const camTrack = createTrack("video");
  const micTrack = createTrack("audio");
  const streamOf = (track: ReturnType<typeof createTrack>) => ({
    getTracks: () => [track],
    getVideoTracks: () => (track.kind === "video" ? [track] : []),
    getAudioTracks: () => (track.kind === "audio" ? [track] : []),
  });
  class FakeRecorder {
    static isTypeSupported = (type: string) => type === "video/mp4";
    state: RecordingState = "inactive";
    mimeType = "video/mp4";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstart: (() => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public stream: any) {}
    start() {
      this.state = "recording";
      this.onstart?.();
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["frames"]) });
      this.onstop?.();
    }
  }
  class FakeStream {
    constructor(public tracks: unknown[]) {}
  }
  return {
    camTrack,
    micTrack,
    advance: (ms: number) => {
      time += ms;
    },
    env: {
      mediaDevices: {
        getUserMedia: vi.fn(
          opts.getUserMedia ??
            (async (constraints: MediaStreamConstraints) =>
              constraints.video ? streamOf(camTrack) : streamOf(micTrack)),
        ) as unknown as MediaDevices["getUserMedia"],
        enumerateDevices: async () =>
          [
            { kind: "videoinput", deviceId: "cam-1", label: "Front camera" },
          ] as MediaDeviceInfo[],
      },
      MediaRecorder: FakeRecorder as any,
      MediaStream: FakeStream as any,
      isSecureContext: true,
      isAllowedByPolicy: () => opts.policy ?? true,
      now: () => time,
    },
  };
};

const createAPI = () => ({
  insertPhoto: vi.fn(async () => {}),
  insertVideoRecording: vi.fn(async () => "video-1"),
  setToast: vi.fn(),
});

const renderDialog = (
  props: {
    env?: ReturnType<typeof createEnv>["env"];
    videoBlockedReason?: string | null;
  } = {},
) => {
  const api = createAPI();
  const onClose = vi.fn();
  const harness = createEnv();
  const env = props.env ?? harness.env;
  render(
    <CameraCaptureDialog
      excalidrawAPI={api as any}
      videoBlockedReason={props.videoBlockedReason ?? null}
      onClose={onClose}
      env={env}
    />,
  );
  return { api, onClose, harness };
};

const waitForLive = () =>
  waitFor(() => expect(screen.getByTestId("camera-preview")).toBeVisible());

describe("CameraCaptureDialog (ADR 0035 §5)", () => {
  beforeAll(() => {
    // jsdom has no media playback or blob URLs
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: () => Promise.resolve(),
    });
    URL.createObjectURL = vi.fn(() => "blob:take");
    URL.revokeObjectURL = vi.fn();
  });

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens the camera without the microphone and lists devices", async () => {
    const { harness } = renderDialog();
    await waitForLive();
    expect(screen.getByTestId("camera-take-photo")).toBeEnabled();
    expect(harness.env.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(harness.env.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      video: expect.any(Object),
    });
    await waitFor(() =>
      expect(screen.getByTestId("camera-device-select")).toHaveTextContent(
        "Front camera",
      ),
    );
  });

  it("takes a photo, reviews it unmirrored and adds it to the canvas", async () => {
    const { api, onClose } = renderDialog();
    await waitForLive();
    fireEvent.click(screen.getByTestId("camera-take-photo"));
    await screen.findByTestId("camera-review-photo");
    expect(screen.getByTestId("camera-preview")).not.toBeVisible();
    expect(
      screen.getByText("Saved with true left and right, as others see you."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("camera-insert"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.insertPhoto).toHaveBeenCalledWith(expect.any(File));
    expect(api.setToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Photo added" }),
    );
  });

  it("records a clip and inserts it with its poster", async () => {
    localStorage.setItem(CAMERA_PREFS_KEY, JSON.stringify({ mode: "video" }));
    const { api, harness, onClose } = renderDialog();
    await waitForLive();
    fireEvent.click(screen.getByTestId("camera-start-recording"));
    await screen.findByTestId("camera-stop-recording");
    harness.advance(3_000);
    fireEvent.click(screen.getByTestId("camera-stop-recording"));
    await screen.findByTestId("camera-review-video");
    // the camera light goes off during review
    expect(harness.camTrack.stop).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("camera-insert"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.insertVideoRecording).toHaveBeenCalledWith({
      blob: expect.any(Blob),
      mimeType: "video/mp4",
      duration: 3_000,
      naturalWidth: 1280,
      naturalHeight: 720,
      hasAudio: false,
      poster: "data:image/webp;base64,UklGRg==",
    });
    expect(getMicLockOwner()).toBeNull();
  });

  it("keeps a too-short take off the canvas", async () => {
    localStorage.setItem(CAMERA_PREFS_KEY, JSON.stringify({ mode: "video" }));
    const { harness, api } = renderDialog();
    await waitForLive();
    fireEvent.click(screen.getByTestId("camera-start-recording"));
    await screen.findByTestId("camera-stop-recording");
    harness.advance(400);
    fireEvent.click(screen.getByTestId("camera-stop-recording"));
    await screen.findByText("Too short. Record at least one second.");
    expect(screen.getByTestId("camera-start-recording")).toBeInTheDocument();
    expect(api.insertVideoRecording).not.toHaveBeenCalled();
  });

  it("falls back to photos while recordings are blocked", async () => {
    localStorage.setItem(CAMERA_PREFS_KEY, JSON.stringify({ mode: "video" }));
    renderDialog({ videoBlockedReason: "No recordings in live rooms." });
    await waitForLive();
    expect(screen.getByTestId("camera-take-photo")).toBeInTheDocument();
    expect(screen.queryByTestId("camera-start-recording")).toBeNull();
    expect(screen.getByRole("radio", { name: "Video" })).toBeDisabled();
    expect(
      screen.getByText("No recordings in live rooms."),
    ).toBeInTheDocument();
    // the saved preference is kept for when recordings are allowed again
    expect(loadCameraPrefs().mode).toBe("video");
  });

  it("explains a denied permission and offers a retry", async () => {
    const denied = createEnv({
      getUserMedia: async () => {
        throw Object.assign(new Error(""), { name: "NotAllowedError" });
      },
    });
    renderDialog({ env: denied.env });
    await screen.findByText(/Camera permission was denied/);
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  it("offers no retry when the site policy blocks the camera", async () => {
    renderDialog({ env: createEnv({ policy: false }).env });
    await screen.findByText("Camera access is blocked for this site.");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("asks before throwing a reviewed take away", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { onClose } = renderDialog();
    await waitForLive();
    fireEvent.click(screen.getByTestId("camera-take-photo"));
    await screen.findByTestId("camera-review-photo");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("closes without asking when nothing was captured", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const { onClose, harness } = renderDialog();
    await waitForLive();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(confirm).not.toHaveBeenCalled();
    expect(harness.camTrack.stop).not.toHaveBeenCalled();
  });

  it("drops a running recording when the page is hidden", async () => {
    localStorage.setItem(CAMERA_PREFS_KEY, JSON.stringify({ mode: "video" }));
    const { harness } = renderDialog();
    await waitForLive();
    fireEvent.click(screen.getByTestId("camera-start-recording"));
    await screen.findByTestId("camera-stop-recording");
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await screen.findByText("Recording stopped because the page was hidden.");
    expect(harness.camTrack.stop).toHaveBeenCalled();
    expect(screen.queryByTestId("camera-stop-recording")).toBeNull();
    visibility.mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitForLive();
  });

  it("runs the countdown before taking the photo", async () => {
    localStorage.setItem(CAMERA_PREFS_KEY, JSON.stringify({ countdown: 3 }));
    renderDialog();
    await waitForLive();
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByTestId("camera-take-photo"));
      expect(screen.getByTestId("camera-countdown")).toHaveTextContent("3");
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(screen.getByTestId("camera-countdown")).toHaveTextContent("2");
      // each tick is scheduled after the previous one commits
      const tick = () => vi.advanceTimersByTime(1_000);
      act(tick);
      act(tick);
      expect(screen.queryByTestId("camera-countdown")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    await screen.findByTestId("camera-review-photo");
  });
});

describe("camera open flag", () => {
  it("opens and closes once", () => {
    expect(isCameraCaptureOpen()).toBe(false);
    openCameraCapture();
    expect(isCameraCaptureOpen()).toBe(true);
    closeCameraCapture();
    expect(isCameraCaptureOpen()).toBe(false);
  });
});
