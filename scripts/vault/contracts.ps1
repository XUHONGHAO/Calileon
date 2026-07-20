[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "common.ps1")

function Assert-Contract {
  param(
    [Parameter(Mandatory = $true)][bool]$Condition,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Message
  )

  if (-not $Condition) {
    throw "Vault script contract failed: $Message"
  }
}

function Assert-ContractThrows {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Action,
    [Parameter(Mandatory = $true)][string]$Message
  )

  try {
    & $Action
  } catch {
    return
  }
  throw "Vault script contract failed: expected rejection for $Message"
}

$projectRef = "abcdefghijklmnopqrst"

Assert-VaultRemoteConfirmation `
  $projectRef `
  $projectRef `
  "DISPOSABLE_TEST_PROJECT"
Assert-ContractThrows {
  Assert-VaultRemoteConfirmation `
    $projectRef `
    "zzzzzzzzzzzzzzzzzzzz" `
    "DISPOSABLE_TEST_PROJECT"
} "mismatched remote project confirmation"
Assert-ContractThrows {
  Assert-VaultRemoteConfirmation $projectRef $projectRef "production"
} "missing disposable-project confirmation"

$nativeProbe = Join-Path $PSHOME "powershell.exe"
$preferenceBeforeProbe = $ErrorActionPreference
$probeOutput = & {
  Invoke-VaultExternalCommand $nativeProbe @(
    "-NoProfile",
    "-Command",
    "[Console]::Error.WriteLine('expected progress'); exit 0"
  )
} 2>&1
Assert-Contract `
  ($ErrorActionPreference -ceq $preferenceBeforeProbe) `
  "native command wrapper must restore ErrorActionPreference"
Assert-Contract `
  (($probeOutput | Out-String).Contains("expected progress")) `
  "successful native stderr progress must not be swallowed by the non-quiet wrapper"
Invoke-VaultExternalCommandQuiet $nativeProbe @(
  "-NoProfile",
  "-Command",
  "[Console]::Error.WriteLine('redacted progress'); exit 0"
)
Assert-ContractThrows {
  Invoke-VaultExternalCommandQuiet $nativeProbe @(
    "-NoProfile",
    "-Command",
    "[Console]::Error.WriteLine('redacted failure'); exit 9"
  )
} "native command non-zero exit after stderr"

Assert-VaultPostgresUrl `
  "postgresql://postgres:secret@db.${projectRef}.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=system" `
  "remote" `
  $projectRef
Assert-VaultPostgresUrl `
  "postgresql://postgres.${projectRef}:secret@aws-0-region.pooler.supabase.com:6543/postgres?sslmode=verify-full&sslrootcert=system" `
  "remote" `
  $projectRef
Assert-VaultPostgresUrl `
  "postgresql://postgres.${projectRef}:secret@aws-0-region.pooler.supabase.com:5432/postgres?sslmode=verify-full&sslrootcert=system" `
  "remote" `
  $projectRef
Assert-VaultPostgresUrl `
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres" `
  "local"
Assert-VaultPostgresUrl `
  "postgresql://postgres:postgres@localhost:54322/postgres?sslmode=disable" `
  "local"
Assert-VaultPostgresUrl `
  "postgresql://postgres:postgres@[::1]:54322/postgres" `
  "local"

