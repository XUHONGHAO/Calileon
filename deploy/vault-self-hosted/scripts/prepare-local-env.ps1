[CmdletBinding()]
param(
  [string]$AppEnvFile = (Join-Path $PSScriptRoot "..\..\..\.env.local"),
  [string]$RoomEnvFile = "C:\AI\excalidraw-room\.env.development",
  [string]$FunctionEnvFile = (Join-Path $PSScriptRoot "..\..\..\scripts\vault\local-function.local.env"),
  [string]$OutputFile = (Join-Path $PSScriptRoot "..\.env.local")
)

$ErrorActionPreference = "Stop"

function Read-DotEnv([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Missing local env file: $Path"
  }
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if ($line -match '^([^#=]+)=(.*)$') {
      $values[$matches[1].Trim()] = $matches[2].Trim()
    }
  }
  return $values
}

$app = Read-DotEnv $AppEnvFile
$room = Read-DotEnv $RoomEnvFile
$functions = Read-DotEnv $FunctionEnvFile
foreach ($required in @("VITE_APP_SUPABASE_ANON_KEY")) {
  if (-not $app[$required]) {
    throw "Missing $required in App local env"
  }
}
$controlPlaneToken = if ($room.VAULT_CONTROL_PLANE_TOKEN) {
  $room.VAULT_CONTROL_PLANE_TOKEN
} else {
  $functions.VAULT_ROOM_CONTROL_PLANE_TOKEN
}
if (-not $controlPlaneToken -or $controlPlaneToken.Length -lt 32) {
  throw "Room local env is missing a valid VAULT_CONTROL_PLANE_TOKEN"
}

$lines = @(
  "APP_ORIGIN=https://vault.localhost:8443",
  "SUPABASE_PUBLIC_URL=http://127.0.0.1:54321",
  "VAULT_SUPABASE_URL=http://host.docker.internal:54321",
  "SUPABASE_ANON_KEY=$($app.VITE_APP_SUPABASE_ANON_KEY)",
  "VAULT_DATABASE_URL=postgresql://postgres:postgres@host.docker.internal:54322/postgres",
  "VAULT_CONTROL_PLANE_TOKEN=$controlPlaneToken",
  "VAULT_ENABLED=true",
  "VAULT_ALLOW_DOCKER_HOST_HTTP=true",
  "VAULT_MAX_PAYLOAD_BYTES=1048576",
  "VAULT_MAX_MESSAGES_PER_MINUTE=1200",
  "VAULT_MAX_CONNECTIONS_PER_VAULT=64",
  "VAULT_CAPABILITY_RESOLVE_TIMEOUT_MS=5000",
  "ROOM_SERVER_CONTEXT=../../../excalidraw-room",
  "HTTP_PORT=8080",
  "HTTPS_PORT=8443"
)
$lines | Set-Content -LiteralPath $OutputFile -Encoding UTF8
Write-Output "Created ignored local deployment env without printing credentials: $OutputFile"
