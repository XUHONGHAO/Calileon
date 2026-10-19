-- P4c Vault v2 schema/security smoke. Run after schema_vault_v2.sql in an
-- isolated Supabase project (schema-smoke.sh). The fixture block always rolls
-- back. Covers D-1…D-6/D-8 and the v1/v2 no-mixing rule (N13), viewer CAS
-- (N15) and atomic multi-chunk commit (N12).

do $$
declare
  v_missing text[];
begin
  select array_agg(required.signature) into v_missing
  from (values
    ('get_vault_v2_contract()'),
    ('create_vault_v2(uuid,text,timestamp with time zone)'),
    ('resolve_vault_capability_v2(uuid,text)'),
    ('load_vault_snapshot_v2(uuid,text)'),
    ('cas_vault_snapshot_v2(uuid,text,bigint,uuid,jsonb)'),
    ('assert_vault_envelope_v2(uuid,text,bigint,integer,integer,jsonb)')
  ) as required(signature)
  where to_regprocedure('public.' || required.signature) is null;
  if v_missing is not null then
    raise exception 'missing Vault v2 functions: %', v_missing;
  end if;
  if to_regclass('public.vault_snapshot_chunks') is null
    or to_regclass('public.vault_snapshot_commits') is null
  then
    raise exception 'missing Vault v2 tables';
  end if;
  if has_function_privilege('anon', 'public.assert_vault_envelope_v2(uuid,text,bigint,integer,integer,jsonb)', 'execute')
    or has_function_privilege('anon', 'public.vault_protocol_of(uuid)', 'execute')
    or has_table_privilege('anon', 'public.vault_snapshot_chunks', 'select')
  then
    raise exception 'internal Vault v2 helper or table is externally accessible';
  end if;
end;
$$;

begin;

insert into auth.users (id, aud, role, email, encrypted_password, created_at, updated_at)
values ('20000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
        'vault-v2-smoke@example.invalid', '', now(), now())
on conflict (id) do nothing;

insert into public.vaults (id, owner_id, state, protocol_version, active_room_id, snapshot_generation)
values
  ('20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', 'active', 2, 'vaultv2smokeroom1', 0),
  ('20000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000002', 'active', 1, 'vaultv1smokeroom1', 0);

insert into public.vault_invitations (id, vault_id, role, capability_hash, authorization_version, created_by)
values
  ('20000000-0000-4000-8000-000000000011', '20000000-0000-4000-8000-000000000001', 'editor',
   public.vault_capability_hash('20000000-0000-4000-8000-000000000001', repeat('E', 43)), 1,
   '20000000-0000-4000-8000-000000000002'),
  ('20000000-0000-4000-8000-000000000012', '20000000-0000-4000-8000-000000000001', 'viewer',
   public.vault_capability_hash('20000000-0000-4000-8000-000000000001', repeat('F', 43)), 1,
   '20000000-0000-4000-8000-000000000002'),
  ('20000000-0000-4000-8000-000000000013', '20000000-0000-4000-8000-000000000003', 'editor',
   public.vault_capability_hash('20000000-0000-4000-8000-000000000003', repeat('E', 43)), 1,
   '20000000-0000-4000-8000-000000000002');

set local role anon;

do $$
declare
  v_vault constant uuid := '20000000-0000-4000-8000-000000000001';
  v_v1_vault constant uuid := '20000000-0000-4000-8000-000000000003';
  v_editor constant text := repeat('E', 43);
  v_viewer constant text := repeat('F', 43);
  v_result jsonb;
  v_chunk jsonb;
  v_chunks jsonb;
  v_failed boolean;
  v_snapshot constant uuid := '20000000-0000-4000-8000-000000000201';
