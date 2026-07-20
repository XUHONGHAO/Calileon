[CmdletBinding()]
param(
  [string]$EnvFile = (Join-Path $PSScriptRoot "..\.env"),
  [switch]$Local
)

$ErrorActionPreference = "Stop"

function Read-DotEnv([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Missing deployment env file: $Path"
  }
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) {
      continue
    }
    $parts = $trimmed.Split("=", 2)
    if ($parts.Count -ne 2) {
      throw "Invalid env line in $Path"
    }
    $values[$parts[0].Trim()] = $parts[1].Trim()
  }
  return $values
}

function Assert-Origin(
  [string]$Name,
  [string]$Value,
  [bool]$AllowLocalHttp
) {
  $uri = $null
  if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri)) {
    throw "$Name must be an absolute URL"
  }
  $localHost = $uri.Host -in @("localhost", "127.0.0.1", "::1", "host.docker.internal")
  if ($uri.Scheme -ne "https" -and -not ($AllowLocalHttp -and $uri.Scheme -eq "http" -and $localHost)) {
    throw "$Name must use HTTPS"
  }
  if ($uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne "/") {
    throw "$Name must be an origin without credentials, path, query, or fragment"
  }
  if ($Value.Contains("*")) {
    throw "$Name must not contain a wildcard"
  }
}

$envValues = Read-DotEnv $EnvFile
foreach ($required in @(
  "APP_ORIGIN",
  "SUPABASE_PUBLIC_URL",
  "VAULT_SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "VAULT_DATABASE_URL",
  "VAULT_CONTROL_PLANE_TOKEN",
  "VAULT_ENABLED"
)) {
  if (-not $envValues.ContainsKey($required) -or -not $envValues[$required]) {
    throw "Missing required deployment value: $required"
  }
}

Assert-Origin "APP_ORIGIN" $envValues.APP_ORIGIN $false
Assert-Origin "SUPABASE_PUBLIC_URL" $envValues.SUPABASE_PUBLIC_URL $Local.IsPresent
Assert-Origin "VAULT_SUPABASE_URL" $envValues.VAULT_SUPABASE_URL $Local.IsPresent

if ($envValues.VAULT_CONTROL_PLANE_TOKEN.Length -lt 32) {
  throw "VAULT_CONTROL_PLANE_TOKEN must contain at least 32 characters"
}
if ($envValues.VAULT_ENABLED -notin @("true", "false")) {
  throw "VAULT_ENABLED must be true or false"
}
if (
  $envValues.ContainsKey("VAULT_ALLOW_DOCKER_HOST_HTTP") -and
  $envValues.VAULT_ALLOW_DOCKER_HOST_HTTP -eq "true" -and
  -not $Local
) {
  throw "VAULT_ALLOW_DOCKER_HOST_HTTP is allowed only for local smoke"
}
if (
  $envValues.SUPABASE_ANON_KEY.StartsWith("replace-") -or
  $envValues.VAULT_DATABASE_URL.Contains("replace-") -or
  $envValues.VAULT_CONTROL_PLANE_TOKEN.StartsWith("replace-")
) {
  throw "Deployment env still contains example placeholder values"
}

$versions = Read-DotEnv (Join-Path $PSScriptRoot "..\versions.env")
if (
  $versions.VAULT_DEPLOYMENT_VERSION -ne "p4a-f4-v1" -or
  $versions.VAULT_SCHEMA_VERSION -ne "1" -or
  $versions.VAULT_ROOM_SERVER_VERSION -ne "1"
) {
  throw "Unsupported Vault App/room/schema version combination"
}

[pscustomobject]@{
  AppOrigin = $envValues.APP_ORIGIN
  SupabaseOrigin = $envValues.SUPABASE_PUBLIC_URL
  VaultEnabled = $envValues.VAULT_ENABLED
  DeploymentVersion = $versions.VAULT_DEPLOYMENT_VERSION
  SchemaVersion = $versions.VAULT_SCHEMA_VERSION
  RoomServerVersion = $versions.VAULT_ROOM_SERVER_VERSION
}
