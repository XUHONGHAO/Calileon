import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import { Provider, appJotaiStore } from "../app-jotai";

import { AIDeviceApproval, getAIDeviceApprovalCode } from "./AIDeviceApproval";

const authState = {
  isAuthAvailable: true,
  status: "signed-in" as const,
  user: {
    id: "user-1",
    email: "user@example.com",
    displayName: null,
    avatarUrl: null,
    createdAt: 0,
    lastSignInAt: null,
  },
  signIn: vi.fn(async () => undefined),
  signOut: vi.fn(async () => undefined),
  isSignedIn: true,
};
const approveDeviceAuthorization = vi.fn(async () => undefined);

vi.mock("../auth/useCloudAuth", () => ({
  useCloudAuth: () => authState,
}));

vi.mock("../data/cloud", () => ({
  getCloudBackend: () => ({
    capabilities: { auth: true, aiGateway: true },
    ai: {
      isEnabled: () => true,
      approveDeviceAuthorization,
    },
  }),
}));

const renderPage = () =>
  render(
    <Provider store={appJotaiStore}>
      <AIDeviceApproval />
    </Provider>,
  );

describe("AIDeviceApproval", () => {
  beforeEach(() => {
    approveDeviceAuthorization.mockClear();
    window.history.replaceState({}, "", "/ai-device?code=abcd-efgh");
  });

  it("normalizes the verification query code", () => {
    expect(getAIDeviceApprovalCode("?code= abcd-efgh ")).toBe("ABCD-EFGH");
    expect(getAIDeviceApprovalCode("?other=value")).toBe("");
  });

  it("lets a signed-in user explicitly approve the displayed code", async () => {
    renderPage();
    expect(screen.getByLabelText("Device code")).toHaveValue("ABCD-EFGH");

    fireEvent.click(screen.getByRole("button", { name: "Approve device" }));

    await waitFor(() => {
      expect(approveDeviceAuthorization).toHaveBeenCalledWith("ABCD-EFGH");
    });
    expect(
      await screen.findByText(
        "Device approved. You can return to the single-file window.",
      ),
    ).toBeInTheDocument();
  });
});
