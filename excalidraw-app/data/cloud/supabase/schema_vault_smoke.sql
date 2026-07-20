-- P4a Vault Online F2 schema/security smoke.
-- Run after schema_vault.sql in an isolated Supabase test project.
-- The fixture section is wrapped in a transaction and always rolls back. Run
-- the separate two-session CAS block at the end when validating real lock
-- concurrency from psql or a Supabase migration test runner.

do $$
declare
  v_missing text[];
begin
  select array_agg(required.name)
  into v_missing
  from (
    values
      ('vault_deployment_metadata'),
      ('vaults'),
      ('vault_invitations'),
      ('vault_snapshots'),
      ('vault_assets')
  ) as required(name)
  where to_regclass('public.' || required.name) is null;

  if v_missing is not null then
    raise exception 'missing Vault tables: %', v_missing;
  end if;
end;
$$;

do $$
declare
  v_missing text[];
begin
  select array_agg(required.signature)
  into v_missing
  from (
    values
      ('get_vault_deployment_contract()'),
      ('create_vault(uuid,smallint,text,timestamp with time zone)'),
      ('activate_vault(uuid,text)'),
      ('fail_vault_creation(uuid)'),
      ('create_vault_invitation(uuid,text,text,timestamp with time zone)'),
      ('resolve_vault_capability(uuid,text)'),
      ('load_vault_snapshot(uuid,text)'),
      ('cas_vault_snapshot(uuid,text,bigint,jsonb,bigint)'),
      ('register_vault_asset(uuid,text,text,text,bigint)'),
      ('complete_vault_asset(uuid,text,text,text,bigint)'),
      ('resolve_vault_asset(uuid,text,text)'),
      ('revoke_vault_invitation(uuid,uuid)'),
      ('revoke_vault(uuid)'),
      ('soft_delete_vault(uuid)')
  ) as required(signature)
  where to_regprocedure('public.' || required.signature) is null;

  if v_missing is not null then
    raise exception 'missing Vault RPCs: %', v_missing;
  end if;
end;
$$;

do $$
declare
  v_table text;
begin
  foreach v_table in array array['vault_deployment_metadata','vaults','vault_invitations','vault_snapshots','vault_assets']
  loop
    if not exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_table and c.relrowsecurity
    ) then
      raise exception 'RLS not enabled for public.%', v_table;
    end if;
  end loop;
end;
$$;

do $$
declare
  v_contract jsonb;
begin
  select public.get_vault_deployment_contract() into v_contract;
  if v_contract <> jsonb_build_object(
    'deploymentVersion', 'p4a-f4-v1',
    'schemaVersion', 1,
    'protocolVersion', 1
  ) then
    raise exception 'unexpected Vault deployment contract: %', v_contract;
  end if;
  if has_table_privilege('anon', 'public.vault_deployment_metadata', 'SELECT')
    or has_table_privilege('authenticated', 'public.vault_deployment_metadata', 'SELECT')
    or has_function_privilege('anon', 'public.get_vault_deployment_contract()', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.get_vault_deployment_contract()', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.get_vault_deployment_contract()', 'EXECUTE')
  then
    raise exception 'Vault deployment contract privilege drift';
  end if;
end;
$$;

do $$
begin
  if has_table_privilege('anon', 'public.vaults', 'SELECT')
    or has_table_privilege('anon', 'public.vault_invitations', 'SELECT')
    or has_table_privilege('anon', 'public.vault_snapshots', 'SELECT')
    or has_table_privilege('anon', 'public.vault_assets', 'SELECT')
  then
    raise exception 'anon must not enumerate Vault tables';
  end if;
  if has_table_privilege('authenticated', 'public.vaults', 'SELECT')
    or has_table_privilege('authenticated', 'public.vault_invitations', 'SELECT')
    or has_table_privilege('authenticated', 'public.vault_snapshots', 'SELECT')
    or has_table_privilege('authenticated', 'public.vault_assets', 'SELECT')
  then
    raise exception 'authenticated must not enumerate Vault tables';
  end if;
  if has_function_privilege(
    'anon',
    'public.complete_vault_asset(uuid,text,text,text,bigint)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.complete_vault_asset(uuid,text,text,text,bigint)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.complete_vault_asset(uuid,text,text,text,bigint)',
    'EXECUTE'
  ) then
    raise exception 'complete_vault_asset execute grants are unsafe';
  end if;
  if not has_function_privilege(
    'service_role',
    'public.resolve_vault_capability(uuid,text)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.register_vault_asset(uuid,text,text,text,bigint)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.resolve_vault_asset(uuid,text,text)',
    'EXECUTE'
  ) then
    raise exception 'vault-asset-access service-role RPC grants are incomplete';
  end if;
end;
$$;

