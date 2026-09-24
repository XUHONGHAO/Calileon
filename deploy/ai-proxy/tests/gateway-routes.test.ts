import { GatewayRouter } from "../src/gateway/routes.js";

import type { GatewayDeclarativeConfig } from "../src/gateway/types.js";

const makeConfig = (): GatewayDeclarativeConfig => ({
  version: 1,
  defaultPolicy: "standard",
  policies: [
    {
      id: "standard",
      dailyCredits: 10,
      monthlyCredits: 10,
      requestsPerMinute: 10,
      maxConcurrency: 2,
    },
  ],
  routes: [
    {
      id: "route",
      label: "Route",
      capability: "text-agent",
      wireProtocol: "openai-chat-sse",
      model: "model-a",
      costUnits: 1,
      operations: {
        stream: {
          method: "POST",
          path: "/v1/models/{model}/chat",
          params: { model: "[a-z0-9-]+" },
          queryParams: ["trace"],
          replayable: true,
        },
      },
      candidates: [
        {
          id: "primary",
          baseUrl: "https://provider-a.example.test",
          credentialHeader: "none",
        },
        {
          id: "backup",
          baseUrl: "https://provider-b.example.test",
          credentialHeader: "none",
        },
      ],
    },
  ],
});

describe("managed gateway route policy", () => {
  it("allows only declared operations, path params, and query names", () => {
    const router = new GatewayRouter(makeConfig());
    const route = router.getRoute("route");
    const operation = router.getOperation(route, "stream");
    expect(
      router.buildTarget(
        route.candidates[0],
        operation,
        { model: "model-a" },
        new URLSearchParams("trace=abc&other=secret"),
      ),
    ).toBe("https://provider-a.example.test/v1/models/model-a/chat?trace=abc");
    expect(() => router.getOperation(route, "delete")).toThrow("operation");
    expect(() =>
      router.buildTarget(
        route.candidates[0],
        operation,
        { model: "not safe" },
        new URLSearchParams(),
      ),
    ).toThrow(/Invalid operation parameter/);
    expect(
      router.buildTarget(
        route.candidates[0],
        operation,
        {},
        new URLSearchParams(),
        { model: "model-a" },
      ),
    ).toContain("/models/model-a/");
    expect(() => router.getOperation(route, "toString")).toThrow("operation");
  });

  it("opens a candidate circuit after repeated failures and prefers healthy peers", () => {
    const router = new GatewayRouter(makeConfig());
    const route = router.getRoute("route");
    const [primary, backup] = route.candidates;
    router.markFailure(route, primary);
    router.markFailure(route, primary);
    router.markFailure(route, primary);
    expect(router.candidates(route).map((candidate) => candidate.id)).toEqual([
      "backup",
    ]);
    router.markSuccess(route, backup);
    expect(router.candidates(route).map((candidate) => candidate.id)).toEqual([
      "backup",
    ]);
  });
});
