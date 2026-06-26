#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const appDir = path.join(repoRoot, "excalidraw-app");
const viteBin = path.join(repoRoot, "node_modules", "vite", "bin", "vite.js");
const logsDir = path.join(repoRoot, "logs");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3010;
const DEFAULT_TIMEOUT_MS = 60000;

const args = process.argv.slice(2);

const readOption = (name, fallback) => {
  const index = args.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  return args[index + 1] ?? fallback;
};

const hasFlag = (name) => args.includes(name);

const command = args.find((arg) => !arg.startsWith("--")) ?? "start";
const host = readOption("--host", DEFAULT_HOST);
const port = Number(readOption("--port", process.env.VITE_APP_PORT ?? DEFAULT_PORT));
const timeoutMs = Number(readOption("--timeout-ms", DEFAULT_TIMEOUT_MS));

const url = `http://${host}:${port}/`;
const pidFile = path.join(logsDir, `codex-vite-${port}.pid`);
const cmdFile = path.join(logsDir, `codex-vite-${port}.cmd`);
const stdoutFile = path.join(logsDir, `codex-vite-${port}.out.log`);
const stderrFile = path.join(logsDir, `codex-vite-${port}.err.log`);

const printUsage = () => {
  console.log(`Usage:
  node scripts/codex-vite-dev.mjs start [--host 127.0.0.1] [--port 3010]
  node scripts/codex-vite-dev.mjs status [--host 127.0.0.1] [--port 3010]
  node scripts/codex-vite-dev.mjs stop [--port 3010]

Starts the Excalidraw Vite app for Codex/browser verification without using
PowerShell Start-Process, which is unreliable when the environment contains
both Path and PATH on Windows.`);
};

const ensureReady = () => {
  if (!fs.existsSync(viteBin)) {
    throw new Error(`Vite binary not found: ${viteBin}`);
  }
  fs.mkdirSync(logsDir, { recursive: true });
};

const requestUrl = () =>
  new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      response.on("end", () => {
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 500,
          statusCode: response.statusCode,
        });
      });
    });

    request.setTimeout(1000, () => {
      request.destroy();
      resolve({ ok: false });
    });

    request.on("error", () => {
      resolve({ ok: false });
    });
  });

const tailFile = (filePath, maxBytes = 4000) => {
  if (!fs.existsSync(filePath)) {
    return "";
  }

  const stats = fs.statSync(filePath);
  const length = Math.min(stats.size, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filePath, "r");
  fs.readSync(fd, buffer, 0, length, stats.size - length);
  fs.closeSync(fd);
  return buffer.toString("utf8");
};

const getPid = () => {
  if (!fs.existsSync(pidFile)) {
    return null;
  }

  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  return Number.isFinite(pid) ? pid : null;
};

const isPidRunning = (pid) => {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const powershellLiteral = (value) =>
  `'${String(value).replaceAll("'", "''")}'`;

const writeWindowsCmdFile = () => {
  const content = `@echo off
setlocal
set "CI=true"
set "BROWSER=none"
set "VITE_APP_PORT=${port}"
cd /d "${appDir}"
"${process.execPath}" "${viteBin}" --host ${host} --port ${port} --strictPort --no-open --clearScreen false > "${stdoutFile}" 2> "${stderrFile}"
`;

  fs.writeFileSync(cmdFile, content, "utf8");
};

const launchWindowsVite = () => {
  writeWindowsCmdFile();

  const psScript = `
$cmdPath = ${powershellLiteral(cmdFile)}
$workingDirectory = ${powershellLiteral(appDir)}
$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
$startup.ShowWindow = 0
$commandLine = 'cmd.exe /d /c "' + $cmdPath + '"'
$result = ([wmiclass]'Win32_Process').Create(
  $commandLine,
  $workingDirectory,
  $startup
)
if ($result.ReturnValue -ne 0) {
  [Console]::Error.WriteLine('WMI returned ' + $result.ReturnValue)
  exit 1
}
[Console]::Out.Write($result.ProcessId)
`;

  const encoded = Buffer.from(psScript, "utf16le").toString("base64");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `WMI launch failed: ${result.stderr || result.stdout || result.status}`,
    );
  }

  const pid = Number(result.stdout.trim());
  if (!Number.isFinite(pid)) {
    throw new Error(`WMI launch did not return a process id: ${result.stdout}`);
  }

  return pid;
};