do $$
declare
  v_role text;
  v_table text;
  v_privilege text;
  v_signature text;
  v_function regprocedure;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_table in array array[
      'vaults', 'vault_invitations', 'vault_snapshots', 'vault_assets'
    ] loop
      foreach v_privilege in array array[
        'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
      ] loop
        if has_table_privilege(
          v_role,
          format('public.%I', v_table),
          v_privilege
        ) then
          raise exception '% has forbidden % privilege on public.%',
            v_role, v_privilege, v_table;
        end if;
      end loop;
    end loop;
  end loop;

  foreach v_signature in array array[
    'resolve_vault_capability_internal(uuid,text,text)',
    'create_vault(uuid,smallint,text,timestamp with time zone)',
    'activate_vault(uuid,text)',
    'fail_vault_creation(uuid)',
    'create_vault_invitation(uuid,text,text,timestamp with time zone)',
    'resolve_vault_capability(uuid,text)',
    'load_vault_snapshot(uuid,text)',
    'cas_vault_snapshot(uuid,text,bigint,jsonb,bigint)',
    'register_vault_asset(uuid,text,text,text,bigint)',
    'complete_vault_asset(uuid,text,text,text,bigint)',
    'resolve_vault_asset(uuid,text,text)',
    'revoke_vault_invitation(uuid,uuid)',
    'revoke_vault(uuid)',
    'soft_delete_vault(uuid)'
  ] loop
    v_function := to_regprocedure('public.' || v_signature);
    if v_function is null then
      raise exception 'missing security-definer function public.%', v_signature;
    end if;
    if not exists (
      select 1
      from pg_proc p
      where p.oid = v_function
        and p.prosecdef
        and exists (
          select 1
          from unnest(coalesce(p.proconfig, array[]::text[])) setting
          where setting like 'search_path=pg_catalog, public%'
        )
    ) then
      raise exception 'unsafe SECURITY DEFINER/search_path for public.%', v_signature;
    end if;
  end loop;

  if to_regprocedure('public.load_vault_snapshot(uuid)') is not null
    or to_regprocedure('public.cas_vault_snapshot(uuid,bigint,jsonb,bigint)') is not null
    or to_regprocedure('public.register_vault_asset(uuid,text,text,bigint)') is not null
  then
    raise exception 'Vault ID-only persistence overload must not exist';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name in ('vaults', 'vault_invitations', 'vault_snapshots', 'vault_assets')
      and column_name in (
        'capability', 'invitation_capability', 'content_key', 'root_key', 'room_key'
      )
  ) then
    raise exception 'raw Vault capability/key column exists';
  end if;

  foreach v_signature in array array[
    'vault_touch_updated_at()',
    'vault_capability_hash(uuid,text)',
    'vault_base64url_decode(text)',
    'assert_vault_envelope_v1(uuid,text,text,bigint,jsonb)',
    'resolve_vault_capability_internal(uuid,text,text)'
  ] loop
    if has_function_privilege(
      'anon', 'public.' || v_signature, 'EXECUTE'
    ) or has_function_privilege(
      'authenticated', 'public.' || v_signature, 'EXECUTE'
    ) then
      raise exception 'internal Vault helper is externally executable: public.%',
        v_signature;
    end if;
  end loop;
end;
$$;

do $$
declare
  v_ciphertext text := rtrim(translate(replace(replace(
    encode(decode(repeat('01', 96), 'hex'), 'base64'), E'\n', ''
  ), E'\r', ''), '+/', '-_'), '=');
  v_envelope jsonb;
begin
  if length(v_ciphertext) <= 76 then
    raise exception 'long Vault ciphertext fixture did not cross base64 wrap boundary';
  end if;
  v_envelope := jsonb_build_object(
    'version', 1,
    'vaultId', '10000000-0000-4000-8000-000000000001',
    'purpose', 'snapshot',
    'messageType', 'snapshot.scene',
    'messageId', '10000000-0000-4000-8000-000000000109',
    'generation', 1,
    'iv', 'AAAAAAAAAAAAAAAA',
    'ciphertext', v_ciphertext
  );
  perform public.assert_vault_envelope_v1(
    '10000000-0000-4000-8000-000000000001',
    'snapshot',
    'snapshot.scene',
    1,
    v_envelope
  );
end;
$$;

begin;

insert into auth.users (
  id, aud, role, email, encrypted_password, created_at, updated_at
) values (
  '10000000-0000-4000-8000-000000000002',
  'authenticated',
  'authenticated',
  'vault-schema-smoke@example.invalid',
  '',
  now(),
  now()
) on conflict (id) do nothing;

insert into public.vaults (
  id, owner_id, state, protocol_version, active_room_id, snapshot_generation
) values (
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  'active',
  1,
  'vaultsmokeroom01',
  0
);

