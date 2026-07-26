import { buildUpstreamRequestHeaders } from "../src/headers.js";

describe("AI proxy request headers", () => {
  const target = new URL("https://provider.example/v1/generate");

  it("preserves provider headers for the original target", () => {
    const headers = buildUpstreamRequestHeaders(
      {
        accept: "application/json",
        authorization: "Bearer provider-key",
        connection: "x-hop-request",
        "x-api-key": "provider-key",
        "x-custom-provider": "provider-value",
        "x-hop-request": "remove-me",
      },
      target,
      true,
      true,
    );

    expect(headers).toMatchObject({
      accept: "application/json",
      authorization: "Bearer provider-key",
      "x-api-key": "provider-key",
      "x-custom-provider": "provider-value",
      host: "provider.example",
      "user-agent": "Excalidraw-AI-Proxy/1",
    });
    expect(headers["x-hop-request"]).toBeUndefined();
  });

  it("strips credential-like and custom x-headers after a cross-origin redirect", () => {
    const headers = buildUpstreamRequestHeaders(
      {
        accept: "application/octet-stream",
        range: "bytes=0-1023",
        authorization: "Bearer provider-key",
        "api-key": "provider-key",
        "client-token": "provider-token",
        "request-signature": "provider-signature",
        "x-custom-provider": "possibly-sensitive",
      },
      target,
      false,
      false,
    );

    expect(headers.accept).toBe("application/octet-stream");
    expect(headers.range).toBe("bytes=0-1023");
    expect(headers.authorization).toBeUndefined();
    expect(headers["api-key"]).toBeUndefined();
    expect(headers["client-token"]).toBeUndefined();
    expect(headers["request-signature"]).toBeUndefined();
    expect(headers["x-custom-provider"]).toBeUndefined();
  });
});