const launchDirectVite = () => {
  const stdoutFd = fs.openSync(stdoutFile, "a");
  const stderrFd = fs.openSync(stderrFile, "a");

  try {
    const child = spawn(
      process.execPath,
      [
        viteBin,
        "--host",
        host,
        "--port",
        String(port),
        "--strictPort",
        "--no-open",
        "--clearScreen",
        "false",
      ],
      {
        cwd: appDir,
        detached: true,
        stdio: ["ignore", stdoutFd, stderrFd],
        env: {
          ...process.env,
          BROWSER: "none",
          // Vite exits on process.stdin "end" unless CI=true. Background
          // verification starts with stdin closed, so keep the server alive.
          CI: "true",
          VITE_APP_PORT: String(port),
        },
        windowsHide: true,
      },
    );

    return { child, pid: child.pid };
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
};

const terminateProcess = (pid) => {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true,
    });

    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || `taskkill ${pid}`);
    }
    return;
  }

  process.kill(pid);
};

const waitForServer = async ({ child, pid }) => {
  const startTime = Date.now();
  let exitInfo = null;

  child?.once("exit", (code, signal) => {
    exitInfo = { code, signal };
  });

  while (Date.now() - startTime < timeoutMs) {
    const result = await requestUrl();
    if (result.ok) {
      return result;
    }

    if (exitInfo) {
      const stderrTail = tailFile(stderrFile);
      throw new Error(
        `Vite exited before becoming ready (code=${exitInfo.code}, signal=${exitInfo.signal}).` +
          (stderrTail ? `\n\nstderr tail:\n${stderrTail}` : ""),
      );
    }

    if (pid && !isPidRunning(pid)) {
      const stderrTail = tailFile(stderrFile);
      throw new Error(
        `Vite launcher exited before becoming ready (pid=${pid}).` +
          (stderrTail ? `\n\nstderr tail:\n${stderrTail}` : ""),
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for ${url}`);
};

const status = async () => {
  const result = await requestUrl();
  const pid = getPid();

  if (result.ok) {
    console.log(`status=running`);
    console.log(`url=${url}`);
    if (pid) {
      console.log(`pid=${pid}`);
    }
    return;
  }

  console.log(`status=stopped`);
  console.log(`url=${url}`);
  if (pid) {
    if (!isPidRunning(pid)) {
      fs.rmSync(pidFile, { force: true });
    }
    console.log(`pid_file=${pidFile}`);
    console.log(`pid=${pid}`);
  }
};

const start = async () => {
  ensureReady();

  const current = await requestUrl();
  if (current.ok) {
    console.log(`status=running`);
    console.log(`url=${url}`);
    const pid = getPid();
    if (pid) {
      console.log(`pid=${pid}`);
    }
    return;
  }

  fs.rmSync(stdoutFile, { force: true });
  fs.rmSync(stderrFile, { force: true });

  const launcher =
    process.platform === "win32"
      ? { child: null, pid: launchWindowsVite() }
      : launchDirectVite();

  fs.writeFileSync(pidFile, String(launcher.pid));

  try {
    const result = await waitForServer(launcher);
    launcher.child?.unref();
    console.log(`status=running`);
    console.log(`url=${url}`);
    console.log(`pid=${launcher.pid}`);
    console.log(`http_status=${result.statusCode}`);
    console.log(`stdout=${stdoutFile}`);
    console.log(`stderr=${stderrFile}`);
  } catch (error) {
    try {
      terminateProcess(launcher.pid);
    } catch {
      // Ignore cleanup failures after a failed start.
    }
    throw error;
  }
};

const stop = () => {
  const pid = getPid();
  if (!pid) {
    console.log(`status=stopped`);
    return;
  }

  try {
    terminateProcess(pid);
    fs.rmSync(pidFile, { force: true });
    console.log(`status=stopped`);
    console.log(`pid=${pid}`);
  } catch (error) {
    console.log(`status=unknown`);
    console.log(`pid=${pid}`);
    console.log(`message=${error.message}`);
  }
};

try {
  if (hasFlag("--help") || hasFlag("-h")) {
    printUsage();
  } else if (command === "start") {
    await start();
  } else if (command === "status") {
    await status();
  } else if (command === "stop") {
    stop();
  } else {
    printUsage();
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
