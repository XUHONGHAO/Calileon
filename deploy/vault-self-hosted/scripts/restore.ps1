[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BackupDirectory,
  [string]$EnvFile = (Join-Path $PSScriptRoot "..\.env"),
  [string]$StorageRoot,
  [string]$StorageDockerVolume,
  # Docker network that can resolve the host in VAULT_DATABASE_URL. Required when
  # that URL uses an internal Compose service name (e.g. `db`), because a plain
  # `docker run` lands on the default bridge, which has no Docker DNS.
  [string]$DatabaseNetwork,
  [string]$PostgresImage = "postgres:17-alpine",
  [string]$DatabaseRestoreRole,
  [switch]$ConfirmDestructiveRestore
)

$ErrorActionPreference = "Stop"

if (-not $ConfirmDestructiveRestore) {
  throw "Restore refused: pass -ConfirmDestructiveRestore for a disposable or approved empty target"
}
if ([bool]$StorageRoot -eq [bool]$StorageDockerVolume) {
  throw "Specify exactly one of -StorageRoot or -StorageDockerVolume"
}

$networkArgs = @()
if ($DatabaseNetwork) {
  $networkArgs = @("--network", $DatabaseNetwork)
}

function Set-DatabaseUrlUser(
  [string]$DatabaseUrl,
  [string]$RestoreRole
) {
  if (-not $RestoreRole) {
    return $DatabaseUrl
  }

  $match = [regex]::Match(
    $DatabaseUrl,
    '^(?<scheme>postgres(?:ql)?://)(?<userinfo>[^@/]+)@(?<target>.+)$',
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
  )
  if (-not $match.Success) {
    throw "VAULT_DATABASE_URL must contain PostgreSQL user credentials when -DatabaseRestoreRole is used"
  }

  $userInfo = $match.Groups["userinfo"].Value
  $passwordSeparator = $userInfo.IndexOf(":")
  if ($passwordSeparator -lt 0) {
    throw "VAULT_DATABASE_URL must contain a password when -DatabaseRestoreRole is used"
  }

  $escapedRole = [Uri]::EscapeDataString($RestoreRole)
  return (
    $match.Groups["scheme"].Value +
    $escapedRole +
    $userInfo.Substring($passwordSeparator) +
    "@" +
    $match.Groups["target"].Value
  )
}

$backupRoot = Resolve-Path -LiteralPath $BackupDirectory
$repositoryRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$schemaRoot = Join-Path $repositoryRoot "excalidraw-app\data\cloud\supabase"
$migrationRoot = Join-Path $repositoryRoot "supabase\migrations"
$manifestPath = Join-Path $backupRoot "manifest.json"
$databaseDump = Join-Path $backupRoot "database.dump"
$storageArchive = Join-Path $backupRoot "storage.tar.gz"
foreach ($path in @($manifestPath, $databaseDump, $storageArchive)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Incomplete backup: $path"
  }
}

$manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding UTF8 | ConvertFrom-Json
if (
  $manifest.backupFormat -ne "supabase-full-v1" -or
  $manifest.preservesOwnershipAndPrivileges -ne $true -or
  $manifest.deploymentVersion -ne "p4a-f4-v1" -or
  $manifest.schemaVersion -ne 1 -or
  $manifest.roomServerVersion -ne 1
) {
  throw "Backup version is incompatible with this deployment"
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $databaseDump).Hash.ToLowerInvariant() -ne $manifest.database.sha256) {
  throw "Database backup checksum mismatch"
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $storageArchive).Hash.ToLowerInvariant() -ne $manifest.storage.sha256) {
  throw "Storage backup checksum mismatch"
}

if ($StorageRoot) {
  if (-not (Test-Path -LiteralPath $StorageRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $StorageRoot -Force | Out-Null
  }
  if (Get-ChildItem -LiteralPath $StorageRoot -Force | Select-Object -First 1) {
    throw "Storage restore target must be empty"
  }
} else {
  docker volume inspect $StorageDockerVolume | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Storage Docker volume does not exist"
  }
  $storageEntries = docker run --rm -v "${StorageDockerVolume}:/storage:ro" $PostgresImage ls -A /storage
  if ($LASTEXITCODE -ne 0 -or $storageEntries) {
    throw "Storage restore volume must be empty"
  }
}

$databaseLine = Get-Content -LiteralPath $EnvFile -Encoding UTF8 |
  Where-Object { $_ -match '^VAULT_DATABASE_URL=' } |
  Select-Object -Last 1
