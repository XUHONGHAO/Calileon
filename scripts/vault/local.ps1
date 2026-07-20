param(
  [ValidateSet("preflight", "start", "status", "reset", "schema", "smoke", "all", "stop")]
  [string]$Action = "preflight",
  [string]$EnvFile = ""
)

. (Join-Path $PSScriptRoot "common.ps1")
Import-VaultEnvironment $EnvFile

$DatabaseUrl = $env:VAULT_LOCAL_DATABASE_URL
if ([string]::IsNullOrWhiteSpace($DatabaseUrl)) {
  $DatabaseUrl = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
}
Assert-VaultPostgresUrl $DatabaseUrl "local"

# Supabase Vector on Docker Desktop for Windows expects the Docker daemon on
# unauthenticated tcp://host.docker.internal:2375. Vault local acceptance keeps
# that unsafe daemon endpoint disabled and scans individual container logs
# directly instead, so local analytics/vector are intentionally excluded.
$LocalExcludedServices = "analytics,vector"

function Assert-LocalRuntime {
  Assert-VaultCommand "docker"
  Assert-VaultCommand "supabase"
  Invoke-VaultExternalCommandQuiet "docker" @("info")
}

function Start-LocalVaultStack {
  Assert-LocalRuntime
  Push-Location $script:VaultRepoRoot
  try {
    Invoke-VaultExternalCommandQuiet "supabase" @(
      "start",
      "--exclude", $LocalExcludedServices
    )
    Write-Output "Vault local Supabase stack is running. Credentials were not printed."
  } finally {
    Pop-Location
  }
}

function Reset-LocalVaultDatabase {
  Assert-LocalRuntime
  Push-Location $script:VaultRepoRoot
  try {
    Invoke-VaultExternalCommand "supabase" @("db", "reset", "--local")
  } finally {
    Pop-Location
  }
}

switch ($Action) {
  "preflight" {
    Assert-LocalRuntime
    Assert-VaultCommand "psql"
    Write-Output "Vault local prerequisites are available. No state was changed."
  }
  "start" { Start-LocalVaultStack }
  "status" {
    Assert-VaultCommand "supabase"
    Push-Location $script:VaultRepoRoot
    try {
      Invoke-VaultExternalCommandQuiet "supabase" @("status", "--output", "json")
      Write-Output "Vault local Supabase stack is available. Credentials were not printed."
    } finally {
      Pop-Location
    }
  }
  "reset" { Reset-LocalVaultDatabase }
  "schema" { Install-VaultSchema $DatabaseUrl }
  "smoke" { Test-VaultSchema $DatabaseUrl }
  "all" {
    Start-LocalVaultStack
    Reset-LocalVaultDatabase
    Install-VaultSchema $DatabaseUrl
    Test-VaultSchema $DatabaseUrl
    Write-Output "Vault local schema and smoke completed successfully."
  }
  "stop" {
    Assert-VaultCommand "supabase"
    Push-Location $script:VaultRepoRoot
    try {
      Invoke-VaultExternalCommand "supabase" @("stop")
    } finally {
      Pop-Location
    }
  }
}
