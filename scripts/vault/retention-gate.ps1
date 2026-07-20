param(
  [ValidateSet("local", "remote")]
  [string]$Target = "local",
  [string]$EnvFile = ""
)

. (Join-Path $PSScriptRoot "common.ps1")
Assert-VaultCommand "node"

$arguments = @(
  (Join-Path $PSScriptRoot "retention-gate.mjs"),
  $Target
)
if (-not [string]::IsNullOrWhiteSpace($EnvFile)) {
  $arguments += (Resolve-Path -LiteralPath $EnvFile).Path
}

Invoke-VaultExternalCommand "node" $arguments