Assert-ContractThrows {
  Assert-VaultPostgresUrl `
    "postgresql://postgres:secret@db.${projectRef}.supabase.co:5432/postgres" `
    "remote" `
    $projectRef
} "remote database URL without explicit TLS"
foreach ($weakSslMode in @("disable", "allow", "prefer", "require", "verify-ca")) {
  Assert-ContractThrows {
    Assert-VaultPostgresUrl `
      "postgresql://postgres:secret@db.${projectRef}.supabase.co:5432/postgres?sslmode=$weakSslMode&sslrootcert=system" `
      "remote" `
      $projectRef
  } "remote database URL with weak sslmode=$weakSslMode"
}
Assert-ContractThrows {
  Assert-VaultPostgresUrl `
    "postgresql://postgres:secret@db.${projectRef}.supabase.co:5432/postgres?sslmode=verify-full" `
    "remote" `
    $projectRef
} "remote database URL without the system root certificate contract"
Assert-ContractThrows {
  Assert-VaultPostgresUrl `
    "postgresql://postgres:secret@db.${projectRef}.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=C%3A%5Ctemp%5Cca.pem" `
    "remote" `
    $projectRef
} "remote database URL with a caller-selected root certificate"
Assert-ContractThrows {
  Assert-VaultPostgresUrl `
    "postgresql://postgres:secret@db.zzzzzzzzzzzzzzzzzzzz.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=system" `
    "remote" `
    $projectRef
} "remote database URL bound to another project"
Assert-ContractThrows {
  Assert-VaultPostgresUrl `
    "postgresql://postgres:secret@127.0.0.1:5432/postgres?sslmode=verify-full&sslrootcert=system" `
    "remote" `
    $projectRef
} "remote workflow pointed at loopback"
Assert-ContractThrows {
  Assert-VaultPostgresUrl `
    "postgresql://postgres:secret@db.${projectRef}.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=system#secret" `
    "remote" `
    $projectRef
} "database URL fragment"
Assert-ContractThrows {
  Assert-VaultPostgresUrl `
    "postgresql://postgres:secret@db.${projectRef}.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=system" `
    "local"
} "local workflow pointed at a remote host"
Assert-ContractThrows {
  Assert-VaultPostgresUrl `
    "postgresql://postgres:secret@db.${projectRef}.supabase.co:5432/postgres?sslmode=verify-full&sslmode=disable&sslrootcert=system" `
    "remote" `
    $projectRef
} "ambiguous duplicate sslmode"
Assert-ContractThrows {
  Assert-VaultPostgresUrl `
    "postgresql://postgres:secret@db.${projectRef}.supabase.co:5432/postgres?host=db.zzzzzzzzzzzzzzzzzzzz.supabase.co&sslmode=verify-full&sslrootcert=system" `
    "remote" `
    $projectRef
} "query parameter target override"
Assert-ContractThrows {
  Assert-VaultPostgresUrl `
    "postgresql://postgres.${projectRef}:secret@api.supabase.com:5432/postgres?sslmode=verify-full&sslrootcert=system" `
    "remote" `
    $projectRef
} "generic Supabase host with a forged project username"
Assert-ContractThrows {
  Assert-VaultPostgresUrl `
    "postgresql://postgres.zzzzzzzzzzzzzzzzzzzz:secret@aws-0-region.pooler.supabase.com:5432/postgres?sslmode=verify-full&sslrootcert=system" `
    "remote" `
    $projectRef
} "pooler username bound to another project"
Assert-ContractThrows {
  Assert-VaultPostgresUrl `
    "postgresql://postgres:secret@db.${projectRef}.supabase.co:5432/template1?sslmode=verify-full&sslrootcert=system" `
    "remote" `
    $projectRef
} "remote workflow pointed at another database"
Assert-ContractThrows {
  Assert-VaultPostgresUrl `
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres?host=db.${projectRef}.supabase.co" `
    "local"
} "local query parameter target override"
foreach ($nonLocalSslMode in @("allow", "prefer", "require", "verify-ca", "verify-full")) {
  Assert-ContractThrows {
    Assert-VaultPostgresUrl `
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres?sslmode=$nonLocalSslMode" `
      "local"
  } "local database URL with non-disabled sslmode=$nonLocalSslMode"
}
Assert-ContractThrows {
  Assert-VaultPostgresUrl `
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres?application_name=vault" `
    "local"
} "local database URL with an unrelated query parameter"

$parseFailures = New-Object System.Collections.Generic.List[string]
foreach ($scriptFile in Get-ChildItem -LiteralPath $PSScriptRoot -Filter "*.ps1") {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile(
    $scriptFile.FullName,
    [ref]$tokens,
    [ref]$errors
  ) | Out-Null
  foreach ($parseError in $errors) {
    $parseFailures.Add(
      "$($scriptFile.Name):$($parseError.Extent.StartLineNumber): $($parseError.Message)"
    )
  }
}
Assert-Contract ($parseFailures.Count -eq 0) ($parseFailures -join "; ")

