import { STORAGE_KEYS } from "../app_constants";

import { generateImagesWithOpenAIAdapter } from "./openAIImageAdapter";
import { submitVideoTask } from "./openAIVideoAdapter";
import { saveAIProxyConfig } from "./proxyConfig";
import { submitTextAgent } from "./textAgentAdapter";
import { generateDiagramCodeWithVisionAgent } from "./visionAgentAdapter";

const gateway = {
  isEnabled: () => true,
  getCatalog: vi.fn(),
  invoke: vi.fn(),
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
    auth: { getAccessToken: async () => "user-access-token" },
    ai: gateway,
  }),
}));

const config = {
  version: 2 as const,
  mode: "managed-gateway" as const,
  endpoint: "",
  accessToken: "",
  gatewayEndpoint: "",
  managedRoutes: {
    "image-generation": "image-route",
    "video-submit": "video-route",
    "text-agent": "text-route",
    "vision-agent": "vision-route",
  },
};

const route = (overrides: Record<string, unknown> = {}) => ({
  id: "route",
  label: "Managed route",
  capability: "text-agent",
  wireProtocol: "openai-chat-sse",
  model: "managed-model",
  costUnits: 1,
  operations: ["stream"],
  ...overrides,
});

describe("managed AI adapters", () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEYS.LOCAL_STORAGE_AI_PROXY);
    saveAIProxyConfig(config);
    vi.clearAllMocks();
    gateway.getAuditConsent.mockResolvedValue({
      deploymentEnabled: false,
      enabled: false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("generates an image from catalog metadata without local provider credentials", async () => {
    gateway.getCatalog.mockResolvedValue([
      route({
        id: "image-route",
        capability: "image-generation",
        wireProtocol: "openai-compatible",
        operations: ["generate"],
      }),
    ]);
    gateway.invoke.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await generateImagesWithOpenAIAdapter({
      config: {
        baseURL: "",
        apiKey: "",
        defaultModel: "",
        models: [],
      },
      mode: "text-to-image",
      model: "ignored-browser-model",
      prompt: "a test image",
      params: { size: "1024x1024", n: 1 },
    });

    expect(result[0].dataURL).toBe("data:image/png;base64,aW1hZ2U=");
    expect(gateway.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        routeId: "image-route",
        operation: "generate",
      }),
    );
    const input = gateway.invoke.mock.calls[0][0] as {
      body: string;
      headers: Headers;
    };
    expect(JSON.parse(input.body)).toMatchObject({ model: "managed-model" });
    expect(input.headers.get("Authorization")).toBeNull();
  });

  it("submits video through the managed route and returns its route id", async () => {
    gateway.getCatalog.mockResolvedValue([
      route({
        id: "video-route",
        capability: "video-submit",
        wireProtocol: "openai-video",
        operations: ["submit"],
      }),
    ]);
    gateway.invoke.mockResolvedValue(
      new Response(JSON.stringify({ id: "video-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await submitVideoTask({
      config: {
        baseURL: "",
        apiKey: "",
        defaultModel: "",
        models: [],
      },
      mode: "text-to-video",
      model: "ignored-browser-model",
      prompt: "a test video",
      params: { size: "", n: 1 },
    });

    expect(result).toMatchObject({
      taskId: "video-1",
      managedRouteId: "video-route",
      model: "managed-model",
    });
    const input = gateway.invoke.mock.calls[0][0] as { headers: Headers };
    expect(input.headers.get("Authorization")).toBeNull();
  });

  it.each([
    {
      protocol: "openai-chat-sse",
      chunk: { choices: [{ delta: { content: "openai" } }] },
    },
    {
      protocol: "anthropic-sse",
      chunk: { delta: { text: "anthropic" } },
    },
    {
      protocol: "gemini-sse",
      chunk: { candidates: [{ content: { parts: [{ text: "gemini" }] } }] },
    },
  ])(
    "streams managed text over the $protocol wire format",
    async ({ protocol, chunk }) => {
      gateway.getCatalog.mockResolvedValue([
        route({
          id: "text-route",
          wireProtocol: protocol,
        }),
      ]);
      gateway.invoke.mockResolvedValue(
        new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );

      const result = await submitTextAgent({
        agent: null,
        messages: [{ role: "user", content: "draw a diagram" }],
      });

      expect(result).toMatchObject({ error: null });
      expect(result.generatedResponse).toBe(
        protocol === "openai-chat-sse"
          ? "openai"
          : protocol === "anthropic-sse"
          ? "anthropic"
          : "gemini",
      );
      const input = gateway.invoke.mock.calls[0][0] as {
        headers: HeadersInit;
        body: string;
      };
      const headers = new Headers(input.headers);
      expect(headers.get("Authorization")).toBeNull();
      expect(headers.get("X-Api-Key")).toBeNull();
      expect(headers.get("X-Goog-Api-Key")).toBeNull();
      const body = JSON.parse(input.body);
      if (protocol.includes("gemini")) {
        expect(body).not.toHaveProperty("model");
      } else {
        expect(body).toMatchObject({ model: "managed-model" });
      }
    },
  );

  it("generates vision output through a managed route without a provider key", async () => {
    gateway.getCatalog.mockResolvedValue([
      route({
        id: "vision-route",
        capability: "vision-agent",
        wireProtocol: "openai-chat",
        operations: ["generate"],
      }),
    ]);
    gateway.invoke.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "```mermaid\ngraph TD\n```" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await generateDiagramCodeWithVisionAgent({
      agent: null,
      image: "data:image/png;base64,AAA",
      texts: "",
      theme: "light",
    });

    expect(result.html).toBe("mermaid\ngraph TD");
    const input = gateway.invoke.mock.calls[0][0] as {
      headers: HeadersInit;
      body: string;
    };
    const headers = new Headers(input.headers);
    expect(headers.get("Authorization")).toBeNull();
    expect(JSON.parse(input.body)).toMatchObject({ model: "managed-model" });
  });
});
