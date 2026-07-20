param(
  [string]$EnvFile = "",
  [ValidateSet("local", "remote")]
  [string]$Target = "local"
)

. (Join-Path $PSScriptRoot "common.ps1")
Import-VaultEnvironment $EnvFile

$ProjectRef = $env:VAULT_SUPABASE_PROJECT_REF
$DatabaseUrl = if ($Target -eq "remote") {
  $env:VAULT_SUPABASE_DB_URL
} else {
  $env:VAULT_LOCAL_DATABASE_URL
}
if ($Target -eq "local" -and [string]::IsNullOrWhiteSpace($DatabaseUrl)) {
  $DatabaseUrl = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
}
if ($Target -eq "remote") {
  if ([string]::IsNullOrWhiteSpace($DatabaseUrl)) {
    throw "VAULT_SUPABASE_DB_URL is required for the remote CAS gate"
  }
  Assert-VaultPostgresUrl $DatabaseUrl "remote" $ProjectRef
  Assert-VaultRemoteConfirmation `
    $ProjectRef `
    $env:VAULT_REMOTE_CONFIRM_PROJECT_REF `
    $env:VAULT_REMOTE_CONFIRM_DISPOSABLE
  $rootCertPath = $env:VAULT_SUPABASE_SSLROOTCERT_PATH
  if (
    [string]::IsNullOrWhiteSpace($rootCertPath) -or
    -not (Test-Path -LiteralPath $rootCertPath -PathType Leaf)
  ) {
    throw "VAULT_SUPABASE_SSLROOTCERT_PATH must point to the downloaded Supabase CA certificate"
  }
} else {
  Assert-VaultPostgresUrl $DatabaseUrl "local"
}
Assert-VaultCommand "psql"

$gateObservationTimeoutSeconds = if ($Target -eq "remote") { 90 } else { 45 }
$gateSessionTimeoutMilliseconds = if ($Target -eq "remote") { 120000 } else { 30000 }
$gateLockHoldSeconds = if ($Target -eq "remote") { 60 } else { 20 }

function Set-VaultGatePostgresEnvironment {
  param([Parameter(Mandatory = $true)][Uri]$Uri)

  $userInfo = $Uri.UserInfo.Split(":", 2)
  $env:PGHOST = $Uri.Host
  $env:PGPORT = $Uri.Port.ToString()
  $env:PGUSER = [Uri]::UnescapeDataString($userInfo[0])
  $env:PGPASSWORD = [Uri]::UnescapeDataString($userInfo[1])
  $env:PGDATABASE = [Uri]::UnescapeDataString($Uri.AbsolutePath.TrimStart("/"))
  if ($Target -eq "remote") {
    $env:PGSSLMODE = "verify-full"
    $env:PGSSLROOTCERT = (
      Resolve-Path -LiteralPath $env:VAULT_SUPABASE_SSLROOTCERT_PATH
    ).Path
  } else {
    $env:PGSSLMODE = "disable"
    $env:PGSSLROOTCERT = $null
  }
  $env:PGCONNECT_TIMEOUT = "10"
}

function Write-GateSqlFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Contents
  )

  [IO.File]::WriteAllText(
    $Path,
    $Contents,
    [Text.UTF8Encoding]::new($false)
  )
}

function Invoke-GatePsqlFile {
  param([Parameter(Mandatory = $true)][string]$Path)

  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = & psql -X -q --set=ON_ERROR_STOP=1 "--file=$Path" 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -ne 0) {
    throw "Vault $Target gate SQL command failed"
  }
  return @($output)
}

function Invoke-GatePsqlScalar {
  param([Parameter(Mandatory = $true)][string]$Sql)

  $commandSql = ($Sql -replace "[\r\n]+", " ").Trim()
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = & psql -X -Atq --set=ON_ERROR_STOP=1 "--command=$commandSql" 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -ne 0) {
    throw "Vault $Target gate observation query failed"
  }
  $lines = @($output | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ })
  if ($lines.Count -eq 0) {
    throw "Vault local gate observation returned no result"
  }
  return $lines[-1]
}

function Start-GateSession {
  param(
    [Parameter(Mandatory = $true)][string]$SqlPath,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [Parameter(Mandatory = $true)][string]$ErrorPath
  )

  $psql = (Get-Command "psql").Source
  return Start-Process `
    -FilePath $psql `
    -ArgumentList @("-X", "-q", "--set=ON_ERROR_STOP=1", "--file=$SqlPath") `
    -RedirectStandardOutput $OutputPath `
    -RedirectStandardError $ErrorPath `
    -WindowStyle Hidden `
    -PassThru
}

function Wait-GateCondition {
  param(
    [Parameter(Mandatory = $true)][string]$Sql,
    [Parameter(Mandatory = $true)][string]$Description,
    # Hosted Supabase can take several seconds to expose pg_stat_activity
    # state even though the lock is already held. Keep the assertion strict,
    # but make the observation window realistic for both local Docker and the
    # isolated remote project.
    [int]$TimeoutSeconds = 45
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if ((Invoke-GatePsqlScalar $Sql) -eq "1") {
      return
    }
    Start-Sleep -Milliseconds 150
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Timed out waiting for $Description"
}

function Wait-GateSession {
  param(
    [Parameter(Mandatory = $true)]$Process,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [Parameter(Mandatory = $true)][string]$ErrorPath,
    [Parameter(Mandatory = $true)][string]$ExpectedMarker,
    [Parameter(Mandatory = $true)][string]$Description
  )

  if (-not $Process.WaitForExit($gateSessionTimeoutMilliseconds)) {
    throw "Timed out waiting for $Description"
  }
  $Process.Refresh()
  $exitCode = $Process.ExitCode
  $hasCompletionMarker = Select-String `
    -LiteralPath $OutputPath `
    -SimpleMatch $ExpectedMarker `
    -Quiet
  # Windows PowerShell may not expose ExitCode when Start-Process launches a
  # .cmd shim. The end-of-file marker remains authoritative because psql uses
  # ON_ERROR_STOP and emits it only after COMMIT.
  if ($null -ne $exitCode -and $exitCode -ne 0 -and -not $hasCompletionMarker) {
    $diagnostic = "database session exited with a non-zero status"
    foreach ($diagnosticPath in @($ErrorPath, $OutputPath)) {
      if (Test-Path -LiteralPath $diagnosticPath) {
        $errorLines = @(Get-Content -LiteralPath $diagnosticPath | Where-Object { $_ })
        if ($errorLines.Count -gt 0) {
          $diagnostic = $errorLines[-1] -replace "[A-Za-z0-9_-]{43}", "[redacted]"
          break
        }
      }
    }
    throw "$Description failed: $diagnostic"
  }
  if (-not $hasCompletionMarker) {
    throw "$Description did not emit its completion marker"
  }
}

