import { ExcalidrawFontFace } from "./ExcalidrawFontFace";

// `window.EXCALIDRAW_ASSET_PATH` is pinned to a file:// base in setupTests.ts.
describe("ExcalidrawFontFace urls", () => {
  const uri = "/fonts/Excalifont/Excalifont-Regular.woff2";
  const ownUrl = new URL(
    "fonts/Excalifont/Excalifont-Regular.woff2",
    window.EXCALIDRAW_ASSET_PATH as string,
  ).toString();

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back to esm.sh after the configured asset path", () => {
    const urls = new ExcalidrawFontFace("Excalifont", uri).urls.map(String);

    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe(ownUrl);
    expect(urls[1]).toMatch(/^https:\/\/esm\.sh\//);
  });

  it("serves bundled fonts only from the asset path when self-hosted", () => {
    vi.stubEnv("VITE_APP_SELF_HOSTED", "true");

    const urls = new ExcalidrawFontFace("Excalifont", uri).urls.map(String);

    expect(urls).toEqual([ownUrl]);
  });

  it("keeps absolute font urls untouched when self-hosted", () => {
    vi.stubEnv("VITE_APP_SELF_HOSTED", "true");

    const urls = new ExcalidrawFontFace(
      "Custom",
      "https://fonts.example.com/custom.woff2",
    ).urls.map(String);

    expect(urls).toEqual(["https://fonts.example.com/custom.woff2"]);
  });
});
