Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:VaultRepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$script:VaultSupabaseDirectory = Join-Path $script:VaultRepoRoot "supabase"
$script:VaultSqlDirectory = Join-Path $script:VaultRepoRoot "excalidraw-app\data\cloud\supabase"
$script:VaultMigrationDirectory = Join-Path $script:VaultRepoRoot "supabase\migrations"
$script:VaultSchemaInstallOrder = @(
  "schema_vault_prerequisites.sql",
  "schema_vault.sql",
  "schema_vault_storage.sql"
)
$script:VaultSchemaSmokeOrder = @(
  "schema_vault_smoke.sql",
  "schema_vault_storage_smoke.sql"
)
$script:VaultDisposableConfirmation = "DISPOSABLE_TEST_PROJECT"

function Import-VaultEnvironment {
  param([string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Vault environment file does not exist: $Path"
  }

  $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
  $repoPrefix = $script:VaultRepoRoot.TrimEnd("\") + "\"
  if ($resolvedPath.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    Assert-VaultCommand "git"
    $relativePath = $resolvedPath.Substring($repoPrefix.Length)
    & git -C $script:VaultRepoRoot check-ignore --quiet -- $relativePath
    if ($LASTEXITCODE -ne 0) {
      throw "Vault environment files inside the repository must be ignored by Git"
    }
  }

  foreach ($line in Get-Content -LiteralPath $resolvedPath) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) {
      continue
    }
    if ($trimmed -notmatch "^([A-Za-z_][A-Za-z0-9_]*)=(.*)$") {
      throw "Invalid environment assignment in $resolvedPath"
    }

    $name = $Matches[1]
    $value = $Matches[2].Trim()
    if (
      $value.Length -ge 2 -and
      (($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'")))
    ) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
  }
}

function Assert-VaultCommand {
  param([Parameter(Mandatory = $true)][string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command is not installed or not on PATH: $Name"
  }
}

function Invoke-VaultExternalCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  $previousErrorActionPreference = $ErrorActionPreference
  try {
    # Windows PowerShell 5.1 converts ordinary native stderr progress into a
    # NativeCommandError when the caller uses Stop. Supabase and Docker can
    # legitimately write progress to stderr while exiting successfully.
    $ErrorActionPreference = "Continue"
    & $Name @Arguments
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -ne 0) {
    throw "$Name failed with exit code $exitCode"
  }
}

function Invoke-VaultExternalCommandQuiet {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  $previousErrorActionPreference = $ErrorActionPreference
  try {
    # Supabase start/status output includes local JWTs and service-role keys.
    # Capture it in memory and return only a stable failure without echoing it.
    $ErrorActionPreference = "Continue"
    $null = & $Name @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -ne 0) {
    throw "$Name failed with exit code $exitCode"
  }
}

function Invoke-VaultPsqlFiles {
  param(
    [Parameter(Mandatory = $true)][string]$DatabaseUrl,
    [Parameter(Mandatory = $true)][string[]]$Files,
    [switch]$SingleTransaction
  )

  Assert-VaultCommand "psql"
  if ($Files.Count -eq 0) {
    throw "At least one SQL file is required"
  }
  foreach ($file in $Files) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
      throw "SQL file does not exist: $file"
    }
  }

  $uri = [Uri]$DatabaseUrl
  $userInfo = $uri.UserInfo.Split(":", 2)
  if ($userInfo.Count -ne 2) {
    throw "Database URL must include a username and password"
  }
  try {
    $databaseUser = [Uri]::UnescapeDataString($userInfo[0])
    $databasePassword = [Uri]::UnescapeDataString($userInfo[1])
    $databaseName = [Uri]::UnescapeDataString($uri.AbsolutePath.TrimStart("/"))
  } catch {
    throw "Database URL contains invalid credential or database escaping"
  }
  if (
    [string]::IsNullOrWhiteSpace($databaseUser) -or
    [string]::IsNullOrEmpty($databasePassword) -or
    [string]::IsNullOrWhiteSpace($databaseName) -or
    $uri.Port -lt 1
  ) {
    throw "Database URL must include a username, password, database, and port"
  }

  $previousValues = @{}
  foreach ($name in @(
      "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE",
      "PGSSLMODE", "PGSSLROOTCERT", "PGCONNECT_TIMEOUT"
    )) {
    $previousValues[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
  }
  try {
    # Use libpq environment fields instead of a URI argument. This keeps the
    # password out of argv and works for both native and Docker-backed psql.
    $env:PGHOST = $uri.Host
    $env:PGPORT = $uri.Port.ToString()
    $env:PGUSER = $databaseUser
    $env:PGPASSWORD = $databasePassword
    $env:PGDATABASE = $databaseName
    $query = Get-VaultUriQueryParameters $uri
    $env:PGSSLMODE = if ($query.ContainsKey("sslmode")) {
      $query["sslmode"].ToLowerInvariant()
    } else {
      "disable"
    }
    $rootCertPath = $env:VAULT_SUPABASE_SSLROOTCERT_PATH
    if (
      $query.ContainsKey("sslrootcert") -and
      $query["sslrootcert"].ToLowerInvariant() -eq "system" -and
      -not [string]::IsNullOrWhiteSpace($rootCertPath)
    ) {
      if (-not (Test-Path -LiteralPath $rootCertPath -PathType Leaf)) {
        throw "VAULT_SUPABASE_SSLROOTCERT_PATH does not point to a certificate file"
      }
      $rootCertPath = (Resolve-Path -LiteralPath $rootCertPath).Path
    }
    $env:PGSSLROOTCERT = if (-not [string]::IsNullOrWhiteSpace($rootCertPath)) {
      $rootCertPath
    } elseif ($query.ContainsKey("sslrootcert")) {
      $query["sslrootcert"].ToLowerInvariant()
    } else {
      $null
    }
    $env:PGCONNECT_TIMEOUT = "10"
    $arguments = @(
      "-X",
      "--set=ON_ERROR_STOP=1"
    )
    if ($SingleTransaction) {
      $arguments += "--single-transaction"
    }
    foreach ($file in $Files) {
      $arguments += "--file=$file"
    }
    Invoke-VaultExternalCommand "psql" $arguments
  } finally {
    foreach ($name in $previousValues.Keys) {
      [Environment]::SetEnvironmentVariable(
        $name,
        $previousValues[$name],
        "Process"
      )
    }
  }
}

function Get-VaultSqlFiles {
  param([Parameter(Mandatory = $true)][string[]]$Names)

  return @($Names | ForEach-Object {
      Join-Path $script:VaultSqlDirectory $_
    })
}

function Get-VaultUriQueryParameters {
  param([Parameter(Mandatory = $true)][Uri]$Uri)

  $parameters = @{}
  $rawQuery = $Uri.Query.TrimStart("?")
  if ([string]::IsNullOrWhiteSpace($rawQuery)) {
    return $parameters
  }

  foreach ($queryPart in $rawQuery.Split("&")) {
    if ([string]::IsNullOrWhiteSpace($queryPart)) {
      throw "Database URL contains an empty query parameter"
    }
    $pair = $queryPart.Split("=", 2)
    try {
      $name = [Uri]::UnescapeDataString($pair[0]).ToLowerInvariant()
      $value = if ($pair.Count -eq 2) {
        [Uri]::UnescapeDataString($pair[1])
      } else {
        ""
      }
    } catch {
      throw "Database URL contains invalid query escaping"
    }
    if ([string]::IsNullOrWhiteSpace($name)) {
      throw "Database URL contains an empty query parameter name"
    }
    if ($parameters.ContainsKey($name)) {
      throw "Database URL contains a duplicate query parameter"
    }
    $parameters[$name] = $value
  }

  return $parameters
}

function Test-VaultLoopbackHost {
  param([Parameter(Mandatory = $true)][string]$HostName)

  if ($HostName.Equals("localhost", [StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }

  $candidate = $HostName.Trim("[", "]")
  $address = $null
  if ([Net.IPAddress]::TryParse($candidate, [ref]$address)) {
    return [Net.IPAddress]::IsLoopback($address)
  }
  return $false
}

function Assert-VaultRemoteConfirmation {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRef,
    [Parameter(Mandatory = $true)][string]$ConfirmProjectRef,
    [Parameter(Mandatory = $true)][string]$ConfirmDisposable
  )

  if ($ConfirmProjectRef -cne $ProjectRef) {
    throw "Remote action refused: VAULT_REMOTE_CONFIRM_PROJECT_REF must exactly match the target project ref"
  }
  if ($ConfirmDisposable -cne $script:VaultDisposableConfirmation) {
    throw "Remote action refused: VAULT_REMOTE_CONFIRM_DISPOSABLE must equal $script:VaultDisposableConfirmation"
  }
}

function Assert-VaultPostgresUrl {
  param(
    [Parameter(Mandatory = $true)][string]$DatabaseUrl,
    [ValidateSet("local", "remote")][string]$Target,
    [string]$ProjectRef
  )

  try {
    $uri = [Uri]$DatabaseUrl
  } catch {
    throw "Database URL is not a valid PostgreSQL URI"
  }
  if ($uri.Scheme -notin @("postgres", "postgresql")) {
    throw "Database URL must use postgres:// or postgresql://"
  }
  if ([string]::IsNullOrWhiteSpace($uri.Host)) {
    throw "Database URL must include a host"
  }
  if (-not [string]::IsNullOrEmpty($uri.Fragment)) {
    throw "Database URL must not include a fragment"
  }

  try {
    $databaseName = [Uri]::UnescapeDataString($uri.AbsolutePath)
  } catch {
    throw "Database URL contains invalid path escaping"
  }
  if ($databaseName -cne "/postgres") {
    throw "Vault workflows require the dedicated postgres database"
  }

  $query = Get-VaultUriQueryParameters $uri
  foreach ($targetOverride in @(
      "host", "hostaddr", "port", "dbname", "user", "password", "service", "servicefile"
    )) {
    if ($query.ContainsKey($targetOverride)) {
      throw "Database URL must not override its connection target in query parameters"
    }
  }

  $remoteHost = $uri.Host.ToLowerInvariant()
  $isLoopback = Test-VaultLoopbackHost $uri.Host
  if ($Target -eq "local" -and -not $isLoopback) {
    throw "Local Vault workflow refuses a non-local database host"
  }
  if ($Target -eq "local") {
    if ($query.Count -gt 1 -or (
        $query.Count -eq 1 -and -not $query.ContainsKey("sslmode")
      )) {
      throw "Local database URL may contain only an explicit sslmode=disable query parameter"
    }
    if (
      $query.ContainsKey("sslmode") -and
      $query["sslmode"].ToLowerInvariant() -cne "disable"
    ) {
      throw "Local database URL must use sslmode=disable"
    }
  }
  if ($Target -eq "remote") {
    if ($isLoopback) {
      throw "Remote Vault workflow refuses a local database host"
    }
    if ([string]::IsNullOrWhiteSpace($ProjectRef)) {
      throw "Remote Vault workflow requires a project ref"
    }

    try {
      $encodedUser = ($uri.UserInfo -split ":", 2)[0]
      $databaseUser = [Uri]::UnescapeDataString($encodedUser)
    } catch {
      throw "Database URL contains invalid user escaping"
    }

    $directHost = "db.$ProjectRef.supabase.co"
    $isDirect = $remoteHost -ceq $directHost
    $isPooler = $remoteHost -match "^[a-z0-9-]+\.pooler\.supabase\.com$"
    if ($isDirect) {
      if ($databaseUser -cne "postgres" -or $uri.Port -ne 5432) {
        throw "Direct Supabase URL must use postgres on the confirmed project host and port 5432"
      }
    } elseif ($isPooler) {
      if (
        $databaseUser -cne "postgres.$ProjectRef" -or
        $uri.Port -notin @(5432, 6543)
      ) {
        throw "Supabase pooler URL must bind its user and port to the confirmed project"
      }
    } else {
      throw "Remote database URL is not exactly bound to the confirmed hosted Supabase project"
    }

    if (
      $query.Count -ne 2 -or
      -not $query.ContainsKey("sslmode") -or
      -not $query.ContainsKey("sslrootcert")
    ) {
      throw "Remote database URL must contain sslmode=verify-full and sslrootcert=system"
    }
    if ($query["sslmode"].ToLowerInvariant() -cne "verify-full") {
      throw "Remote database URL must use sslmode=verify-full"
    }
    if ($query["sslrootcert"].ToLowerInvariant() -cne "system") {
      throw "Remote database URL must use sslrootcert=system"
    }
  }
}

function Install-VaultSchema {
  param([Parameter(Mandatory = $true)][string]$DatabaseUrl)

  $files = Get-VaultSqlFiles $script:VaultSchemaInstallOrder
  $files += Join-Path `
    $script:VaultMigrationDirectory `
    "20260716193000_add_vault_deployment_contract.sql"
  Invoke-VaultPsqlFiles $DatabaseUrl $files -SingleTransaction
}

function Test-VaultSchema {
  param([Parameter(Mandatory = $true)][string]$DatabaseUrl)

  $files = Get-VaultSqlFiles $script:VaultSchemaSmokeOrder
  Invoke-VaultPsqlFiles $DatabaseUrl $files
}