$commonSource = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot "common.ps1")
$localSource = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot "local.ps1")
$remoteSource = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot "remote.ps1")
$windowsSource = Get-Content -Raw -LiteralPath (
  Join-Path $PSScriptRoot "windows-prerequisites.ps1"
)
$prerequisiteSource = Get-Content -Raw -LiteralPath (
  Join-Path $script:VaultSqlDirectory "schema_vault_prerequisites.sql"
)
$storageSource = Get-Content -Raw -LiteralPath (
  Join-Path $script:VaultSqlDirectory "schema_vault_storage.sql"
)
$storageSmoke = Get-Content -Raw -LiteralPath (
  Join-Path $script:VaultSqlDirectory "schema_vault_storage_smoke.sql"
)

Assert-Contract `
  (-not $commonSource.Contains('"schema.sql"')) `
  "Vault install must not create the ordinary plain scenes schema"
Assert-Contract `
  $commonSource.Contains('"schema_vault_prerequisites.sql"') `
  "Vault-only prerequisite must run before the Vault schema"
Assert-Contract `
  (($script:VaultSchemaInstallOrder -join ",") -ceq (
      "schema_vault_prerequisites.sql,schema_vault.sql,schema_vault_storage.sql"
    )) `
  "Vault migration order must remain prerequisite, schema, then private Storage"
Assert-Contract `
  (($script:VaultSchemaSmokeOrder -join ",") -ceq (
      "schema_vault_smoke.sql,schema_vault_storage_smoke.sql"
    )) `
  "Vault smoke order must validate schema before Storage"
Assert-Contract `
  $commonSource.Contains("--single-transaction") `
  "ordered Vault schema installation must be atomic"
Assert-Contract `
  ($localSource.Contains('Invoke-VaultExternalCommandQuiet "supabase" @(') -and
    $localSource.Contains('"start",')) `
  "local Supabase start output must remain secret-redacted"
Assert-Contract `
  ($localSource.Contains('Invoke-VaultExternalCommandQuiet "supabase" @("status"')) `
  "local Supabase status output must remain secret-redacted"
Assert-Contract `
  (-not $remoteSource.Contains('"link"')) `
  "remote workflow must not create persistent linked-project state"
Assert-Contract `
  (-not $remoteSource.Contains('"db", "push"')) `
  "remote workflow must not push unrelated repository migrations"
Assert-Contract `
  (-not $remoteSource.Contains('[string]$DatabaseUrl')) `
  "remote database credentials must not be accepted as a script argument"
Assert-Contract `
  (-not $localSource.Contains('[string]$DatabaseUrl')) `
  "local database credentials must not be accepted as a script argument"
Assert-Contract `
  $remoteSource.Contains("Assert-VaultRemoteConfirmation") `
  "remote workflow must require an explicit disposable-project confirmation"
Assert-Contract `
  ($prerequisiteSource.Contains("create extension if not exists pgcrypto") -and
    $prerequisiteSource.Contains("vault_touch_updated_at") -and
    $prerequisiteSource.Contains(
      "revoke all on function public.vault_touch_updated_at() from public"
    )) `
  "Vault prerequisite must contain only the required crypto and trigger support"
Assert-Contract `
  (-not $prerequisiteSource.Contains("create table") -and
    -not $prerequisiteSource.Contains("storage.") -and
    -not $prerequisiteSource.Contains("scenes")) `
  "Vault prerequisite must not create product, Storage, or plain-scene data"
Assert-Contract `
  ($storageSource.Contains("on conflict (id) do nothing") -and
    -not $storageSource.Contains("on conflict (id) do update")) `
  "existing Storage bucket configuration must fail validation instead of being mutated"
Assert-Contract `
  $storageSmoke.Contains("roles && array['public', 'anon', 'authenticated']::name[]") `
  "isolated Storage smoke must reject client storage.objects policies"
