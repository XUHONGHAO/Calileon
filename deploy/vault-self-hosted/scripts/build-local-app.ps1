[CmdletBinding()]
param(
  [string]$EnvFile = (Join-Path $PSScriptRoot "..\.env.local"),
  [switch]$SkipSingleFileRuntime
)

$ErrorActionPreference = "Stop"

$values = @{}
foreach ($line in Get-Content -LiteralPath $EnvFile -Encoding UTF8) {
  if ($line -match '^([^#=]+)=(.*)$') {
    $values[$matches[1].Trim()] = $matches[2].Trim()
  }
}
foreach ($required in @("APP_ORIGIN", "SUPABASE_PUBLIC_URL", "SUPABASE_ANON_KEY", "VAULT_ENABLED")) {
  if (-not $values[$required]) {
    throw "Missing $required in local deployment env"
  }
}

$buildEnvironment = [ordered]@{
  VITE_APP_WS_SERVER_URL = $values.APP_ORIGIN
  VITE_APP_VAULT_ENABLED = $values.VAULT_ENABLED
  VITE_APP_VAULT_PERSISTENCE_CAPABILITIES_URL = "$($values.SUPABASE_PUBLIC_URL)/functions/v1/vault-control-plane"
  VITE_APP_VAULT_ROOM_CAPABILITIES_URL = "$($values.APP_ORIGIN)/vault/capabilities"
  VITE_APP_VAULT_ROOM_PROVISION_URL = "$($values.APP_ORIGIN)/vault/rooms"
  VITE_APP_SUPABASE_URL = $values.SUPABASE_PUBLIC_URL
  VITE_APP_SUPABASE_ANON_KEY = $values.SUPABASE_ANON_KEY
  VITE_APP_DISABLE_SENTRY = "true"
  VITE_APP_REMOTE_VIDEO_ASSETS = "false"
  VITE_APP_ENABLE_PWA = "false"
  VITE_APP_SELF_HOSTED = "true"
}
$previous = @{}
try {
  foreach ($name in $buildEnvironment.Keys) {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    [Environment]::SetEnvironmentVariable($name, $buildEnvironment[$name], "Process")
  }
  Push-Location (Resolve-Path (Join-Path $PSScriptRoot "..\..\.."))
  try {
    $yarn = Get-Command yarn.cmd -ErrorAction Stop
    $buildCommand = if ($SkipSingleFileRuntime) {
      "`"$($yarn.Source)`" --cwd ./excalidraw-app cross-env VITE_APP_DISABLE_SENTRY=true vite build 2>&1"
    } else {
      "`"$($yarn.Source)`" build:app:docker 2>&1"
    }
    $buildOutput = & $env:ComSpec /d /s /c $buildCommand
    $buildExitCode = $LASTEXITCODE
    if ($buildExitCode -ne 0) {
      $buildOutput | Select-Object -Last 100 | Write-Output
      throw "Local production App build failed"
    }
    $buildOutput | Select-Object -Last 20 | Write-Output
  } finally {
    Pop-Location
  }
} finally {
  foreach ($name in $previous.Keys) {
    [Environment]::SetEnvironmentVariable($name, $previous[$name], "Process")
  }
}

Write-Output "Local production App build completed without printing credentials."
