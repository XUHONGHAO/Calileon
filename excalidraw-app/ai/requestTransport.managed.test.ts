import { fetchAIRequest } from "./requestTransport";
import { pollVideoTask } from "./openAIVideoAdapter";

const gateway = {
  isEnabled: () => true,
  getCatalog: vi.fn(),
  invoke: vi.fn(async () => new Response("ok")),
  getQuota: vi.fn(),
  getUsage: vi.fn(),
  getAuditConsent: vi.fn(),
  setAuditConsent: vi.fn(),
  createAuditDraft: vi.fn(),
  listAudits: vi.fn(),
  getAudit: vi.fn(),
  deleteAudit: vi.fn(),
  deleteAccountData: vi.fn(),
  createDeviceAuthorization: vi.fn(),
  exchangeDeviceAuthorization: vi.fn(),
  approveDeviceAuthorization: vi.fn(),
};

vi.mock("../data/cloud", () => ({
  getCloudBackend: () => ({
    auth: { getAccessToken: async () => "access-token" },
    ai: gateway,
  }),
}));

const config = {
  version: 2 as const,
  mode: "managed-gateway" as const,
  endpoint: "",
  accessToken: "",
  gatewayEndpoint: "",
  managedRoutes: { "text-agent": "text-route" },
};

describe("managed AI request transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gateway.getAuditConsent.mockResolvedValue({
      deploymentEnabled: true,
      enabled: true,
    });
    gateway.createAuditDraft.mockResolvedValue("audit-1");
  });

  it("creates and binds an opted-in prompt audit draft", async () => {
    await fetchAIRequest(
      "https://provider.example/v1/chat",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hello" }),
      },
      { kind: "text-agent", config, auditPrompt: "hello" },
    );

    expect(gateway.getAuditConsent).toHaveBeenCalledWith({
      accessToken: undefined,
    });
    expect(gateway.createAuditDraft).toHaveBeenCalledWith({
      routeId: "text-route",
      prompt: "hello",
      accessToken: undefined,
    });
    expect(gateway.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        routeId: "text-route",
        auditDraftId: "audit-1",
      }),
    );
  });

  it("does not create an audit draft when deployment or account consent is off", async () => {
    gateway.getAuditConsent.mockResolvedValue({
      deploymentEnabled: true,
      enabled: false,
    });
    await fetchAIRequest(
      "https://provider.example/v1/chat",
      { method: "POST", body: "{}" },
      { kind: "text-agent", config, auditPrompt: "hello" },
    );
    expect(gateway.createAuditDraft).not.toHaveBeenCalled();
    expect(gateway.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ auditDraftId: undefined }),
    );
  });

  it("keeps a persisted managed video task on the gateway after a mode switch", async () => {
    gateway.getCatalog.mockResolvedValue([
      {
        id: "video-poll-route",
        label: "Managed video",
        capability: "video-poll",
        wireProtocol: "openai-video",
        model: "managed-video",
        costUnits: 1,
        operations: ["poll"],
      },
    ]);
    gateway.invoke.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "completed",
          video_url: "https://cdn.example.test/video.mp4",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await pollVideoTask({
      baseURL: "",
      apiKey: "",
      taskId: "video-1",
      config: {
        ...config,
        managedRoutes: {
          ...config.managedRoutes,
          "video-poll": "video-poll-route",
        },
      },
      managedRouteId: "video-poll-route",
    });

    expect(result).toMatchObject({
      status: "completed",
      videoURL: "https://cdn.example.test/video.mp4",
    });
    expect(gateway.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        routeId: "video-poll-route",
        operation: "poll",
        query: { taskId: "video-1", task_id: "video-1" },
      }),
    );
  });
});