Assert-Contract `
  $storageSmoke.Contains("c.relrowsecurity is true") `
  "Storage smoke must verify storage.objects RLS"
$dockerPsqlEnvironmentFields = @(
  "PGHOST",
  "PGPORT",
  "PGUSER",
  "PGPASSWORD",
  "PGDATABASE",
  "PGCONNECT_TIMEOUT",
  "PGSSLMODE",
  "PGSSLROOTCERT"
)
foreach ($field in $dockerPsqlEnvironmentFields) {
  Assert-Contract `
    ($windowsSource.Contains('"-e", "' + $field + '"') -and
      -not $windowsSource.Contains('"-e", $env:' + $field)) `
    "Docker-backed psql must pass $field by environment name only"
}
Assert-Contract `
  (-not $windowsSource.Contains("registry-1.docker.io") -and
    $windowsSource.Contains('Invoke-CheckedCommand $docker.Source @("pull", $PostgresImage)')) `
  "Docker-backed psql must use docker pull instead of a host HttpClient registry probe"
Assert-Contract `
  $windowsSource.Contains("[Net.IPAddress]::IsLoopback") `
  "Docker-backed psql must map IPv4 and IPv6 loopback targets into the host"
Assert-Contract `
  ($windowsSource.Contains('"--mount"') -and
    $windowsSource.Contains(
      '"type=bind,source=$resolvedFile,target=$containerFile,readonly"'
    ) -and
    $windowsSource.Contains('$translatedArguments.Add("--file=$containerFile")')) `
  "Docker-backed psql must mount workflow SQL files read-only into the container"

$capturedPsqlArguments = @()
$capturedPsqlEnvironment = @{}
$psqlContractExitCode = 0
function psql {
  param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$PsqlArguments
  )

  $script:capturedPsqlArguments = @($PsqlArguments)
  $script:capturedPsqlEnvironment = @{}
  foreach ($field in $dockerPsqlEnvironmentFields) {
    $script:capturedPsqlEnvironment[$field] =
      [Environment]::GetEnvironmentVariable($field, "Process")
  }
  $global:LASTEXITCODE = $script:psqlContractExitCode
}

$secretDatabaseUrl =
  "postgresql://postgres.${projectRef}:do-not-leak%3Aopaque@aws-0-region.pooler.supabase.com:6543/postgres?sslmode=verify-full&sslrootcert=system"
