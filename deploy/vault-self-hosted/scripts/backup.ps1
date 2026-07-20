[CmdletBinding()]
param(
  [string]$EnvFile = (Join-Path $PSScriptRoot "..\.env"),
  [string]$StorageRoot,
  [string]$StorageDockerVolume,
  [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\backups"),
  [string]$PostgresImage = "postgres:17-alpine"
)

$ErrorActionPreference = "Stop"

function Read-EnvValue([string]$Path, [string]$Name) {
  $line = Get-Content -LiteralPath $Path -Encoding UTF8 |
    Where-Object { $_ -match "^$([regex]::Escape($Name))=" } |
    Select-Object -Last 1
  if (-not $line) {
    throw "Missing $Name in deployment env"
  }
  return $line.Split("=", 2)[1].Trim()
}

if ([bool]$StorageRoot -eq [bool]$StorageDockerVolume) {
  throw "Specify exactly one of -StorageRoot or -StorageDockerVolume"
}
if ($StorageRoot -and -not (Test-Path -LiteralPath $StorageRoot -PathType Container)) {
  throw "Storage root does not exist: $StorageRoot"
}
if ($StorageDockerVolume) {
  docker volume inspect $StorageDockerVolume | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Storage Docker volume does not exist"
  }
}

$databaseUrl = Read-EnvValue $EnvFile "VAULT_DATABASE_URL"
$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
if (-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) {
  New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
}
$backupRoot = Join-Path (Resolve-Path -LiteralPath $OutputDirectory) "vault-$stamp"
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null

$previousDatabaseUrl = $env:VAULT_DATABASE_URL
try {
  $env:VAULT_DATABASE_URL = $databaseUrl
  docker run --rm --env VAULT_DATABASE_URL `
    -v "${backupRoot}:/backup" `
    $PostgresImage `
    sh -c 'pg_dump "$VAULT_DATABASE_URL" --format=custom --file=/backup/database.dump'
  if ($LASTEXITCODE -ne 0) {
    throw "Database backup failed"
  }
} finally {
  $env:VAULT_DATABASE_URL = $previousDatabaseUrl
}

$storageArchive = Join-Path $backupRoot "storage.tar.gz"
if ($StorageRoot) {
  tar -czf $storageArchive -C (Resolve-Path -LiteralPath $StorageRoot) .
  if ($LASTEXITCODE -ne 0) {
    throw "Storage backup failed"
  }
} else {
  docker run --rm `
    -v "${StorageDockerVolume}:/storage:ro" `
    -v "${backupRoot}:/backup" `
    $PostgresImage `
    sh -c 'tar -czf /backup/storage.tar.gz -C /storage .'
  if ($LASTEXITCODE -ne 0) {
    throw "Storage volume backup failed"
  }
}

$databaseDump = Join-Path $backupRoot "database.dump"
$manifest = [ordered]@{
  backupFormat = "supabase-full-v1"
  preservesOwnershipAndPrivileges = $true
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
  deploymentVersion = "p4a-f4-v1"
  schemaVersion = 1
  roomServerVersion = 1
  database = [ordered]@{
    file = "database.dump"
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $databaseDump).Hash.ToLowerInvariant()
  }
  storage = [ordered]@{
    file = "storage.tar.gz"
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $storageArchive).Hash.ToLowerInvariant()
  }
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $backupRoot "manifest.json") -Encoding UTF8

Write-Output $backupRoot
