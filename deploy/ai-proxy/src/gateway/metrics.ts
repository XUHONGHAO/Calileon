const sanitizeLabel = (value: string) =>
  value.replace(/[^a-zA-Z0-9_.:-]/g, "_");

export class GatewayMetrics {
  private requests = new Map<string, number>();
  private quotaDenied = 0;
  private failovers = 0;
  private authFailures = 0;
  private upstreamFailures = 0;
  private active = 0;
  private responseBytes = 0;
  private responseDurationMs = 0;
  private completedResponses = 0;

  start() {
    this.active += 1;
  }

  finish(routeId: string, status: number, bytes: number) {
    this.active = Math.max(0, this.active - 1);
    this.responseBytes += bytes;
    this.completedResponses += 1;
    const key = `${sanitizeLabel(routeId)}|${status}`;
    this.requests.set(key, (this.requests.get(key) || 0) + 1);
  }

  observeDuration(durationMs: number) {
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      this.responseDurationMs += durationMs;
    }
  }

  denyQuota() {
    this.quotaDenied += 1;
  }

  failover() {
    this.failovers += 1;
  }

  authFailure() {
    this.authFailures += 1;
  }

  upstreamFailure() {
    this.upstreamFailures += 1;
  }

  render() {
    const lines = [
      "# TYPE excalidraw_ai_gateway_active_requests gauge",
      `excalidraw_ai_gateway_active_requests ${this.active}`,
      "# TYPE excalidraw_ai_gateway_quota_denied_total counter",
      `excalidraw_ai_gateway_quota_denied_total ${this.quotaDenied}`,
      "# TYPE excalidraw_ai_gateway_failovers_total counter",
      `excalidraw_ai_gateway_failovers_total ${this.failovers}`,
      "# TYPE excalidraw_ai_gateway_auth_failures_total counter",
      `excalidraw_ai_gateway_auth_failures_total ${this.authFailures}`,
      "# TYPE excalidraw_ai_gateway_upstream_failures_total counter",
      `excalidraw_ai_gateway_upstream_failures_total ${this.upstreamFailures}`,
      "# TYPE excalidraw_ai_gateway_response_bytes_total counter",
      `excalidraw_ai_gateway_response_bytes_total ${this.responseBytes}`,
      "# TYPE excalidraw_ai_gateway_response_duration_ms_total counter",
      `excalidraw_ai_gateway_response_duration_ms_total ${this.responseDurationMs}`,
      "# TYPE excalidraw_ai_gateway_completed_responses_total counter",
      `excalidraw_ai_gateway_completed_responses_total ${this.completedResponses}`,
      "# TYPE excalidraw_ai_gateway_requests_total counter",
    ];
    for (const [key, value] of this.requests) {
      const [route, status] = key.split("|");
      lines.push(
        `excalidraw_ai_gateway_requests_total{route="${route}",status="${status}"} ${value}`,
      );
    }
    return `${lines.join("\n")}\n`;
  }
}
