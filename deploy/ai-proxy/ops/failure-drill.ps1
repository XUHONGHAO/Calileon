[CmdletBinding()]
param(
  [ValidateSet("gateway-restart", "database-unavailable")]
  [string]$Scenario = "gateway-restart",
  [string]$Endpoint = "http://127.0.0.1:3016",
  [string]$EnvFile = "deploy/ai-proxy/.env",
  [string]$ProjectName = "excalidraw-ai-proxy"
)

$ErrorActionPreference = "Stop"
$composeFile = "deploy/ai-proxy/compose.yml"

function Invoke-Compose {
  param([string[]]$Arguments)
  & docker compose -p $ProjectName --env-file $EnvFile -f $composeFile @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "docker compose failed with exit code $LASTEXITCODE"
  }
}

function Wait-Endpoint {
  param(
    [string]$Path,
    [int]$ExpectedStatus = 200,
    [int]$Attempts = 30
  )
  for ($attempt = 0; $attempt -lt $Attempts; $attempt += 1) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "$Endpoint$Path" -Method Get
      if ($response.StatusCode -eq $ExpectedStatus) {
        return
      }
    } catch {
      if ($ExpectedStatus -ne 200 -and $_.Exception.Response.StatusCode.value__ -eq $ExpectedStatus) {
        return
      }
    }
    Start-Sleep -Seconds 2
  }
  throw "Endpoint $Path did not reach status $ExpectedStatus"
}

if ($Scenario -eq "gateway-restart") {
  Invoke-Compose @("restart", "ai-proxy")
  Wait-Endpoint "/healthz"
  Write-Output "gateway-restart: PASS"
  exit 0
}

Invoke-Compose @("stop", "ai-gateway-db")
try {
  Wait-Endpoint "/ai-gateway/readyz" 503 10
  Write-Output "database-unavailable: readiness fail-closed PASS"
} finally {
  Invoke-Compose @("start", "ai-gateway-db")
}
Wait-Endpoint "/ai-gateway/readyz" 200 30
Write-Output "database-unavailable: recovery PASS"
