[CmdletBinding()]
param(
  [string]$OutputPath,
  [string]$EnvFile = "deploy/ai-proxy/.env",
  [string]$ProjectName = "excalidraw-ai-proxy",
  [string]$DatabaseUser = "ai_gateway",
  [string]$DatabaseName = "ai_gateway"
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  throw "OutputPath is required. Store backups outside Git and protect them as sensitive data."
}
$resolved = [IO.Path]::GetFullPath($OutputPath)
$parent = Split-Path -Parent $resolved
New-Item -ItemType Directory -Path $parent -Force | Out-Null

& docker compose -p $ProjectName --env-file $EnvFile -f deploy/ai-proxy/compose.yml exec -T ai-gateway-db pg_dump --format=plain --no-owner --no-privileges -U $DatabaseUser -d $DatabaseName > $resolved
if ($LASTEXITCODE -ne 0) {
  Remove-Item -LiteralPath $resolved -Force -ErrorAction SilentlyContinue
  throw "Postgres backup failed"
}
Write-Output "Postgres backup written to $resolved"