begin
  -- one well-formed chunk envelope (ciphertext is opaque bytes here)
  v_chunk := jsonb_build_object(
    'version', 2, 'schemaVersion', 2, 'protocolVersion', 2,
    'vaultId', v_vault::text, 'roomId', 'vaultv2smokeroom1',
    'purpose', 'snapshot', 'messageType', 'snapshot.scene',
    'messageId', '20000000-0000-4000-8000-000000000101',
    'generation', 1, 'chunkIndex', 0, 'chunkCount', 2,
    'iv', 'AAAAAAAAAAAAAAAA', 'ciphertext', repeat('A', 24)
  );
  v_chunks := jsonb_build_array(
    v_chunk,
    v_chunk || jsonb_build_object('chunkIndex', 1, 'messageId', '20000000-0000-4000-8000-000000000102')
  );

  -- S-2: resolver returns the protocol version
  v_result := public.resolve_vault_capability_v2(v_vault, v_editor);
  if (v_result ->> 'protocolVersion') <> '2' then
    raise exception 'v2 resolver did not return protocolVersion 2';
  end if;
  if (public.resolve_vault_capability_v2(v_v1_vault, v_editor) ->> 'protocolVersion') <> '1' then
    raise exception 'v2 resolver did not return protocolVersion 1 for a v1 Vault';
  end if;

  -- N15: viewer cannot write
  v_failed := false;
  begin
    perform public.cas_vault_snapshot_v2(v_vault, v_viewer, 0, v_snapshot, v_chunks);
  exception when others then
    v_failed := sqlerrm = 'VAULT_CAPABILITY_FORBIDDEN';
  end;
  if not v_failed then
    raise exception 'viewer unexpectedly wrote v2 snapshot';
  end if;

  -- N12: a broken chunk aborts the whole commit (nothing becomes current)
  v_failed := false;
  begin
    perform public.cas_vault_snapshot_v2(
      v_vault, v_editor, 0, v_snapshot,
      jsonb_build_array(v_chunk, v_chunk || jsonb_build_object('chunkIndex', 1, 'senderSessionId', 'x'))
    );
  exception when others then
    v_failed := sqlerrm = 'VAULT_ENVELOPE_INVALID';
  end;
  if not v_failed or public.load_vault_snapshot_v2(v_vault, v_editor) is not null then
    raise exception 'partial v2 snapshot became visible';
  end if;

  -- D-4: atomic commit of 2 chunks
  v_result := public.cas_vault_snapshot_v2(v_vault, v_editor, 0, v_snapshot, v_chunks);
  if (v_result ->> 'generation') <> '1' then
    raise exception 'v2 CAS did not commit generation 1';
  end if;
  -- idempotent retry
  if (public.cas_vault_snapshot_v2(v_vault, v_editor, 0, v_snapshot, v_chunks) ->> 'generation') <> '1' then
    raise exception 'duplicate v2 CAS did not return the original confirmation';
  end if;
  -- same snapshot id, other content
  v_failed := false;
  begin
    perform public.cas_vault_snapshot_v2(v_vault, v_editor, 0, v_snapshot, jsonb_build_array(v_chunk || jsonb_build_object('chunkCount', 1)));
  exception when others then
    v_failed := sqlerrm = 'VAULT_SNAPSHOT_CONFLICT';
  end;
  if not v_failed then
    raise exception 'same snapshot ID with different ciphertext unexpectedly succeeded';
  end if;
  -- stale generation
  v_failed := false;
  begin
    perform public.cas_vault_snapshot_v2(v_vault, v_editor, 0, '20000000-0000-4000-8000-000000000202', v_chunks);
  exception when others then
    v_failed := sqlerrm = 'VAULT_SNAPSHOT_CONFLICT';
  end;
  if not v_failed then
    raise exception 'stale v2 CAS unexpectedly succeeded';
  end if;

  -- D-6: viewer can read all chunks in order
  v_result := public.load_vault_snapshot_v2(v_vault, v_viewer);
  if (v_result ->> 'generation') <> '1' or jsonb_array_length(v_result -> 'chunks') <> 2
    or ((v_result -> 'chunks' -> 1) ->> 'chunkIndex') <> '1'
  then
    raise exception 'v2 snapshot load returned wrong chunks';
  end if;

  -- D-8: generation 2 replaces generation 1's chunks
  perform public.cas_vault_snapshot_v2(
    v_vault, v_editor, 1, '20000000-0000-4000-8000-000000000203',
    jsonb_build_array(v_chunk || jsonb_build_object('generation', 2, 'chunkCount', 1))
  );
  if jsonb_array_length(public.load_vault_snapshot_v2(v_vault, v_editor) -> 'chunks') <> 1 then
    raise exception 'v2 generation 2 load returned wrong chunks';
  end if;

  -- N13: no protocol mixing
  v_failed := false;
  begin
    perform public.load_vault_snapshot_v2(v_v1_vault, v_editor);
  exception when others then
    v_failed := sqlerrm = 'VAULT_PROTOCOL_UNSUPPORTED';
  end;
  if not v_failed then
    raise exception 'v2 load unexpectedly read a v1 Vault';
  end if;
  v_failed := false;
  begin
    perform public.cas_vault_snapshot(
      v_vault, v_editor, 2,
      jsonb_build_object(
        'version', 1, 'vaultId', v_vault::text, 'purpose', 'snapshot',
        'messageType', 'snapshot.scene', 'messageId', '20000000-0000-4000-8000-000000000301',
        'generation', 3, 'iv', 'AAAAAAAAAAAAAAAA', 'ciphertext', repeat('A', 24)
      ),
      18,
      '20000000-0000-4000-8000-000000000301'
    );
  exception when others then
    v_failed := sqlerrm = 'VAULT_PROTOCOL_UNSUPPORTED';
  end;
  if not v_failed then
    raise exception 'v1 CAS unexpectedly wrote a v2 Vault';
  end if;
end;
$$;

rollback;