$previousValues = @{}
foreach ($name in @(
    "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE",
    "PGSSLMODE", "PGSSLROOTCERT", "PGCONNECT_TIMEOUT"
  )) {
  $previousValues[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

$runToken = [Guid]::NewGuid().ToString("N").Substring(0, 10)
$ownerId = [Guid]::NewGuid().ToString()
$casVaultId = [Guid]::NewGuid().ToString()
$casInvitationId = [Guid]::NewGuid().ToString()
$casWinnerMessageId = [Guid]::NewGuid().ToString()
$casLoserMessageId = [Guid]::NewGuid().ToString()
$revokeVaultId = [Guid]::NewGuid().ToString()
$revokeInvitationId = [Guid]::NewGuid().ToString()
$revokeMessageId = [Guid]::NewGuid().ToString()
$applicationPrefix = "vault-gate-$runToken"
$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) "excalidraw-vault-$runToken"
$processes = [System.Collections.Generic.List[object]]::new()
$fixtureInstalled = $false

try {
  Set-VaultGatePostgresEnvironment ([Uri]$DatabaseUrl)
  $null = New-Item -ItemType Directory -Path $temporaryDirectory -Force

  if ((Invoke-GatePsqlScalar @"
select case when
  to_regprocedure('public.cas_vault_snapshot(uuid,text,bigint,jsonb,bigint)') is not null
  and to_regprocedure('public.revoke_vault_invitation(uuid,uuid)') is not null
then 1 else 0 end
"@) -ne "1") {
    throw "Vault schema is not installed in the $Target Supabase database"
  }

  $setupPath = Join-Path $temporaryDirectory "setup.sql"
  $setupSql = @'
begin;
insert into auth.users (
  id, aud, role, email, encrypted_password, created_at, updated_at
) values (
  '__OWNER_ID__', 'authenticated', 'authenticated',
  'vault-local-gate-__RUN_TOKEN__@example.invalid', '', now(), now()
);

insert into public.vaults (
  id, owner_id, state, protocol_version, active_room_id, snapshot_generation
) values
  ('__CAS_VAULT_ID__', '__OWNER_ID__', 'active', 1, 'vaultcas__RUN_TOKEN__', 0),
  ('__REVOKE_VAULT_ID__', '__OWNER_ID__', 'active', 1, 'vaultrevoke__RUN_TOKEN__', 0);

insert into public.vault_invitations (
  id, vault_id, role, capability_hash, authorization_version,
  created_by, expires_at, revoked_at
) values
  (
    '__CAS_INVITATION_ID__', '__CAS_VAULT_ID__', 'editor',
    public.vault_capability_hash('__CAS_VAULT_ID__', repeat('K', 43)),
    1, '__OWNER_ID__', now() + interval '1 hour', null
  ),
  (
    '__REVOKE_INVITATION_ID__', '__REVOKE_VAULT_ID__', 'editor',
    public.vault_capability_hash('__REVOKE_VAULT_ID__', repeat('R', 43)),
    1, '__OWNER_ID__', now() + interval '1 hour', null
  );
commit;
'@
  $setupSql = $setupSql.Replace("__OWNER_ID__", $ownerId).
    Replace("__RUN_TOKEN__", $runToken).
    Replace("__CAS_VAULT_ID__", $casVaultId).
    Replace("__CAS_INVITATION_ID__", $casInvitationId).
    Replace("__REVOKE_VAULT_ID__", $revokeVaultId).
    Replace("__REVOKE_INVITATION_ID__", $revokeInvitationId)
  Write-GateSqlFile $setupPath $setupSql
  $null = Invoke-GatePsqlFile $setupPath
  $fixtureInstalled = $true

  $casAPath = Join-Path $temporaryDirectory "cas-a.sql"
  $casBPath = Join-Path $temporaryDirectory "cas-b.sql"
  $casAOutput = Join-Path $temporaryDirectory "cas-a.out"
  $casAError = Join-Path $temporaryDirectory "cas-a.err"
  $casBOutput = Join-Path $temporaryDirectory "cas-b.out"
  $casBError = Join-Path $temporaryDirectory "cas-b.err"

  $casATemplate = @'
set application_name = '__APP_NAME__';
begin;
set local role anon;
do $$
declare
  v_result jsonb;
  v_envelope jsonb := jsonb_build_object(
    'version', 1,
    'vaultId', '__VAULT_ID__',
    'purpose', 'snapshot',
    'messageType', 'snapshot.scene',
    'messageId', '__MESSAGE_ID__',
    'generation', 1,
    'iv', 'AAAAAAAAAAAAAAAA',
    'ciphertext', 'AQ'
  );
begin
  v_result := public.cas_vault_snapshot(
    '__VAULT_ID__', repeat('K', 43), 0, v_envelope, 1
  );
  if (v_result ->> 'generation')::bigint <> 1 then
    raise exception 'CAS_WINNER_GENERATION_MISMATCH';
  end if;
end;
$$;
-- Keep the aggregate lock long enough for a hosted psql shim process to
-- start and become observable through pg_stat_activity.
select pg_sleep(__LOCK_HOLD_SECONDS__);
commit;
\echo CAS_WRITER_A_COMMITTED
'@
  $casASql = $casATemplate.Replace("__APP_NAME__", "$applicationPrefix-cas-a").
    Replace("__VAULT_ID__", $casVaultId).
    Replace("__MESSAGE_ID__", $casWinnerMessageId).
    Replace("__LOCK_HOLD_SECONDS__", $gateLockHoldSeconds.ToString())
  Write-GateSqlFile $casAPath $casASql

  $casBTemplate = @'
set application_name = '__APP_NAME__';
begin;
set local role anon;
do $$
declare
  v_envelope jsonb := jsonb_build_object(
    'version', 1,
    'vaultId', '__VAULT_ID__',
    'purpose', 'snapshot',
    'messageType', 'snapshot.scene',
    'messageId', '__MESSAGE_ID__',
    'generation', 1,
    'iv', 'AAAAAAAAAAAAAAAA',
    'ciphertext', 'Ag'
  );
begin
  begin
    perform public.cas_vault_snapshot(
      '__VAULT_ID__', repeat('K', 43), 0, v_envelope, 1
    );
    raise exception 'CAS_SECOND_WRITER_UNEXPECTEDLY_SUCCEEDED';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'VAULT_SNAPSHOT_CONFLICT' then
      raise;
    end if;
  end;
end;
$$;
commit;
\echo CAS_WRITER_B_CONFLICT_CONFIRMED
'@
  $casBSql = $casBTemplate.Replace("__APP_NAME__", "$applicationPrefix-cas-b").
    Replace("__VAULT_ID__", $casVaultId).
    Replace("__MESSAGE_ID__", $casLoserMessageId)
  Write-GateSqlFile $casBPath $casBSql

  $casA = Start-GateSession $casAPath $casAOutput $casAError
  $processes.Add($casA)
  Wait-GateCondition `
    "select count(*) from pg_stat_activity where application_name = '$applicationPrefix-cas-a' and wait_event = 'PgSleep'" `
    "the first CAS writer to hold its transaction lock" `
    $gateObservationTimeoutSeconds

  $casB = Start-GateSession $casBPath $casBOutput $casBError
  $processes.Add($casB)
  Wait-GateCondition `
    "select count(*) from pg_stat_activity where application_name = '$applicationPrefix-cas-b' and cardinality(pg_blocking_pids(pid)) > 0" `
    "the second CAS writer to block on the aggregate lock" `
    $gateObservationTimeoutSeconds

  Wait-GateSession $casA $casAOutput $casAError "CAS_WRITER_A_COMMITTED" "first CAS writer"
  Wait-GateSession $casB $casBOutput $casBError "CAS_WRITER_B_CONFLICT_CONFIRMED" "second CAS writer"

  $casValidationPath = Join-Path $temporaryDirectory "cas-validation.sql"
  $casValidationTemplate = @'
do $$
begin
  if not exists (
    select 1
    from public.vaults v
    join public.vault_snapshots s on s.vault_id = v.id
    where v.id = '__VAULT_ID__'
      and v.snapshot_generation = 1
      and s.generation = 1
      and s.encrypted_envelope ->> 'messageId' = '__MESSAGE_ID__'
  ) then
    raise exception 'CAS_COMMITTED_STATE_MISMATCH';
  end if;
end;
$$;
\echo CAS_COMMITTED_STATE_CONFIRMED
'@
  $casValidationSql = $casValidationTemplate.Replace("__VAULT_ID__", $casVaultId).
    Replace("__MESSAGE_ID__", $casWinnerMessageId).
    Replace("__LOCK_HOLD_SECONDS__", $gateLockHoldSeconds.ToString())
  Write-GateSqlFile $casValidationPath $casValidationSql
  $casValidationOutput = Invoke-GatePsqlFile $casValidationPath
  if (-not ($casValidationOutput -match "CAS_COMMITTED_STATE_CONFIRMED")) {
    throw "CAS committed-state validation did not complete"
  }

  $revokeCasPath = Join-Path $temporaryDirectory "revoke-cas.sql"
  $revokeOwnerPath = Join-Path $temporaryDirectory "revoke-owner.sql"
  $revokeCasOutput = Join-Path $temporaryDirectory "revoke-cas.out"
  $revokeCasError = Join-Path $temporaryDirectory "revoke-cas.err"
  $revokeOwnerOutput = Join-Path $temporaryDirectory "revoke-owner.out"
  $revokeOwnerError = Join-Path $temporaryDirectory "revoke-owner.err"

  $revokeCasTemplate = @'
set application_name = '__APP_NAME__';
begin;
set local role anon;
do $$
declare
  v_result jsonb;
  v_envelope jsonb := jsonb_build_object(
    'version', 1,
    'vaultId', '__VAULT_ID__',
    'purpose', 'snapshot',
    'messageType', 'snapshot.scene',
    'messageId', '__MESSAGE_ID__',
    'generation', 1,
    'iv', 'AAAAAAAAAAAAAAAA',
    'ciphertext', 'Aw'
  );
begin
  v_result := public.cas_vault_snapshot(
    '__VAULT_ID__', repeat('R', 43), 0, v_envelope, 1
  );
  if (v_result ->> 'generation')::bigint <> 1 then
    raise exception 'REVOKE_CAS_GENERATION_MISMATCH';
  end if;
end;
$$;
-- Keep the invitation lock long enough for the isolated hosted-project
-- revoker process to start and become observable.
select pg_sleep(__LOCK_HOLD_SECONDS__);
commit;
\echo REVOKE_CAS_COMMITTED
'@
  $revokeCasSql = $revokeCasTemplate.Replace("__APP_NAME__", "$applicationPrefix-revoke-cas").
    Replace("__VAULT_ID__", $revokeVaultId).
    Replace("__MESSAGE_ID__", $revokeMessageId).
    Replace("__LOCK_HOLD_SECONDS__", $gateLockHoldSeconds.ToString())
  Write-GateSqlFile $revokeCasPath $revokeCasSql

  $revokeOwnerTemplate = @'
set application_name = '__APP_NAME__';
begin;
select set_config('request.jwt.claim.sub', '__OWNER_ID__', true);
set local role authenticated;
do $$
declare
  v_result jsonb;
begin
  v_result := public.revoke_vault_invitation(
    '__VAULT_ID__', '__INVITATION_ID__'
  );
  if v_result ->> 'reason' <> 'revoked'
    or (v_result ->> 'authorizationVersion')::bigint <> 2
  then
    raise exception 'REVOKE_RESULT_MISMATCH';
  end if;
end;
$$;
commit;
\echo REVOKE_COMMITTED
'@
  $revokeOwnerSql = $revokeOwnerTemplate.Replace("__APP_NAME__", "$applicationPrefix-revoke-owner").
    Replace("__OWNER_ID__", $ownerId).
    Replace("__VAULT_ID__", $revokeVaultId).
    Replace("__INVITATION_ID__", $revokeInvitationId)
  Write-GateSqlFile $revokeOwnerPath $revokeOwnerSql

  $revokeCas = Start-GateSession $revokeCasPath $revokeCasOutput $revokeCasError
  $processes.Add($revokeCas)
  Wait-GateCondition `
    "select count(*) from pg_stat_activity where application_name = '$applicationPrefix-revoke-cas' and wait_event = 'PgSleep'" `
    "the in-flight CAS transaction to hold its invitation lock" `
    $gateObservationTimeoutSeconds

  $revokeOwner = Start-GateSession $revokeOwnerPath $revokeOwnerOutput $revokeOwnerError
  $processes.Add($revokeOwner)
  Wait-GateCondition `
    "select count(*) from pg_stat_activity where application_name = '$applicationPrefix-revoke-owner' and cardinality(pg_blocking_pids(pid)) > 0" `
    "the invitation revoke to block behind the in-flight CAS" `
    $gateObservationTimeoutSeconds

  Wait-GateSession $revokeCas $revokeCasOutput $revokeCasError "REVOKE_CAS_COMMITTED" "in-flight CAS writer"
  Wait-GateSession $revokeOwner $revokeOwnerOutput $revokeOwnerError "REVOKE_COMMITTED" "invitation revoker"

  $revokeValidationPath = Join-Path $temporaryDirectory "revoke-validation.sql"
  $revokeValidationTemplate = @'
do $$
begin
  if not exists (
    select 1
    from public.vaults v
    join public.vault_snapshots s on s.vault_id = v.id
    join public.vault_invitations i on i.vault_id = v.id
    where v.id = '__VAULT_ID__'
      and v.snapshot_generation = 1
      and s.generation = 1
      and i.id = '__INVITATION_ID__'
      and i.revoked_at is not null
      and i.authorization_version = 2
  ) then
    raise exception 'REVOKE_COMMITTED_STATE_MISMATCH';
  end if;
end;
$$;

set role anon;
do $$
declare
  v_envelope jsonb := jsonb_build_object(
    'version', 1,
    'vaultId', '__VAULT_ID__',
    'purpose', 'snapshot',
    'messageType', 'snapshot.scene',
    'messageId', '__POST_REVOKE_MESSAGE_ID__',
    'generation', 2,
    'iv', 'AAAAAAAAAAAAAAAA',
    'ciphertext', 'BA'
  );
begin
  begin
    perform public.cas_vault_snapshot(
      '__VAULT_ID__', repeat('R', 43), 1, v_envelope, 1
    );
    raise exception 'POST_REVOKE_CAS_UNEXPECTEDLY_SUCCEEDED';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'VAULT_CAPABILITY_REVOKED' then
      raise;
    end if;
  end;
end;
$$;
reset role;
\echo REVOKE_BLOCK_AND_POST_REVOKE_REJECTION_CONFIRMED
'@
  $revokeValidationSql = $revokeValidationTemplate.Replace("__VAULT_ID__", $revokeVaultId).
    Replace("__INVITATION_ID__", $revokeInvitationId).
    Replace("__POST_REVOKE_MESSAGE_ID__", [Guid]::NewGuid().ToString())
  Write-GateSqlFile $revokeValidationPath $revokeValidationSql
  $revokeValidationOutput = Invoke-GatePsqlFile $revokeValidationPath
  if (-not ($revokeValidationOutput -match "REVOKE_BLOCK_AND_POST_REVOKE_REJECTION_CONFIRMED")) {
    throw "Revoke committed-state validation did not complete"
  }

  Write-Output "Vault $Target CAS gate passed: one concurrent writer committed and the other returned VAULT_SNAPSHOT_CONFLICT."
  Write-Output "Vault $Target revoke/lock gate passed: revoke blocked behind the in-flight CAS, then post-revoke writes were rejected."
} finally {
  try {
    Set-VaultGatePostgresEnvironment ([Uri]$DatabaseUrl)
    $null = Invoke-GatePsqlScalar @"
select count(*)
from (
  select pg_terminate_backend(pid)
  from pg_stat_activity
  where pid <> pg_backend_pid()
    and application_name like '$applicationPrefix%'
) terminated
"@
  } catch {
    # Best-effort termination is followed by fixture cleanup below.
  }

  foreach ($process in $processes) {
    try {
      if (-not $process.HasExited) {
        $null = $process.WaitForExit(5000)
      }
    } catch {
      # Process cleanup must not hide the original gate result.
    }
  }

  if ($fixtureInstalled -and (Test-Path -LiteralPath $temporaryDirectory)) {
    try {
      $cleanupPath = Join-Path $temporaryDirectory "cleanup.sql"
      $cleanupSql = @'
begin;
delete from public.vaults where id in ('__CAS_VAULT_ID__', '__REVOKE_VAULT_ID__');
delete from auth.users where id = '__OWNER_ID__';
commit;
'@
      $cleanupSql = $cleanupSql.Replace("__CAS_VAULT_ID__", $casVaultId).
        Replace("__REVOKE_VAULT_ID__", $revokeVaultId).
        Replace("__OWNER_ID__", $ownerId)
      Write-GateSqlFile $cleanupPath $cleanupSql
      $null = Invoke-GatePsqlFile $cleanupPath
    } catch {
      Write-Warning "Vault $Target gate fixture cleanup failed; inspect only the generated test UUID rows."
    }
  }

  if (Test-Path -LiteralPath $temporaryDirectory) {
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
  foreach ($name in $previousValues.Keys) {
    [Environment]::SetEnvironmentVariable($name, $previousValues[$name], "Process")
  }
}
