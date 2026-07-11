import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const runtimeDir = path.join(repoRoot, "excalidraw-app", "single-file");
const outputDir = path.join(runtimeDir, ".runtime-build");
const publicOutput = path.join(
  repoRoot,
  "public",
  "single-file-runtime-template.txt",
);

await build({
  configFile: path.join(runtimeDir, "vite.config.mts"),
});

const javascript = await fs.readFile(
  path.join(outputDir, "runtime.js"),
  "utf8",
);
let css = "";
try {
  css = await fs.readFile(path.join(outputDir, "style.css"), "utf8");
} catch {
  const files = await fs.readdir(outputDir);
  const cssFile = files.find((file) => file.endsWith(".css"));
  if (cssFile) {
    css = await fs.readFile(path.join(outputDir, cssFile), "utf8");
  }
}

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>Calileon single-file board</title>
    <style id="calileon-single-file-styles">html,body,#root{width:100%;height:100%;margin:0;overflow:hidden}${css.replace(
      /<\/style/gi,
      "<\\/style",
    )}</style>
  </head>
  <body>
    <div id="root"></div>
    <script id="calileon-single-file-payload" type="application/json">__CALILEON_SINGLE_FILE_PAYLOAD__</script>
    <script id="calileon-single-file-runtime">${javascript.replace(
      /<\/script/gi,
      "<\\/script",
    )}</script>
  </body>
</html>`;

if (/url\(["']?https?:/i.test(css)) {
  throw new Error("Single-file runtime CSS contains an external URL");
}

await fs.mkdir(path.dirname(publicOutput), { recursive: true });
await fs.writeFile(publicOutput, html);
await fs.rm(outputDir, { recursive: true, force: true });

const sizeMiB = Buffer.byteLength(html) / 1024 / 1024;
process.stdout.write(`Built single-file runtime: ${sizeMiB.toFixed(2)} MiB\n`);
