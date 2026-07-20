param(
  [ValidateSet("preflight", "schema", "functions", "smoke", "all")]
  [string]$Action = "preflight",
  [string]$ProjectRef = $env:VAULT_SUPABASE_PROJECT_REF,
  [string]$ConfirmProjectRef = $env:VAULT_REMOTE_CONFIRM_PROJECT_REF,
  [string]$ConfirmDisposable = $env:VAULT_REMOTE_CONFIRM_DISPOSABLE,
  [string]$EnvFile = ""
)

. (Join-Path $PSScriptRoot "common.ps1")
Import-VaultEnvironment $EnvFile

if ([string]::IsNullOrWhiteSpace($ProjectRef)) {
  $ProjectRef = $env:VAULT_SUPABASE_PROJECT_REF
}
if ([string]::IsNullOrWhiteSpace($ConfirmProjectRef)) {
  $ConfirmProjectRef = $env:VAULT_REMOTE_CONFIRM_PROJECT_REF
}
if ([string]::IsNullOrWhiteSpace($ConfirmDisposable)) {
  $ConfirmDisposable = $env:VAULT_REMOTE_CONFIRM_DISPOSABLE
}
$DatabaseUrl = $env:VAULT_SUPABASE_DB_URL
$SslRootCertPath = $env:VAULT_SUPABASE_SSLROOTCERT_PATH

if ($ProjectRef -notmatch "^[a-z0-9]{20}$") {
  throw "VAULT_SUPABASE_PROJECT_REF must be a 20-character hosted Supabase project ref"
}

$requiresDatabase = $Action -in @("preflight", "schema", "smoke", "all")
if ($requiresDatabase) {
  if ([string]::IsNullOrWhiteSpace($DatabaseUrl)) {
    throw "VAULT_SUPABASE_DB_URL is required for schema and smoke actions"
  }
  Assert-VaultPostgresUrl $DatabaseUrl "remote" $ProjectRef
  if ([string]::IsNullOrWhiteSpace($SslRootCertPath)) {
    throw "VAULT_SUPABASE_SSLROOTCERT_PATH must point to the downloaded Supabase CA certificate"
  }
  if (-not (Test-Path -LiteralPath $SslRootCertPath -PathType Leaf)) {
    throw "VAULT_SUPABASE_SSLROOTCERT_PATH does not point to a certificate file"
  }
}

Assert-VaultCommand "supabase"
Assert-VaultRemoteConfirmation $ProjectRef $ConfirmProjectRef $ConfirmDisposable

if ($Action -eq "preflight") {
  Assert-VaultCommand "psql"
  Write-Output "Vault remote inputs and prerequisites are valid. No remote request was made."
  exit 0
}

function Invoke-RemoteSupabase {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  Push-Location $script:VaultRepoRoot
  try {
    Invoke-VaultExternalCommand "supabase" $Arguments
  } finally {
    Pop-Location
  }
}

function Deploy-RemoteVaultFunction {
  $secretArguments = @(
    "secrets",
    "set",
    "VAULT_ASSET_BUCKET=vault-assets"
  )
  $allowedOrigins = $env:VAULT_APP_ALLOWED_ORIGINS
  $roomControlPlaneUrl = $env:VAULT_ROOM_CONTROL_PLANE_URL
  $roomControlPlaneToken = $env:VAULT_ROOM_CONTROL_PLANE_TOKEN
  $controlPlaneValues = @(
    $allowedOrigins,
    $roomControlPlaneUrl,
    $roomControlPlaneToken
  )
  $configuredControlPlaneValues = @(
    $controlPlaneValues | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  )
  if ($configuredControlPlaneValues.Count -notin @(0, 3)) {
    throw "Vault control-plane deployment requires origins, room URL, and token together"
  }
  if ($configuredControlPlaneValues.Count -eq 3) {
    $secretArguments += "APP_ALLOWED_ORIGINS=$allowedOrigins"
    $secretArguments += "VAULT_ROOM_CONTROL_PLANE_URL=$roomControlPlaneUrl"
    $secretArguments += "VAULT_ROOM_CONTROL_PLANE_TOKEN=$roomControlPlaneToken"
  }
  $secretArguments += @("--project-ref", $ProjectRef)
  Invoke-RemoteSupabase $secretArguments
  Invoke-RemoteSupabase @(
    "functions",
    "deploy",
    "vault-asset-access",
    "--project-ref",
    $ProjectRef,
    "--no-verify-jwt"
  )
  Invoke-RemoteSupabase @(
    "functions",
    "deploy",
    "vault-control-plane",
    "--project-ref",
    $ProjectRef,
    "--no-verify-jwt"
  )
}

switch ($Action) {
  "schema" { Install-VaultSchema $DatabaseUrl }
  "functions" { Deploy-RemoteVaultFunction }
  "smoke" { Test-VaultSchema $DatabaseUrl }
  "all" {
    Install-VaultSchema $DatabaseUrl
    Test-VaultSchema $DatabaseUrl
    Deploy-RemoteVaultFunction
    Write-Output "Vault isolated remote schema, function deployment, and smoke completed successfully."
  }
}
