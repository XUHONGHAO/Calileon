import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { vi } from "vitest";

import {
  AccountAvatarSettings,
  normalizeAvatarGlyph,
} from "./AccountAvatarSettings";

const authMock = vi.hoisted((): { state: any } => ({ state: null }));

vi.mock("../auth/useCloudAuth", () => ({
  useCloudAuth: () => authMock.state,
}));

// jsdom has no 2d canvas; the preview draws with the bubble's ops
vi.mock("@excalidraw/excalidraw/voice/AudioAvatar", () => ({
  AudioAvatar: ({ avatar, label }: any) => (
    <span
      role="img"
      aria-label={label}
      data-color={avatar.color}
      data-glyph={avatar.glyph}
    />
  ),
}));

const user = (avatar: unknown = null) => ({
  id: "u1",
  displayName: "Ada",
  email: "ada@example.com",
  avatarUrl: null,
  createdAt: 0,
  lastSignInAt: null,
  avatar,
});

const setup = (overrides: Record<string, unknown> = {}) => {
  const updateAvatar = vi.fn(async () => {});
  authMock.state = {
    isSignedIn: true,
    user: user(),
    updateAvatar,
    ...overrides,
  };
  render(<AccountAvatarSettings />);
  return updateAvatar;
};

const preview = () => screen.getByRole("img", { name: "Avatar preview" });
const glyphInput = () =>
  screen.getByRole("textbox", { name: "Character" }) as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: "Save avatar" });

describe("normalizeAvatarGlyph", () => {
  it("keeps the last character and upper-cases letters", () => {
    expect(normalizeAvatarGlyph("a")).toBe("A");
    expect(normalizeAvatarGlyph("AB")).toBe("B");
    expect(normalizeAvatarGlyph(" 山 ")).toBe("山");
    expect(normalizeAvatarGlyph("")).toBe("");
  });
});

describe("AccountAvatarSettings (ADR 0034 §6)", () => {
  it("is hidden when the backend can't store an avatar", () => {
    setup({ updateAvatar: null });
    expect(screen.queryByText("Avatar")).toBeNull();
  });

  it("starts from the default avatar and saves the chosen one", async () => {
    const updateAvatar = setup();
    expect(glyphInput().value).toBe("A");
    expect(preview().dataset.glyph).toBe("A");

    fireEvent.change(glyphInput(), { target: { value: "山" } });
    fireEvent.click(screen.getByRole("radio", { name: "Purple" }));
    expect(preview().dataset.glyph).toBe("山");
    expect(preview().dataset.color).toBe("#8e44ad");
    expect(
      screen
        .getByRole("radio", { name: "Purple" })
        .getAttribute("aria-checked"),
    ).toBe("true");

    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(updateAvatar).toHaveBeenCalledWith({
      color: "#8e44ad",
      glyph: "山",
    });
    expect(screen.getByText("Avatar saved")).toBeTruthy();
  });

  it("rejects digits and symbols", () => {
    setup();
    fireEvent.change(glyphInput(), { target: { value: "7" } });
    expect(screen.getByRole("alert").textContent).toMatch(/one Chinese/);
    expect(saveButton()).toBeDisabled();
    // the preview keeps a valid glyph
    expect(preview().dataset.glyph).toBe("A");
  });

  it("moves through the colors with the arrow keys", () => {
    setup({ user: user({ color: "#1f9e8f", glyph: "K" }) });
    const first = screen.getByRole("radio", { name: "Teal" });
    expect(first.getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(
      screen.getByRole("radio", { name: "Blue" }).getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(
      screen.getByRole("radio", { name: "Slate" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("can go back to the default avatar", async () => {
    const updateAvatar = setup({
      user: user({ color: "#1f9e8f", glyph: "K" }),
    });
    expect(saveButton()).toBeDisabled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Use default" }));
    });
    expect(updateAvatar).toHaveBeenCalledWith(null);
  });

  it("reports a failed save", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    setup({ updateAvatar: vi.fn(async () => Promise.reject(new Error("x"))) });
    fireEvent.change(glyphInput(), { target: { value: "B" } });
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(screen.getByText(/Couldn't save the avatar/)).toBeTruthy();
    consoleError.mockRestore();
  });
});
