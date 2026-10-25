import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { STORAGE_KEYS } from "../app_constants";

import { AISettings } from "./AISettings";

const gateway = {
  isEnabled: () => true,
  getCatalog: vi.fn(async () => [
    {
      id: "route-1",
      capability: "image-generation",
      label: "Route one",
      model: "model-1",
    },
  ]),
  getQuota: vi.fn(async () => ({
    daily: { used: 1, limit: 10 },
    monthly: { used: 2, limit: 100 },
  })),
  getUsage: vi.fn(async () => []),
  getAuditConsent: vi.fn(async () => ({
    deploymentEnabled: true,
    enabled: false,
  })),
  listAudits: vi.fn(async () => []),
  setAuditConsent: vi.fn(),
  approveDeviceAuthorization: vi.fn(),
};

vi.mock("../data/cloud", () => ({
  getCloudBackend: () => ({
    auth: { getCurrentUser: async () => ({ id: "user-1" }) },
    ai: gateway,
  }),
}));

// A custom gateway endpoint goes through createHttpAiGateway; route it to the
// same mock so the test can count fetches for either path.
// A new object per call, like the real factory, so rebuilding the gateway on
// every keystroke would show up as extra fetches.
vi.mock("../data/cloud/HttpAiGateway", () => ({
  createHttpAiGateway: () => ({ ...gateway }),
}));

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("AISettings managed gateway", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_AI_PROXY,
      JSON.stringify({
        version: 2,
        mode: "managed-gateway",
        endpoint: "",
        accessToken: "",
        gatewayEndpoint: "https://gateway.example.com/ai-gateway/v1",
        managedRoutes: {},
      }),
    );
    vi.clearAllMocks();
  });

  it("does not refetch or flash loading while the endpoint field is edited", async () => {
    render(<AISettings initialTab="network" />);

    await screen.findByText(/Allow encrypted prompt audit records/);
    expect(gateway.getCatalog).toHaveBeenCalledTimes(1);

    const endpoint = screen.getByLabelText(/Gateway endpoint/i);
    for (const value of ["https://g", "https://ga", "https://gateway.other"]) {
      fireEvent.change(endpoint, { target: { value } });
    }
    // Any refetch would start after an awaited auth lookup; let it run.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(
      screen.queryByText("Loading managed gateway account and catalog..."),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Allow encrypted prompt audit records/),
    ).toBeInTheDocument();
    expect(gateway.getCatalog).toHaveBeenCalledTimes(1);
  });

  it("keeps device approval and audit consent single-flight while pending", async () => {
    const approval = deferred();
    gateway.approveDeviceAuthorization.mockReturnValue(approval.promise);
    const consent = deferred();
    gateway.setAuditConsent.mockReturnValue(consent.promise);
    render(<AISettings initialTab="network" />);

    await screen.findByText(/Allow encrypted prompt audit records/);
    fireEvent.change(screen.getByLabelText("Single-file device code"), {
      target: { value: "ABCD-1234" },
    });
    const approve = screen.getByRole("button", { name: "Approve device" });
    fireEvent.click(approve);
    fireEvent.click(approve);
    expect(gateway.approveDeviceAuthorization).toHaveBeenCalledTimes(1);
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute("aria-busy", "true");

    approval.resolve();
    await waitFor(() => expect(approve).not.toHaveAttribute("aria-busy"));

    const checkbox = screen.getByRole("checkbox", {
      name: /Allow encrypted prompt audit records/,
    });
    fireEvent.click(checkbox);
    expect(gateway.setAuditConsent).toHaveBeenCalledWith(true);
    expect(checkbox).toBeDisabled();

    // A failed update leaves the box as it was.
    consent.reject(new Error("offline"));
    await waitFor(() => expect(checkbox).not.toBeDisabled());
    expect(checkbox).not.toBeChecked();
  });
});