if (-not $databaseLine) {
  throw "Missing VAULT_DATABASE_URL in deployment env"
}
$databaseUrl = $databaseLine.Split("=", 2)[1].Trim()
$databaseUrl = Set-DatabaseUrlUser $databaseUrl $DatabaseRestoreRole

# The restored database must be reconciled with the same deployment shape it was
# backed up from, otherwise install-schema.sh would install the wrong half and
# schema-smoke.sh would assert the wrong invariant. Absent means the frozen
# vault-only shape, matching the default in both scripts.
$scopeLine = Get-Content -LiteralPath $EnvFile -Encoding UTF8 |
  Where-Object { $_ -match '^VAULT_DEPLOYMENT_SCOPE=' } |
  Select-Object -Last 1
$deploymentScope = if ($scopeLine) {
  $scopeLine.Split("=", 2)[1].Trim()
} else {
  "vault-only"
}

$previousDatabaseUrl = $env:VAULT_DATABASE_URL
$previousDeploymentScope = $env:VAULT_DEPLOYMENT_SCOPE
try {
  $env:VAULT_DATABASE_URL = $databaseUrl
  $env:VAULT_DEPLOYMENT_SCOPE = $deploymentScope
  $databaseOccupied = docker run --rm @networkArgs --env VAULT_DATABASE_URL `
    -v "${PSScriptRoot}:/scripts:ro" `
    $PostgresImage `
    sh -c 'psql "$VAULT_DATABASE_URL" -Atqf /scripts/restore-preflight.sql'
  if ($LASTEXITCODE -ne 0) {
    throw "Database restore target preflight failed"
  }
  switch (($databaseOccupied | Out-String).Trim()) {
    "0" { }
    "1" { throw "Database restore target must not already contain Vault tables" }
    "2" { throw "Database restore target is missing required Supabase platform roles" }
    default { throw "Database restore target preflight returned an invalid result" }
  }

  docker run --rm @networkArgs --env VAULT_DATABASE_URL `
    -v "${PSScriptRoot}:/scripts:ro" `
    $PostgresImage `
    sh -c 'psql "$VAULT_DATABASE_URL" -v ON_ERROR_STOP=1 -f /scripts/restore-disable-event-triggers.sql'
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to disable target event triggers before restore"
  }

  docker run --rm @networkArgs --env VAULT_DATABASE_URL `
    -v "${backupRoot}:/backup:ro" `
    $PostgresImage `
    sh -c 'pg_restore --dbname="$VAULT_DATABASE_URL" --clean --if-exists --exit-on-error /backup/database.dump'
  if ($LASTEXITCODE -ne 0) {
    throw "Database restore failed"
  }

  docker run --rm @networkArgs --env VAULT_DATABASE_URL --env VAULT_DEPLOYMENT_SCOPE `
    -v "${schemaRoot}:/schema:ro" `
    -v "${migrationRoot}:/migrations:ro" `
    -v "${PSScriptRoot}:/ops:ro" `
    $PostgresImage `
    sh /ops/install-schema.sh
  if ($LASTEXITCODE -ne 0) {
    throw "Vault schema reconciliation after restore failed"
  }

  docker run --rm @networkArgs --env VAULT_DATABASE_URL --env VAULT_DEPLOYMENT_SCOPE `
    -v "${schemaRoot}:/schema:ro" `
    -v "${PSScriptRoot}:/ops:ro" `
    $PostgresImage `
    sh /ops/schema-smoke.sh
  if ($LASTEXITCODE -ne 0) {
    throw "Vault schema smoke after restore failed"
  }
} finally {
  $env:VAULT_DATABASE_URL = $previousDatabaseUrl
  $env:VAULT_DEPLOYMENT_SCOPE = $previousDeploymentScope
}

if ($StorageRoot) {
  tar -xzf $storageArchive -C (Resolve-Path -LiteralPath $StorageRoot)
  if ($LASTEXITCODE -ne 0) {
    throw "Storage restore failed"
  }
} else {
  docker run --rm `
    -v "${StorageDockerVolume}:/storage" `
    -v "${backupRoot}:/backup:ro" `
    $PostgresImage `
    sh -c 'tar -xzf /backup/storage.tar.gz -C /storage'
  if ($LASTEXITCODE -ne 0) {
    throw "Storage volume restore failed"
  }
}

Write-Output "Restore completed with schema smoke; decrypt a known Vault with its client-held key."
