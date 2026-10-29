import {
  readDiagnosticResponseHeaders,
  readProviderResponseBody,
  summarizeRequestBody,
} from "./requestDiagnostics";

describe("AI request diagnostics", () => {
  it("summarizes JSON bodies: scalars verbatim, prompts and images as sizes", () => {
    expect(
      summarizeRequestBody(
        JSON.stringify({
          model: "nano-banana-fast",
          prompt: "a cat on a mat",
          size: "1:1",
          imageSize: "1K",
          async: true,
          image: ["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"],
        }),
      ),
    ).toEqual({
      format: "json",
      body: {
        model: "nano-banana-fast",
        prompt: "[string, 14 chars]",
        size: "1:1",
        imageSize: "1K",
        async: true,
        image: ["[string, 26 chars]", "[string, 26 chars]"],
      },
    });
  });

  it("summarizes multipart bodies without file contents", () => {
    const body = new FormData();
    body.append("model", "gpt-image-1");
    body.append("prompt", "edit this");
    body.append("image[]", new Blob(["xx"], { type: "image/png" }), "a.png");

    expect(summarizeRequestBody(body)).toEqual({
      format: "multipart",
      fields: [
        { model: "gpt-image-1" },
        { prompt: "[string, 9 chars]" },
        { "image[]": "[file image/png, 2 bytes]" },
      ],
    });
  });

  it("keeps non-JSON response bodies as truncated raw text", async () => {
    const html = `<html>${"x".repeat(3000)}</html>`;
    const result = await readProviderResponseBody(
      new Response(html, { status: 502 }),
    );

    expect(result.json).toEqual({});
    expect(result.rawBody?.length).toBe(2003);
    expect(result.rawBody?.startsWith("<html>")).toBe(true);
  });

  it("parses JSON response bodies and treats empty bodies as {}", async () => {
    await expect(
      readProviderResponseBody(new Response('{"error":"bad"}')),
    ).resolves.toEqual({ json: { error: "bad" } });
    await expect(readProviderResponseBody(new Response(""))).resolves.toEqual({
      json: {},
    });
  });

  it("reads only the allow-listed response headers", () => {
    const response = new Response("", {
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": "req-1",
        "Set-Cookie": "session=secret",
      },
    });

    expect(readDiagnosticResponseHeaders(response)).toEqual({
      "content-type": "application/json",
      "x-request-id": "req-1",
    });
  });
});
