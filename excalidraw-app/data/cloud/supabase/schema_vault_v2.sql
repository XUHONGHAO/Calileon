-- ============================================================================
-- P4c Vault v2 (CRDT) schema/RPC upgrade. ADR 0030 §3, W2 design §7.3.
-- ----------------------------------------------------------------------------
-- Install AFTER schema_vault.sql (and schema_vault_storage.sql). Idempotent.
-- Additive: no v1 table, function signature or return shape changes, so v1
-- Vaults, v1 clients and the v1 room server keep working unchanged.
--
--   D-1  vaults.protocol_version accepts 1 or 2; create_vault_v2 creates v2
--   D-2  get_vault_v2_contract() advertises v2 (the v1 contract is untouched)
--   D-3  assert_vault_envelope_v2 for v2 snapshot chunk envelopes (13 keys)
--   D-4  cas_vault_snapshot_v2: all chunks of one generation in ONE transaction
--   D-5  vault_snapshot_chunks (+ vault_snapshot_commits idempotency ledger)
--   D-6  load_vault_snapshot_v2 returns every chunk of the current generation
--   D-8  old generations are deleted by the CAS that supersedes them
--   S-2  resolve_vault_capability_v2 also returns the Vault's protocolVersion
--
-- v1 snapshot RPCs refuse v2 Vaults (no protocol mixing, W2 §1). D-7 (server
-- update log) is intentionally not implemented (W2 §10 item 1).
--
-- Secrets: same rules as schema_vault.sql; only ciphertext and capability
-- hashes are stored.
-- ============================================================================

-- D-1 ------------------------------------------------------------------------
alter table public.vaults drop constraint if exists vaults_protocol_v1_check;
alter table public.vaults drop constraint if exists vaults_protocol_check;
alter table public.vaults
  add constraint vaults_protocol_check check (protocol_version in (1, 2));

-- D-5 ------------------------------------------------------------------------
create table if not exists public.vault_snapshot_chunks (
  vault_id               uuid not null references public.vaults (id) on delete cascade,
  generation             bigint not null,
  chunk_index            smallint not null,
  chunk_count            smallint not null,
  encrypted_envelope     jsonb not null,
  ciphertext_bytes       bigint not null,
  created_at             timestamptz not null default now(),
  primary key (vault_id, generation, chunk_index),
  constraint vault_snapshot_chunks_generation_check check (generation >= 1),
  constraint vault_snapshot_chunks_index_check
    check (chunk_count between 1 and 64 and chunk_index >= 0 and chunk_index < chunk_count),
  constraint vault_snapshot_chunks_bytes_check
    check (ciphertext_bytes > 0 and ciphertext_bytes <= 2097152)
);

-- one row per committed generation; snapshot_id is the client idempotency key
create table if not exists public.vault_snapshot_commits (
  vault_id               uuid not null references public.vaults (id) on delete cascade,
  snapshot_id            uuid not null,
  generation             bigint not null,
  chunk_count            smallint not null,
  content_digest         text not null,
  created_at             timestamptz not null default now(),
  primary key (vault_id, snapshot_id),
  constraint vault_snapshot_commits_generation_unique unique (vault_id, generation),
  constraint vault_snapshot_commits_generation_check check (generation >= 1),
  constraint vault_snapshot_commits_chunks_check check (chunk_count between 1 and 64)
);

alter table public.vault_snapshot_chunks enable row level security;
alter table public.vault_snapshot_commits enable row level security;
revoke all on table public.vault_snapshot_chunks from anon, authenticated;
revoke all on table public.vault_snapshot_commits from anon, authenticated;

-- D-2 ------------------------------------------------------------------------
create or replace function public.get_vault_v2_contract()
returns jsonb
language sql
security definer
set search_path = pg_catalog, public
stable
as $$
  select jsonb_build_object(
    'protocolVersions', jsonb_build_array(1, 2),
    'schemaVersion', 2
  );
$$;

revoke all on function public.get_vault_v2_contract()
  from public, anon, authenticated, service_role;
grant execute on function public.get_vault_v2_contract() to service_role;

-- helpers ---------------------------------------------------------------------
create or replace function public.vault_protocol_of(p_vault_id uuid)
returns smallint
language sql
security definer
set search_path = pg_catalog, public
stable
as $$
  select protocol_version from public.vaults where id = p_vault_id;
$$;

