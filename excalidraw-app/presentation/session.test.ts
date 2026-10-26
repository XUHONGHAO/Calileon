import { vi } from "vitest";

import {
  dismissPresenterBlocked,
  forgetPresenterWindow,
  getPresentationSession,
  getPresenterViewPreference,
  isPresenting,
  openPresenterView,
  setPresenterViewPreference,
  startPresentation,
  stopPresentation,
} from "./session";

import type { MockInstance } from "vitest";

const fakePopup = () =>
  ({
    closed: false,
    close: vi.fn(function (this: { closed: boolean }) {
      this.closed = true;
    }),
    focus: vi.fn(),
  } as unknown as Window & { close: ReturnType<typeof vi.fn> });

describe("presentation session (ADR 0036 §3)", () => {
  let open: MockInstance<typeof window.open>;
  let requestFullscreen: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    open = vi.spyOn(window, "open").mockReturnValue(null);
    requestFullscreen = vi.fn(() => Promise.resolve());
    document.documentElement.requestFullscreen = requestFullscreen as any;
  });

  afterEach(() => {
    stopPresentation();
    open.mockRestore();
    delete (document.documentElement as any).requestFullscreen;
  });

  it("starts once, in fullscreen, and stops", () => {
    startPresentation({ startFrameId: "f1" });
    const session = getPresentationSession()!;
    expect(session).toMatchObject({
      startFrameId: "f1",
      requestedFullscreen: true,
      presenterWindow: null,
      presenterBlocked: false,
    });
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();

    startPresentation({ startFrameId: "other" });
    expect(getPresentationSession()).toBe(session);

    stopPresentation();
    expect(isPresenting()).toBe(false);
  });

  it("gives each run a new id", () => {
    startPresentation({});
    const first = getPresentationSession()!.id;
    stopPresentation();
    startPresentation({});
    expect(getPresentationSession()!.id).toBeGreaterThan(first);
  });

  it("does not fail without the Fullscreen API", () => {
    delete (document.documentElement as any).requestFullscreen;
    startPresentation({});
    expect(getPresentationSession()!.requestedFullscreen).toBe(false);
  });

  it("opens the presenter popup and closes it on stop", () => {
    const popup = fakePopup();
    open.mockReturnValue(popup);
    startPresentation({ presenterView: true });
    expect(open).toHaveBeenCalledWith(
      "",
      "calileon-presenter",
      expect.stringContaining("popup"),
    );
    expect(getPresentationSession()!.presenterWindow).toBe(popup);
    stopPresentation();
    expect(popup.close).toHaveBeenCalled();
  });

  it("reports a blocked popup, and lets the user retry", () => {
    startPresentation({ presenterView: true });
    expect(getPresentationSession()!.presenterBlocked).toBe(true);
    dismissPresenterBlocked();
    expect(getPresentationSession()!.presenterBlocked).toBe(false);

    const popup = fakePopup();
    open.mockReturnValue(popup);
    openPresenterView();
    expect(getPresentationSession()!.presenterWindow).toBe(popup);

    // already open: focus it instead of opening another
    openPresenterView();
    expect(popup.focus).toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("keeps the show going when the presenter closes the popup", () => {
    const popup = fakePopup();
    open.mockReturnValue(popup);
    startPresentation({ presenterView: true });
    forgetPresenterWindow();
    expect(isPresenting()).toBe(true);
    expect(getPresentationSession()!.presenterWindow).toBeNull();
    expect(popup.close).not.toHaveBeenCalled();
  });

  it("remembers the presenter view preference on this device", () => {
    setPresenterViewPreference(true);
    expect(getPresenterViewPreference()).toBe(true);
    expect(localStorage.getItem("calileon-presenter-view")).toBe("on");
    setPresenterViewPreference(false);
    expect(localStorage.getItem("calileon-presenter-view")).toBe("off");
  });
});