insert into public.vault_invitations (
  id, vault_id, role, capability_hash, authorization_version,
  created_by, expires_at, revoked_at
) values
  (
    '10000000-0000-4000-8000-000000000011',
    '10000000-0000-4000-8000-000000000001',
    'editor',
    public.vault_capability_hash(
      '10000000-0000-4000-8000-000000000001', repeat('A', 43)
    ),
    1,
    '10000000-0000-4000-8000-000000000002',
    now() + interval '1 hour',
    null
  ),
  (
    '10000000-0000-4000-8000-000000000012',
    '10000000-0000-4000-8000-000000000001',
    'viewer',
    public.vault_capability_hash(
      '10000000-0000-4000-8000-000000000001', repeat('B', 43)
    ),
    1,
    '10000000-0000-4000-8000-000000000002',
    now() + interval '1 hour',
    null
  ),
  (
    '10000000-0000-4000-8000-000000000013',
    '10000000-0000-4000-8000-000000000001',
    'editor',
    public.vault_capability_hash(
      '10000000-0000-4000-8000-000000000001', repeat('C', 43)
    ),
    1,
    '10000000-0000-4000-8000-000000000002',
    now() - interval '1 minute',
    null
  ),
  (
    '10000000-0000-4000-8000-000000000014',
    '10000000-0000-4000-8000-000000000001',
    'editor',
    public.vault_capability_hash(
      '10000000-0000-4000-8000-000000000001', repeat('D', 43)
    ),
    2,
    '10000000-0000-4000-8000-000000000002',
    now() + interval '1 hour',
    now()
  );

set local role anon;

do $$
declare
  v_result jsonb;
  v_envelope jsonb := jsonb_build_object(
    'version', 1,
    'vaultId', '10000000-0000-4000-8000-000000000001',
    'purpose', 'snapshot',
    'messageType', 'snapshot.scene',
    'messageId', '10000000-0000-4000-8000-000000000101',
    'generation', 1,
    'iv', 'AAAAAAAAAAAAAAAA',
    'ciphertext', 'AQ'
  );
begin
  begin
    perform public.load_vault_snapshot(
      '10000000-0000-4000-8000-000000000001', repeat('Z', 43)
    );
    raise exception 'ID plus invalid capability unexpectedly loaded Vault';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'VAULT_CAPABILITY_INVALID' then raise; end if;
  end;

  if public.load_vault_snapshot(
    '10000000-0000-4000-8000-000000000001', repeat('B', 43)
  ) is not null then
    raise exception 'empty Vault unexpectedly returned a snapshot';
  end if;

  begin
    perform public.cas_vault_snapshot(
      '10000000-0000-4000-8000-000000000001',
      repeat('B', 43), 0, v_envelope, 1
    );
    raise exception 'viewer unexpectedly wrote snapshot';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'VAULT_CAPABILITY_FORBIDDEN' then raise; end if;
  end;

  begin
    perform public.register_vault_asset(
      '10000000-0000-4000-8000-000000000001',
      repeat('B', 43), 'assetfileid00001', repeat('E', 43), 1
    );
    raise exception 'viewer unexpectedly registered asset';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'VAULT_CAPABILITY_FORBIDDEN' then raise; end if;
  end;

  begin
    perform public.load_vault_snapshot(
      '10000000-0000-4000-8000-000000000001', repeat('C', 43)
    );
    raise exception 'expired capability unexpectedly loaded snapshot';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'VAULT_CAPABILITY_EXPIRED' then raise; end if;
  end;

  begin
    perform public.load_vault_snapshot(
      '10000000-0000-4000-8000-000000000001', repeat('D', 43)
    );
    raise exception 'revoked capability unexpectedly loaded snapshot';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'VAULT_CAPABILITY_REVOKED' then raise; end if;
  end;

  v_result := public.cas_vault_snapshot(
    '10000000-0000-4000-8000-000000000001',
    repeat('A', 43), 0, v_envelope, 1
  );
  if (v_result ->> 'generation')::bigint <> 1 then
    raise exception 'first editor CAS did not advance generation';
  end if;

  begin
    perform public.cas_vault_snapshot(
      '10000000-0000-4000-8000-000000000001',
      repeat('A', 43), 0, v_envelope, 1
    );
    raise exception 'stale editor CAS unexpectedly won';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'VAULT_SNAPSHOT_CONFLICT' then raise; end if;
  end;

  if (public.load_vault_snapshot(
    '10000000-0000-4000-8000-000000000001', repeat('B', 43)
  ) ->> 'generation')::bigint <> 1 then
    raise exception 'viewer could not read committed ciphertext generation';
  end if;

  perform public.register_vault_asset(
    '10000000-0000-4000-8000-000000000001',
    repeat('A', 43), 'assetfileid00001', repeat('E', 43), 1
  );
  perform public.register_vault_asset(
    '10000000-0000-4000-8000-000000000001',
    repeat('A', 43), 'assetfileid00001', repeat('E', 43), 1
  );

  begin
    perform public.register_vault_asset(
      '10000000-0000-4000-8000-000000000001',
      repeat('A', 43), 'assetfileid00001', repeat('F', 43), 1
    );
    raise exception 'asset digest conflict unexpectedly succeeded';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'VAULT_ASSET_CONFLICT' then raise; end if;
  end;

  begin
    perform public.complete_vault_asset(
      '10000000-0000-4000-8000-000000000001',
      repeat('A', 43), 'assetfileid00001', repeat('E', 43), 1
    );
    raise exception 'anon unexpectedly completed asset';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

