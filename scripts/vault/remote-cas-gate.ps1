param(
  [string]$EnvFile = ""
)

& (Join-Path $PSScriptRoot "local-cas-gate.ps1") `
  -EnvFile $EnvFile `
  -Target remote

if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
