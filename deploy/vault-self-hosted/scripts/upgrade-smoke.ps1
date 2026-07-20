[CmdletBinding()]
param(
  [string]$EnvFile = (Join-Path $PSScriptRoot "..\.env"),
  [string]$AppOrigin,
  [switch]$Local
)

$ErrorActionPreference = "Stop"
$deployRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

& (Join-Path $PSScriptRoot "validate-config.ps1") -EnvFile $EnvFile -Local:$Local | Out-Null

$compose = @(
  "compose",
  "--env-file", (Join-Path $deployRoot "versions.env"),
  "--env-file", $EnvFile,
  "-f", (Join-Path $deployRoot "compose.yml")
)
if ($Local) {
  $compose += @("-f", (Join-Path $deployRoot "compose.local.yml"))
}

docker @compose config --quiet
if ($LASTEXITCODE -ne 0) {
  throw "Compose configuration validation failed"
}

docker @compose --profile ops run --rm migrate
if ($LASTEXITCODE -ne 0) {
  throw "Initial migration failed"
}
docker @compose --profile ops run --rm migrate
if ($LASTEXITCODE -ne 0) {
  throw "Idempotent migration rerun failed"
}
docker @compose --profile ops run --rm schema-smoke
if ($LASTEXITCODE -ne 0) {
  throw "Schema smoke failed"
}

if ($AppOrigin) {
  & (Join-Path $PSScriptRoot "deployment-smoke.ps1") `
    -AppOrigin $AppOrigin `
    -AllowUntrustedCertificate:$Local
}

Write-Output "Upgrade smoke passed without plaintext fallback or schema downgrade."