reset role;
set local role service_role;

select public.complete_vault_asset(
  '10000000-0000-4000-8000-000000000001',
  repeat('A', 43),
  'assetfileid00001',
  repeat('E', 43),
  1
);

reset role;
set local role anon;

do $$
begin
  if public.resolve_vault_asset(
    '10000000-0000-4000-8000-000000000001',
    repeat('B', 43),
    'assetfileid00001'
  ) ->> 'storagePath' <> 'vault/10000000-0000-4000-8000-000000000001/assetfileid00001'
  then
    raise exception 'viewer could not resolve ready encrypted asset metadata';
  end if;
end;
$$;

reset role;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;

select public.revoke_vault_invitation(
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000011'
);

reset role;
set local role anon;

do $$
begin
  begin
    perform public.load_vault_snapshot(
      '10000000-0000-4000-8000-000000000001', repeat('A', 43)
    );
    raise exception 'new read succeeded after owner revoke';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'VAULT_CAPABILITY_REVOKED' then raise; end if;
  end;
end;
$$;

reset role;

insert into public.vaults (
  id, owner_id, state, protocol_version, active_room_id, snapshot_generation
) values (
  '10000000-0000-4000-8000-000000000021',
  '10000000-0000-4000-8000-000000000002',
  'active',
  1,
  'vaultdeleteroom1',
  0
);

insert into public.vault_invitations (
  id, vault_id, role, capability_hash, authorization_version,
  created_by, expires_at, revoked_at
) values (
  '10000000-0000-4000-8000-000000000022',
  '10000000-0000-4000-8000-000000000021',
  'editor',
  public.vault_capability_hash(
    '10000000-0000-4000-8000-000000000021', repeat('G', 43)
  ),
  1,
  '10000000-0000-4000-8000-000000000002',
  now() + interval '1 hour',
  null
);

select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;

do $$
declare
  v_deleted jsonb;
  v_repeated jsonb;
  v_delete_after timestamptz;
begin
  begin
    perform public.soft_delete_vault(
      '10000000-0000-4000-8000-000000000021'
    );
    raise exception 'active Vault was soft-deleted without revoke';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'VAULT_NOT_FOUND' then raise; end if;
  end;

  perform public.revoke_vault('10000000-0000-4000-8000-000000000021');
  v_deleted := public.soft_delete_vault(
    '10000000-0000-4000-8000-000000000021'
  );
  v_delete_after := (v_deleted ->> 'deleteAfter')::timestamptz;
  if v_deleted ->> 'reason' <> 'vault-deleted'
    or v_delete_after < now() + interval '6 days 23 hours 59 minutes'
    or v_delete_after > now() + interval '7 days 1 minute'
  then
    raise exception 'Vault soft-delete retention window is not 7 days';
  end if;

  v_repeated := public.soft_delete_vault(
    '10000000-0000-4000-8000-000000000021'
  );
  if (v_repeated ->> 'deleteAfter')::timestamptz <> v_delete_after then
    raise exception 'repeated soft-delete extended the retention window';
  end if;
end;
$$;

reset role;
set local role anon;

do $$
begin
  begin
    perform public.load_vault_snapshot(
      '10000000-0000-4000-8000-000000000021', repeat('G', 43)
    );
    raise exception 'deleted Vault capability unexpectedly loaded snapshot';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'VAULT_NOT_ACTIVE' then raise; end if;
  end;
end;
$$;

reset role;
rollback;

-- Real two-session CAS assertion (run manually in an isolated project):
-- 1. Load the fixture transaction without the final rollback in session A.
-- 2. BEGIN in sessions A/B and call cas_vault_snapshot with the same generation.
-- 3. Commit A; B must unblock with VAULT_SNAPSHOT_CONFLICT.
-- The single-session stale-writer assertion above is always automated; this
-- two-session gate verifies the row lock under actual concurrent transactions.
