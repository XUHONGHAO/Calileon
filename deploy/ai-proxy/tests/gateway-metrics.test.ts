import { GatewayMetrics } from "../src/gateway/metrics.js";

describe("managed gateway metrics", () => {
  it("renders bounded operational counters without sensitive labels", () => {
    const metrics = new GatewayMetrics();
    metrics.start();
    metrics.authFailure();
    metrics.upstreamFailure();
    metrics.failover();
    metrics.denyQuota();
    metrics.observeDuration(12);
    metrics.finish("route/private", 503, 128);

    const rendered = metrics.render();
    expect(rendered).toContain("excalidraw_ai_gateway_auth_failures_total 1");
    expect(rendered).toContain(
      "excalidraw_ai_gateway_upstream_failures_total 1",
    );
    expect(rendered).toContain("excalidraw_ai_gateway_failovers_total 1");
    expect(rendered).toContain("excalidraw_ai_gateway_quota_denied_total 1");
    expect(rendered).toContain(
      "excalidraw_ai_gateway_response_duration_ms_total 12",
    );
    expect(rendered).toContain(
      'excalidraw_ai_gateway_requests_total{route="route_private",status="503"} 1',
    );
    expect(rendered).not.toContain("private prompt");
  });

  it("ignores invalid duration observations", () => {
    const metrics = new GatewayMetrics();
    metrics.observeDuration(Number.NaN);
    metrics.observeDuration(-1);
    expect(metrics.render()).toContain(
      "excalidraw_ai_gateway_response_duration_ms_total 0",
    );
  });
});