$originalPsqlEnvironment = @{}
$contractPsqlEnvironment = @{
  PGHOST = $null
  PGPORT = "10001"
  PGUSER = "contract-user-before"
  PGPASSWORD = "contract-password-before"
  PGDATABASE = "contract-database-before"
  PGCONNECT_TIMEOUT = "77"
  PGSSLMODE = "prefer"
  PGSSLROOTCERT = "contract-root-before"
}
foreach ($field in $dockerPsqlEnvironmentFields) {
  $originalPsqlEnvironment[$field] =
    [Environment]::GetEnvironmentVariable($field, "Process")
}
try {
  foreach ($field in $dockerPsqlEnvironmentFields) {
    [Environment]::SetEnvironmentVariable(
      $field,
      $contractPsqlEnvironment[$field],
      "Process"
    )
  }
  Install-VaultSchema $secretDatabaseUrl
  Assert-Contract `
    ($capturedPsqlEnvironment["PGHOST"] -ceq "aws-0-region.pooler.supabase.com") `
    "psql must receive the parsed database host"
  Assert-Contract `
    ($capturedPsqlEnvironment["PGPORT"] -ceq "6543") `
    "psql must receive the parsed database port"
  Assert-Contract `
    ($capturedPsqlEnvironment["PGUSER"] -ceq "postgres.$projectRef") `
    "psql must receive the decoded database user"
  Assert-Contract `
    ($capturedPsqlEnvironment["PGPASSWORD"] -ceq "do-not-leak:opaque") `
    "psql must receive the decoded database password"
  Assert-Contract `
    ($capturedPsqlEnvironment["PGDATABASE"] -ceq "postgres") `
    "psql must receive the parsed database name instead of the database URL"
  Assert-Contract `
    ($capturedPsqlEnvironment["PGSSLMODE"] -ceq "verify-full") `
    "remote psql must receive sslmode=verify-full"
  Assert-Contract `
    ($capturedPsqlEnvironment["PGSSLROOTCERT"] -ceq "system") `
    "remote psql must use the operating-system root certificate store"
  Assert-Contract `
    ($capturedPsqlEnvironment["PGCONNECT_TIMEOUT"] -ceq "10") `
    "psql must receive a bounded connect timeout"
  Assert-Contract `
    (-not (($capturedPsqlArguments -join " ").Contains("do-not-leak")) -and
      -not (($capturedPsqlArguments -join " ").Contains($secretDatabaseUrl))) `
    "database URL and credentials must not enter psql argv"
  Assert-Contract `
    ($capturedPsqlArguments -contains "--single-transaction") `
    "schema install must use a single transaction"
  $capturedFiles = @($capturedPsqlArguments | Where-Object {
      $_.StartsWith("--file=")
    } | ForEach-Object {
      Split-Path $_.Substring("--file=".Length) -Leaf
    })
  Assert-Contract `
    (($capturedFiles[0..2] -join ",") -ceq ($script:VaultSchemaInstallOrder -join ",") -and
      $capturedFiles.Count -eq 4 -and
      $capturedFiles[3].EndsWith("20260716193000_add_vault_deployment_contract.sql")) `
    "psql argv must preserve the frozen Vault migration order"
  foreach ($field in $dockerPsqlEnvironmentFields) {
    Assert-Contract `
      ([Environment]::GetEnvironmentVariable($field, "Process") -ceq
        $contractPsqlEnvironment[$field]) `
      "database environment field $field must be restored after psql succeeds"
  }

  $script:psqlContractExitCode = 19
  Assert-ContractThrows {
    Test-VaultSchema `
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
  } "psql failure propagation"
  Assert-Contract `
    ($capturedPsqlEnvironment["PGSSLMODE"] -ceq "disable") `
    "local psql must receive sslmode=disable"
  Assert-Contract `
    ($null -eq $capturedPsqlEnvironment["PGSSLROOTCERT"]) `
    "local psql must not inherit a remote root certificate override"
  foreach ($field in $dockerPsqlEnvironmentFields) {
    Assert-Contract `
      ([Environment]::GetEnvironmentVariable($field, "Process") -ceq
        $contractPsqlEnvironment[$field]) `
      "database environment field $field must be restored after psql fails"
  }
} finally {
  foreach ($field in $dockerPsqlEnvironmentFields) {
    [Environment]::SetEnvironmentVariable(
      $field,
      $originalPsqlEnvironment[$field],
      "Process"
    )
  }
  Remove-Item -LiteralPath Function:\psql -Force -ErrorAction SilentlyContinue
}

$ignoredEnv = Join-Path $PSScriptRoot "contracts-$([Guid]::NewGuid().ToString('N')).local.env"
$trackedEnv = Join-Path $PSScriptRoot "contracts-$([Guid]::NewGuid().ToString('N')).env"
$previousValue = $env:VAULT_CONTRACT_VALUE
try {
  [IO.File]::WriteAllText($ignoredEnv, "VAULT_CONTRACT_VALUE=loaded")
  Import-VaultEnvironment $ignoredEnv
  Assert-Contract ($env:VAULT_CONTRACT_VALUE -eq "loaded") "ignored environment file must load"

  [IO.File]::WriteAllText($trackedEnv, "VAULT_CONTRACT_VALUE=unsafe")
  Assert-ContractThrows {
    Import-VaultEnvironment $trackedEnv
  } "non-ignored repository environment file"
} finally {
  $env:VAULT_CONTRACT_VALUE = $previousValue
  Remove-Item -LiteralPath $ignoredEnv, $trackedEnv -Force -ErrorAction SilentlyContinue
}

Write-Output "Vault dual-environment script contracts passed."
