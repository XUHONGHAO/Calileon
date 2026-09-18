[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "High")]
param(
  [Parameter(Mandatory = $true)]
  [string]$InputPath,
  [switch]$ConfirmRestore,
  [string]$EnvFile = "deploy/ai-proxy/.env",
  [string]$ProjectName = "excalidraw-ai-proxy",
  [string]$DatabaseUser = "ai_gateway",
  [string]$DatabaseName = "ai_gateway"
)

$ErrorActionPreference = "Stop"
if (-not $ConfirmRestore) {
  throw "Restore is destructive. Re-run with -ConfirmRestore after verifying the backup and target database."
}
$resolved = [IO.Path]::GetFullPath($InputPath)
if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
  throw "Backup file does not exist"
}
if ($PSCmdlet.ShouldProcess("ai_gateway database", "restore $resolved")) {
  Get-Content -LiteralPath $resolved -Raw |
    & docker compose -p $ProjectName --env-file $EnvFile -f deploy/ai-proxy/compose.yml exec -T ai-gateway-db psql --set ON_ERROR_STOP=1 --single-transaction -U $DatabaseUser -d $DatabaseName
  if ($LASTEXITCODE -ne 0) {
    throw "Postgres restore failed"
  }
  Write-Output "Postgres restore completed"
}
