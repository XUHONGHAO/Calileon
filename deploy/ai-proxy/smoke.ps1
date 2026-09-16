[CmdletBinding()]
param(
  [ValidateSet("check", "up", "smoke", "down")]
  [string]$Action = "smoke",
  [int]$Port = 8787
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$composeFile = Join-Path $PSScriptRoot "compose.yml"
$smokeClient = Join-Path $PSScriptRoot "smoke-client.mjs"
$projectName = "excalidraw-ai-proxy-smoke-$PID"
$networkName = "$projectName-network"

if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) {
  throw "Docker CLI is required. The host does not need Caddy CLI."
}
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  throw "Node.js is required to run the smoke assertions."
}

$env:AI_PROXY_ALLOWED_ORIGINS = "http://127.0.0.1:$Port"
$env:AI_PROXY_CLIENT_TOKENS = "ai-proxy-smoke-token"
$env:AI_PROXY_REQUIRE_CLIENT_TOKEN = "true"
$env:AI_PROXY_ALLOW_HTTP_LOCALHOST = "true"
$env:AI_PROXY_NODE_ENV = "development"
$env:AI_PROXY_CADDY_SMOKE_PORT = $Port.ToString()
$env:AI_PROXY_EDGE_NETWORK = $networkName
$env:AI_GATEWAY_ENABLED = "false"
$env:AI_GATEWAY_POSTGRES_PASSWORD = "smoke-only-placeholder"
$env:AI_PROXY_SMOKE_UPSTREAM_PORT = "8090"

function Invoke-Docker {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  & docker.exe @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Docker command failed with exit code $LASTEXITCODE."
  }
}

function Invoke-Compose {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  $composeArguments = @(
    "compose", "-p", $projectName, "--profile", "smoke",
    "-f", $composeFile
  ) + $Arguments
  Invoke-Docker $composeArguments
}

function Test-DockerDaemon {
  $output = & docker.exe version --format "{{.Server.Version}}" 2>&1
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($output | Out-String))) {
    throw "Docker Desktop Linux engine is not ready. Start Docker Desktop and retry."
  }
}

try {
  if ($Action -eq "check") {
    Test-DockerDaemon
    Invoke-Compose @("config", "--quiet")
    Write-Output "AI proxy Docker smoke prerequisites are ready."
    exit 0
  }

  if ($Action -eq "down") {
    Invoke-Compose @("down", "--remove-orphans")
    exit 0
  }

  Test-DockerDaemon
  Invoke-Compose @("config", "--quiet")
  if ($Action -in @("up", "smoke")) {
    Invoke-Compose @(
      "up", "-d", "--build", "--force-recreate",
      "smoke-upstream", "ai-proxy", "caddy-smoke"
    )
    if ($Action -eq "up") {
      Write-Output "AI proxy Caddy smoke stack is running on http://127.0.0.1:$Port."
      exit 0
    }
    Start-Sleep -Seconds 2
    & node.exe $smokeClient "http://127.0.0.1:$Port"
    if ($LASTEXITCODE -ne 0) {
      throw "AI proxy Caddy smoke assertions failed."
    }
  }
} finally {
  if ($Action -eq "smoke") {
    try {
      Invoke-Compose @("down", "--remove-orphans")
    } catch {
      Write-Warning "Unable to tear down the smoke stack automatically. Run this script with -Action down."
    }
  }
}
