// Rasterize SVG/HTML files with the locally installed headless Chrome/Edge.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

const chrome = () => {
  const found = CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error("No Chrome/Edge found; set CHROME_PATH");
  }
  return found;
};

/**
 * Render `svg` markup to a PNG of `w`x`h`. The SVG is placed in a page with a
 * transparent background (unless `background` is given) and scaled to fill.
 */
export const renderPng = (svg, outFile, w, h = w, background = null) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "calileon-brand-"));
  const html = path.join(tmp, "page.html");
  fs.writeFileSync(
    html,
    `<!doctype html><html><head><style>html,body{margin:0;padding:0;` +
      `background:${background ?? "transparent"};overflow:hidden}` +
      `svg{display:block;width:${w}px;height:${h}px}</style></head>` +
      `<body>${svg}</body></html>`,
  );
  const profile = path.join(tmp, "profile");
  execFileSync(
    chrome(),
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      `--user-data-dir=${profile}`,
      "--default-background-color=00000000",
      `--window-size=${w},${h}`,
      `--screenshot=${path.resolve(outFile)}`,
      pathToFileURL(html).href,
    ],
    { stdio: "ignore" },
  );
  fs.rmSync(tmp, { recursive: true, force: true });
};