revoke all on function public.vault_protocol_of(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.assert_vault_protocol(p_vault_id uuid, p_expected smallint)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_protocol smallint;
begin
  select protocol_version into v_protocol from public.vaults where id = p_vault_id;
  if v_protocol is null then
    raise exception using message = 'VAULT_NOT_FOUND', errcode = 'P0001';
  end if;
  if v_protocol <> p_expected then
    raise exception using message = 'VAULT_PROTOCOL_UNSUPPORTED', errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.assert_vault_protocol(uuid, smallint)
  from public, anon, authenticated, service_role;

-- D-3 ------------------------------------------------------------------------
-- v2 snapshot chunk envelope: exactly the 13 W2 §2 keys.
create or replace function public.assert_vault_envelope_v2(
  p_vault_id uuid,
  p_room_id text,
  p_generation bigint,
  p_chunk_index integer,
  p_chunk_count integer,
  p_envelope jsonb
)
returns void
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_keys text[];
begin
  if p_envelope is null or jsonb_typeof(p_envelope) <> 'object' then
    raise exception using message = 'VAULT_ENVELOPE_INVALID', errcode = 'P0001';
  end if;
  select array_agg(key order by key collate "C") into v_keys from jsonb_object_keys(p_envelope) as key;
  if v_keys is distinct from array[
    'chunkCount', 'chunkIndex', 'ciphertext', 'generation', 'iv', 'messageId',
    'messageType', 'protocolVersion', 'purpose', 'roomId', 'schemaVersion',
    'vaultId', 'version'
  ]::text[] then
    raise exception using message = 'VAULT_ENVELOPE_INVALID', errcode = 'P0001';
  end if;
  if jsonb_typeof(p_envelope -> 'version') <> 'number' or (p_envelope ->> 'version') <> '2'
    or jsonb_typeof(p_envelope -> 'protocolVersion') <> 'number' or (p_envelope ->> 'protocolVersion') <> '2'
    or jsonb_typeof(p_envelope -> 'schemaVersion') <> 'number' or (p_envelope ->> 'schemaVersion') <> '2'
  then
    raise exception using message = 'VAULT_PROTOCOL_UNSUPPORTED', errcode = 'P0001';
  end if;
  if (p_envelope ->> 'purpose') <> 'snapshot' or (p_envelope ->> 'messageType') <> 'snapshot.scene' then
    raise exception using message = 'VAULT_MESSAGE_TYPE_UNSUPPORTED', errcode = 'P0001';
  end if;
  if jsonb_typeof(p_envelope -> 'vaultId') <> 'string'
    or lower(p_envelope ->> 'vaultId') <> lower(p_vault_id::text)
    or jsonb_typeof(p_envelope -> 'roomId') <> 'string'
    or (p_envelope ->> 'roomId') <> p_room_id
    or jsonb_typeof(p_envelope -> 'messageId') <> 'string'
    or coalesce(p_envelope ->> 'messageId', '') !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    or jsonb_typeof(p_envelope -> 'generation') <> 'number'
    or (p_envelope ->> 'generation') <> p_generation::text
    or jsonb_typeof(p_envelope -> 'chunkIndex') <> 'number'
    or (p_envelope ->> 'chunkIndex') <> p_chunk_index::text
    or jsonb_typeof(p_envelope -> 'chunkCount') <> 'number'
    or (p_envelope ->> 'chunkCount') <> p_chunk_count::text
    or jsonb_typeof(p_envelope -> 'iv') <> 'string'
    or coalesce(p_envelope ->> 'iv', '') !~ '^[A-Za-z0-9_-]{16}$'
    or octet_length(public.vault_base64url_decode(p_envelope ->> 'iv')) <> 12
    or jsonb_typeof(p_envelope -> 'ciphertext') <> 'string'
    or coalesce(p_envelope ->> 'ciphertext', '') !~ '^[A-Za-z0-9_-]+$'
    or octet_length(public.vault_base64url_decode(p_envelope ->> 'ciphertext')) < 16
    or rtrim(translate(replace(replace(
      encode(public.vault_base64url_decode(p_envelope ->> 'ciphertext'), 'base64'),
      E'\n', ''
    ), E'\r', ''), '+/', '-_'), '=') <> (p_envelope ->> 'ciphertext')
  then
    raise exception using message = 'VAULT_ENVELOPE_INVALID', errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.assert_vault_envelope_v2(uuid, text, bigint, integer, integer, jsonb)
  from public, anon, authenticated, service_role;

-- D-1 create -----------------------------------------------------------------
create or replace function public.create_vault_v2(
  p_vault_id uuid,
  p_editor_capability_hash text,
  p_editor_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_owner uuid := auth.uid();
  v_invitation_id uuid;
begin
  if v_owner is null then
    raise exception using message = 'VAULT_CAPABILITY_FORBIDDEN', errcode = 'P0001';
  end if;
  if p_editor_capability_hash !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception using message = 'VAULT_CAPABILITY_INVALID', errcode = 'P0001';
  end if;
  if p_editor_expires_at is not null and p_editor_expires_at <= now() then
    raise exception using message = 'VAULT_CAPABILITY_EXPIRED', errcode = 'P0001';
  end if;

  insert into public.vaults (id, owner_id, state, protocol_version)
  values (p_vault_id, v_owner, 'creating', 2);

  insert into public.vault_invitations (
    vault_id, role, capability_hash, created_by, expires_at
  ) values (
    p_vault_id, 'editor', p_editor_capability_hash, v_owner, p_editor_expires_at
  ) returning id into v_invitation_id;

  return jsonb_build_object(
    'vaultId', p_vault_id,
    'state', 'creating',
    'invitationId', v_invitation_id,
    'snapshotGeneration', 0,
    'protocolVersion', 2
  );
exception
  when unique_violation then
    raise exception using message = 'VAULT_ALREADY_EXISTS', errcode = 'P0001';
end;
$$;

-- S-2 ------------------------------------------------------------------------
create or replace function public.resolve_vault_capability_v2(
  p_vault_id uuid,
  p_capability text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_resolution record;
begin
  select * into v_resolution
  from public.resolve_vault_capability_internal(p_vault_id, p_capability, null);
  return jsonb_build_object(
    'vaultId', p_vault_id,
    'invitationId', v_resolution.invitation_id,
    'role', v_resolution.role,
    'authorizationVersion', v_resolution.authorization_version,
    'activeRoomId', v_resolution.active_room_id,
    'snapshotGeneration', v_resolution.snapshot_generation,
    'expiresAt', v_resolution.expires_at,
    'protocolVersion', public.vault_protocol_of(p_vault_id)
  );
end;
$$;

-- D-6 ------------------------------------------------------------------------
create or replace function public.load_vault_snapshot_v2(
  p_vault_id uuid,
  p_capability text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_resolution record;
  v_commit public.vault_snapshot_commits;
begin
  select * into v_resolution
  from public.resolve_vault_capability_internal(p_vault_id, p_capability, null);
  perform public.assert_vault_protocol(p_vault_id, 2::smallint);
  select c.* into v_commit
  from public.vault_snapshot_commits c
  join public.vaults v on v.id = c.vault_id and v.snapshot_generation = c.generation
  where c.vault_id = p_vault_id;
  if v_commit.vault_id is null then
    return null;
  end if;
  return jsonb_build_object(
    'vaultId', p_vault_id,
    'generation', v_commit.generation,
    'snapshotId', v_commit.snapshot_id,
    'chunks', (
      select jsonb_agg(encrypted_envelope order by chunk_index)
      from public.vault_snapshot_chunks
      where vault_id = p_vault_id and generation = v_commit.generation
    ),
    'updatedAt', v_commit.created_at
  );
end;
$$;

-- D-4 + D-8 ------------------------------------------------------------------
-- All chunks of a generation are written in ONE transaction (N12: a partial
-- upload never becomes current). Same snapshot_id + same content → the
-- original confirmation; same snapshot_id + other content → conflict.
create or replace function public.cas_vault_snapshot_v2(
  p_vault_id uuid,
  p_capability text,
  p_expected_generation bigint,
  p_snapshot_id uuid,
  p_chunks jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_resolution record;
  v_vault public.vaults;
  v_invitation public.vault_invitations;
  v_previous public.vault_snapshot_commits;
  v_new_generation bigint := p_expected_generation + 1;
  v_count integer;
  v_index integer;
  v_chunk jsonb;
  v_bytes bigint;
  v_total bigint := 0;
  v_digest text;
begin
  -- same lock order as cas_vault_snapshot (aggregate root first)
  select * into v_vault from public.vaults where id = p_vault_id for update;
  select * into v_resolution
  from public.resolve_vault_capability_internal(p_vault_id, p_capability, 'editor');
  perform public.assert_vault_protocol(p_vault_id, 2::smallint);

  if v_vault.state <> 'active' or v_vault.revoked_at is not null or v_vault.deleted_at is not null then
    raise exception using message = 'VAULT_NOT_ACTIVE', errcode = 'P0001';
  end if;
  select * into v_invitation from public.vault_invitations
  where id = v_resolution.invitation_id and vault_id = p_vault_id
  for share;
  if v_invitation.id is null
    or v_invitation.authorization_version <> v_resolution.authorization_version
    or v_invitation.revoked_at is not null
  then
    raise exception using message = 'VAULT_CAPABILITY_REVOKED', errcode = 'P0001';
  end if;
  if v_invitation.expires_at is not null and v_invitation.expires_at <= now() then
    raise exception using message = 'VAULT_CAPABILITY_EXPIRED', errcode = 'P0001';
  end if;
  if v_invitation.role <> 'editor' then
    raise exception using message = 'VAULT_CAPABILITY_FORBIDDEN', errcode = 'P0001';
  end if;

  if p_snapshot_id is null or p_chunks is null or jsonb_typeof(p_chunks) <> 'array' then
    raise exception using message = 'VAULT_ENVELOPE_INVALID', errcode = 'P0001';
  end if;
  v_count := jsonb_array_length(p_chunks);
  if v_count < 1 or v_count > 64 then
    raise exception using message = 'VAULT_PAYLOAD_TOO_LARGE', errcode = 'P0001';
  end if;
  v_digest := encode(extensions.digest(convert_to(p_chunks::text, 'UTF8'), 'sha256'), 'hex');

  select * into v_previous from public.vault_snapshot_commits
  where vault_id = p_vault_id and snapshot_id = p_snapshot_id;
  if v_previous.vault_id is not null then
    if v_previous.content_digest <> v_digest then
      raise exception using message = 'VAULT_SNAPSHOT_CONFLICT', errcode = 'P0001';
    end if;
    return jsonb_build_object(
      'vaultId', p_vault_id,
      'snapshotId', p_snapshot_id,
      'generation', v_previous.generation,
      'updatedAt', v_previous.created_at
    );
  end if;

  if p_expected_generation < 0 or v_vault.snapshot_generation <> p_expected_generation then
    raise exception using message = 'VAULT_SNAPSHOT_CONFLICT', errcode = 'P0001';
  end if;

  for v_index in 0 .. v_count - 1 loop
    v_chunk := p_chunks -> v_index;
    perform public.assert_vault_envelope_v2(
      p_vault_id, v_vault.active_room_id, v_new_generation, v_index, v_count, v_chunk
    );
    v_bytes := octet_length(public.vault_base64url_decode(v_chunk ->> 'ciphertext'));
    if v_bytes > 2097152 then
      raise exception using message = 'VAULT_PAYLOAD_TOO_LARGE', errcode = 'P0001';
    end if;
    v_total := v_total + v_bytes;
    insert into public.vault_snapshot_chunks (
      vault_id, generation, chunk_index, chunk_count, encrypted_envelope, ciphertext_bytes
    ) values (
      p_vault_id, v_new_generation, v_index, v_count, v_chunk, v_bytes
    );
  end loop;
  if v_total > 52428800 then
    raise exception using message = 'VAULT_PAYLOAD_TOO_LARGE', errcode = 'P0001';
  end if;

  insert into public.vault_snapshot_commits (
    vault_id, snapshot_id, generation, chunk_count, content_digest
  ) values (
    p_vault_id, p_snapshot_id, v_new_generation, v_count, v_digest
  );
  update public.vaults set snapshot_generation = v_new_generation where id = p_vault_id;

  -- D-8: a v2 snapshot is the full CRDT state, older generations are redundant
  delete from public.vault_snapshot_chunks
  where vault_id = p_vault_id and generation < v_new_generation;
  -- keep the idempotency ledger bounded (newest 50 commits)
  delete from public.vault_snapshot_commits
  where vault_id = p_vault_id and generation <= v_new_generation - 50;

  return jsonb_build_object(
    'vaultId', p_vault_id,
    'snapshotId', p_snapshot_id,
    'generation', v_new_generation,
    'updatedAt', now()
  );
end;
$$;

-- v1 snapshot RPCs refuse v2 Vaults (W2 §1: no protocol mixing) ---------------
create or replace function public.vault_snapshots_v1_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if public.vault_protocol_of(new.vault_id) <> 1 then
    raise exception using message = 'VAULT_PROTOCOL_UNSUPPORTED', errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.vault_snapshots_v1_guard()
  from public, anon, authenticated, service_role;

drop trigger if exists vault_snapshots_v1_guard on public.vault_snapshots;
create trigger vault_snapshots_v1_guard
  before insert or update on public.vault_snapshots
  for each row execute function public.vault_snapshots_v1_guard();

-- grants ---------------------------------------------------------------------
revoke all on function public.create_vault_v2(uuid, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.resolve_vault_capability_v2(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.load_vault_snapshot_v2(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.cas_vault_snapshot_v2(uuid, text, bigint, uuid, jsonb) from public, anon, authenticated, service_role;

grant execute on function public.create_vault_v2(uuid, text, timestamptz) to authenticated;
grant execute on function public.resolve_vault_capability_v2(uuid, text) to anon, authenticated, service_role;
grant execute on function public.load_vault_snapshot_v2(uuid, text) to anon, authenticated;
grant execute on function public.cas_vault_snapshot_v2(uuid, text, bigint, uuid, jsonb) to anon, authenticated;
