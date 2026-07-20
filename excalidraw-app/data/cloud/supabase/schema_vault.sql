-- ============================================================================
-- Excalidraw P4a Vault Online - F0 schema/RPC contract
-- ----------------------------------------------------------------------------
-- Install after schema_vault_prerequisites.sql. This schema is intentionally
-- independent from schema.sql and
-- collab_room_snapshots/collab_room_assets and all plain scene persistence.
-- Vault callers MUST NOT fall back to those legacy paths.
--
-- Secrets:
-- - Vault root/content keys never enter this schema or any RPC.
-- - Full invitation capabilities are accepted only by resolve/read/write RPCs
--   over HTTPS and MUST be excluded from proxy/PostgREST logs.
-- - Only domain-separated SHA-256 capability hashes are stored.
-- ============================================================================

create table if not exists public.vault_deployment_metadata (
  singleton                boolean primary key default true,
  deployment_version       text not null,
  schema_version           smallint not null,
  protocol_version         smallint not null,
  updated_at               timestamptz not null default now(),
  constraint vault_deployment_metadata_singleton_check check (singleton),
  constraint vault_deployment_metadata_version_check
    check (
      deployment_version = 'p4a-f4-v1'
      and schema_version = 1
      and protocol_version = 1
    )
);

insert into public.vault_deployment_metadata (
  singleton,
  deployment_version,
  schema_version,
  protocol_version,
  updated_at
)
values (true, 'p4a-f4-v1', 1, 1, now())
on conflict (singleton) do update
set deployment_version = excluded.deployment_version,
    schema_version = excluded.schema_version,
    protocol_version = excluded.protocol_version,
    updated_at = now();

alter table public.vault_deployment_metadata enable row level security;
revoke all on table public.vault_deployment_metadata from anon, authenticated;

create or replace function public.get_vault_deployment_contract()
returns jsonb
language sql
security definer
set search_path = pg_catalog, public
stable
as $$
  select jsonb_build_object(
    'deploymentVersion', deployment_version,
    'schemaVersion', schema_version,
    'protocolVersion', protocol_version
  )
  from public.vault_deployment_metadata
  where singleton = true;
$$;

revoke all on function public.get_vault_deployment_contract()
  from public, anon, authenticated, service_role;
grant execute on function public.get_vault_deployment_contract() to service_role;

create table if not exists public.vaults (
  id                     uuid primary key,
  owner_id               uuid not null references auth.users (id) on delete cascade,
  state                  text not null default 'creating',
  protocol_version       smallint not null default 1,
  active_room_id         text,
  snapshot_generation    bigint not null default 0,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  revoked_at             timestamptz,
  deleted_at             timestamptz,
  delete_after           timestamptz,
  constraint vaults_state_check
    check (state in ('creating', 'active', 'revoked', 'failed', 'deleted')),
  constraint vaults_protocol_v1_check check (protocol_version = 1),
  constraint vaults_generation_nonnegative_check check (snapshot_generation >= 0),
  constraint vaults_active_room_required_check
    check (state not in ('active', 'revoked') or active_room_id is not null),
  constraint vaults_active_room_unique unique (active_room_id)
);

create table if not exists public.vault_invitations (
  id                     uuid primary key default gen_random_uuid(),
  vault_id               uuid not null references public.vaults (id) on delete cascade,
  role                   text not null,
  capability_hash        text not null,
  authorization_version  bigint not null default 1,
  created_by             uuid not null references auth.users (id) on delete cascade,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  expires_at             timestamptz,
  revoked_at             timestamptz,
  constraint vault_invitations_role_check check (role in ('viewer', 'editor')),
  constraint vault_invitations_hash_check
    check (capability_hash ~ '^[A-Za-z0-9_-]{43}$'),
  constraint vault_invitations_auth_version_check check (authorization_version >= 1),
  constraint vault_invitations_hash_unique unique (vault_id, capability_hash)
);

create table if not exists public.vault_snapshots (
  vault_id               uuid primary key references public.vaults (id) on delete cascade,
  generation             bigint not null,
  encrypted_envelope     jsonb not null,
  ciphertext_bytes       bigint not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint vault_snapshots_generation_positive_check check (generation >= 1),
  constraint vault_snapshots_bytes_check
    check (ciphertext_bytes > 0 and ciphertext_bytes <= 52428800)
);

create table if not exists public.vault_assets (
  id                     uuid primary key default gen_random_uuid(),
  vault_id               uuid not null references public.vaults (id) on delete cascade,
  file_id                text not null,
  storage_path           text not null,
  encrypted_digest       text not null,
  ciphertext_bytes       bigint not null,
  state                  text not null default 'pending',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz,
  constraint vault_assets_file_id_check check (file_id ~ '^[A-Za-z0-9_-]{16,128}$'),
  constraint vault_assets_digest_check check (encrypted_digest ~ '^[A-Za-z0-9_-]{43}$'),
  constraint vault_assets_bytes_check
    check (ciphertext_bytes > 0 and ciphertext_bytes <= 104857600),
  constraint vault_assets_state_check check (state in ('pending', 'ready', 'deleted')),
  constraint vault_assets_file_unique unique (vault_id, file_id),
  constraint vault_assets_path_unique unique (storage_path)
);

create index if not exists vault_invitations_vault_active_idx
  on public.vault_invitations (vault_id, role, expires_at)
  where revoked_at is null;

create index if not exists vault_assets_vault_active_idx
  on public.vault_assets (vault_id, created_at)
  where deleted_at is null;

alter table public.vaults enable row level security;
alter table public.vault_invitations enable row level security;
alter table public.vault_snapshots enable row level security;
alter table public.vault_assets enable row level security;

-- No direct table policies are created. Owner and invitation access is only
-- through the SECURITY DEFINER RPC allowlist below, so invitation hashes cannot
-- be enumerated through ordinary authenticated/anon selects.
revoke all on table public.vaults from anon, authenticated;
revoke all on table public.vault_invitations from anon, authenticated;
revoke all on table public.vault_snapshots from anon, authenticated;
revoke all on table public.vault_assets from anon, authenticated;

drop trigger if exists vaults_touch_updated_at on public.vaults;
drop trigger if exists vault_invitations_touch_updated_at on public.vault_invitations;
drop trigger if exists vault_snapshots_touch_updated_at on public.vault_snapshots;
drop trigger if exists vault_assets_touch_updated_at on public.vault_assets;

create trigger vaults_touch_updated_at
  before update on public.vaults
  for each row execute function public.vault_touch_updated_at();
create trigger vault_invitations_touch_updated_at
  before update on public.vault_invitations
  for each row execute function public.vault_touch_updated_at();
create trigger vault_snapshots_touch_updated_at
  before update on public.vault_snapshots
  for each row execute function public.vault_touch_updated_at();
create trigger vault_assets_touch_updated_at
  before update on public.vault_assets
  for each row execute function public.vault_touch_updated_at();

create or replace function public.vault_capability_hash(
  p_vault_id uuid,
  p_capability text
)
returns text
language plpgsql
immutable
set search_path = pg_catalog, public, extensions
as $$
declare
  v_digest text;
begin
  if p_capability is null or p_capability !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception using message = 'VAULT_CAPABILITY_INVALID', errcode = 'P0001';
  end if;

  v_digest := encode(
    extensions.digest(
      convert_to('excalidraw-vault-capability', 'UTF8') || decode('00', 'hex') ||
      convert_to('1', 'UTF8') || decode('00', 'hex') ||
      convert_to(lower(p_vault_id::text), 'UTF8') || decode('00', 'hex') ||
      convert_to(p_capability, 'UTF8'),
      'sha256'
    ),
    'base64'
  );

  return rtrim(translate(v_digest, '+/', '-_'), '=');
end;
$$;

revoke all on function public.vault_capability_hash(uuid, text)
  from public, anon, authenticated, service_role;

create or replace function public.vault_base64url_decode(p_value text)
returns bytea
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_normalized text;
begin
  if p_value is null or p_value !~ '^[A-Za-z0-9_-]+$' then
    raise exception using message = 'VAULT_ENVELOPE_INVALID', errcode = 'P0001';
  end if;
  v_normalized := translate(p_value, '-_', '+/');
  v_normalized := v_normalized || repeat('=', (4 - length(v_normalized) % 4) % 4);
  return decode(v_normalized, 'base64');
exception
  when others then
    raise exception using message = 'VAULT_ENVELOPE_INVALID', errcode = 'P0001';
end;
$$;

revoke all on function public.vault_base64url_decode(text)
  from public, anon, authenticated, service_role;

create or replace function public.assert_vault_envelope_v1(
  p_vault_id uuid,
  p_purpose text,
  p_message_type text,
  p_generation bigint,
  p_envelope jsonb
)
returns void
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_expected_keys integer;
  v_actual_keys integer;
begin
  if p_envelope is null or jsonb_typeof(p_envelope) <> 'object' then
    raise exception using message = 'VAULT_ENVELOPE_INVALID', errcode = 'P0001';
  end if;
  if jsonb_typeof(p_envelope -> 'version') <> 'number'
    or (p_envelope ->> 'version') <> '1'
  then
    raise exception using message = 'VAULT_PROTOCOL_UNSUPPORTED', errcode = 'P0001';
  end if;
  if jsonb_typeof(p_envelope -> 'messageType') <> 'string'
    or (p_envelope ->> 'messageType') not in (
      'realtime.content', 'realtime.presence', 'snapshot.scene', 'asset.content'
    )
  then
    raise exception using message = 'VAULT_MESSAGE_TYPE_UNSUPPORTED', errcode = 'P0001';
  end if;

  v_expected_keys := case p_purpose when 'snapshot' then 8 when 'asset' then 7 else 0 end;
  select count(*) into v_actual_keys from jsonb_object_keys(p_envelope);

  if v_expected_keys = 0
    or v_actual_keys <> v_expected_keys
    or jsonb_typeof(p_envelope -> 'version') <> 'number'
    or (p_envelope ->> 'version') <> '1'
    or jsonb_typeof(p_envelope -> 'vaultId') <> 'string'
    or (p_envelope ->> 'vaultId') <> lower(p_vault_id::text)
    or jsonb_typeof(p_envelope -> 'purpose') <> 'string'
    or (p_envelope ->> 'purpose') <> p_purpose
    or jsonb_typeof(p_envelope -> 'messageType') <> 'string'
    or (p_envelope ->> 'messageType') <> p_message_type
    or jsonb_typeof(p_envelope -> 'messageId') <> 'string'
    or coalesce(p_envelope ->> 'messageId', '') !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    or jsonb_typeof(p_envelope -> 'iv') <> 'string'
    or coalesce(p_envelope ->> 'iv', '') !~ '^[A-Za-z0-9_-]{16}$'
    or octet_length(public.vault_base64url_decode(p_envelope ->> 'iv')) <> 12
    or rtrim(translate(replace(replace(
      encode(public.vault_base64url_decode(p_envelope ->> 'iv'), 'base64'),
      E'\n', ''
    ), E'\r', ''), '+/', '-_'), '=')
      <> (p_envelope ->> 'iv')
    or jsonb_typeof(p_envelope -> 'ciphertext') <> 'string'
    or coalesce(p_envelope ->> 'ciphertext', '') !~ '^[A-Za-z0-9_-]+$'
    or rtrim(translate(replace(replace(
      encode(public.vault_base64url_decode(p_envelope ->> 'ciphertext'), 'base64'),
      E'\n', ''
    ), E'\r', ''), '+/', '-_'), '=')
      <> (p_envelope ->> 'ciphertext')
    or (p_purpose = 'snapshot' and (
      not (p_envelope ? 'generation')
      or jsonb_typeof(p_envelope -> 'generation') <> 'number'
      or (p_envelope ->> 'generation') <> p_generation::text
    ))
    or (p_purpose = 'asset' and (p_envelope ? 'generation'))
  then
    raise exception using message = 'VAULT_ENVELOPE_INVALID', errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.assert_vault_envelope_v1(uuid, text, text, bigint, jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.resolve_vault_capability_internal(
  p_vault_id uuid,
  p_capability text,
  p_required_role text default null
)
returns table(
  invitation_id uuid,
  role text,
  authorization_version bigint,
  active_room_id text,
  snapshot_generation bigint,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_hash text;
  v_vault public.vaults;
  v_invitation public.vault_invitations;
begin
  select * into v_vault
  from public.vaults
  where id = p_vault_id
  for share;
  if v_vault.id is null then
    raise exception using message = 'VAULT_NOT_FOUND', errcode = 'P0001';
  end if;
  if v_vault.state <> 'active' or v_vault.revoked_at is not null or v_vault.deleted_at is not null then
    raise exception using message = 'VAULT_NOT_ACTIVE', errcode = 'P0001';
  end if;

  v_hash := public.vault_capability_hash(p_vault_id, p_capability);
  select * into v_invitation
  from public.vault_invitations vi
  where vi.vault_id = p_vault_id and vi.capability_hash = v_hash
  for share;

  if v_invitation.id is null then
    raise exception using message = 'VAULT_CAPABILITY_INVALID', errcode = 'P0001';
  end if;
  if v_invitation.revoked_at is not null then
    raise exception using message = 'VAULT_CAPABILITY_REVOKED', errcode = 'P0001';
  end if;
  if v_invitation.expires_at is not null and v_invitation.expires_at <= now() then
    raise exception using message = 'VAULT_CAPABILITY_EXPIRED', errcode = 'P0001';
  end if;
  if p_required_role = 'editor' and v_invitation.role <> 'editor' then
    raise exception using message = 'VAULT_CAPABILITY_FORBIDDEN', errcode = 'P0001';
  end if;

  invitation_id := v_invitation.id;
  role := v_invitation.role;
  authorization_version := v_invitation.authorization_version;
  active_room_id := v_vault.active_room_id;
  snapshot_generation := v_vault.snapshot_generation;
  expires_at := v_invitation.expires_at;
  return next;
end;
$$;

revoke all on function public.resolve_vault_capability_internal(uuid, text, text)
  from public, anon, authenticated, service_role;

create or replace function public.create_vault(
  p_vault_id uuid,
  p_protocol_version smallint,
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
  if p_protocol_version <> 1 then
    raise exception using message = 'VAULT_PROTOCOL_UNSUPPORTED', errcode = 'P0001';
  end if;
  if p_editor_capability_hash !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception using message = 'VAULT_CAPABILITY_INVALID', errcode = 'P0001';
  end if;
  if p_editor_expires_at is not null and p_editor_expires_at <= now() then
    raise exception using message = 'VAULT_CAPABILITY_EXPIRED', errcode = 'P0001';
  end if;

  insert into public.vaults (id, owner_id, state, protocol_version)
  values (p_vault_id, v_owner, 'creating', 1);

  insert into public.vault_invitations (
    vault_id, role, capability_hash, created_by, expires_at
  ) values (
    p_vault_id, 'editor', p_editor_capability_hash, v_owner, p_editor_expires_at
  ) returning id into v_invitation_id;

  return jsonb_build_object(
    'vaultId', p_vault_id,
    'state', 'creating',
    'invitationId', v_invitation_id,
    'snapshotGeneration', 0
  );
exception
  when unique_violation then
    raise exception using message = 'VAULT_ALREADY_EXISTS', errcode = 'P0001';
end;
$$;

create or replace function public.activate_vault(p_vault_id uuid, p_active_room_id text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_vault public.vaults;
begin
  if p_active_room_id is null or p_active_room_id !~ '^[A-Za-z0-9_-]{16,128}$' then
    raise exception using message = 'VAULT_ROOM_PROTOCOL_UNSUPPORTED', errcode = 'P0001';
  end if;
  update public.vaults
  set state = 'active', active_room_id = p_active_room_id
  where id = p_vault_id and owner_id = auth.uid() and state = 'creating'
  returning * into v_vault;
  if v_vault.id is null then
    raise exception using message = 'VAULT_NOT_ACTIVE', errcode = 'P0001';
  end if;
  return jsonb_build_object(
    'vaultId', v_vault.id,
    'state', v_vault.state,
    'activeRoomId', v_vault.active_room_id
  );
end;
$$;

create or replace function public.fail_vault_creation(p_vault_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.vaults set state = 'failed'
  where id = p_vault_id and owner_id = auth.uid() and state = 'creating';
  if not found then
    raise exception using message = 'VAULT_NOT_FOUND', errcode = 'P0001';
  end if;
  update public.vault_invitations
  set revoked_at = coalesce(revoked_at, now()),
      authorization_version = authorization_version + case when revoked_at is null then 1 else 0 end
  where vault_id = p_vault_id;
end;
$$;

create or replace function public.create_vault_invitation(
  p_vault_id uuid,
  p_role text,
  p_capability_hash text,
  p_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_vault public.vaults;
  v_invitation public.vault_invitations;
begin
  if p_role not in ('viewer', 'editor')
    or p_capability_hash !~ '^[A-Za-z0-9_-]{43}$'
    or (p_expires_at is not null and p_expires_at <= now())
  then
    raise exception using message = 'VAULT_CAPABILITY_INVALID', errcode = 'P0001';
  end if;
  select * into v_vault from public.vaults
  where id = p_vault_id and owner_id = auth.uid()
  for share;
  if v_vault.id is null or v_vault.state <> 'active' or v_vault.revoked_at is not null then
    raise exception using message = 'VAULT_CAPABILITY_FORBIDDEN', errcode = 'P0001';
  end if;

  insert into public.vault_invitations (
    vault_id, role, capability_hash, created_by, expires_at
  ) values (
    p_vault_id, p_role, p_capability_hash, auth.uid(), p_expires_at
  ) returning * into v_invitation;

  return jsonb_build_object(
    'invitationId', v_invitation.id,
    'vaultId', v_invitation.vault_id,
    'role', v_invitation.role,
    'authorizationVersion', v_invitation.authorization_version,
    'expiresAt', v_invitation.expires_at
  );
exception
  when unique_violation then
    raise exception using message = 'VAULT_ALREADY_EXISTS', errcode = 'P0001';
end;
$$;

create or replace function public.resolve_vault_capability(
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
    'expiresAt', v_resolution.expires_at
  );
end;
$$;

create or replace function public.load_vault_snapshot(
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
  v_snapshot public.vault_snapshots;
begin
  select * into v_resolution
  from public.resolve_vault_capability_internal(p_vault_id, p_capability, null);
  select * into v_snapshot from public.vault_snapshots where vault_id = p_vault_id;
  if v_snapshot.vault_id is null then
    return null;
  end if;
  return jsonb_build_object(
    'vaultId', v_snapshot.vault_id,
    'generation', v_snapshot.generation,
    'encryptedEnvelope', v_snapshot.encrypted_envelope,
    'ciphertextBytes', v_snapshot.ciphertext_bytes,
    'updatedAt', v_snapshot.updated_at
  );
end;
$$;

create or replace function public.cas_vault_snapshot(
  p_vault_id uuid,
  p_capability text,
  p_expected_generation bigint,
  p_encrypted_envelope jsonb,
  p_ciphertext_bytes bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_resolution record;
  v_vault public.vaults;
  v_invitation public.vault_invitations;
  v_new_generation bigint := p_expected_generation + 1;
begin
  -- Lock in aggregate-root order before capability resolution. The internal
  -- resolver takes compatible SHARE locks, so two CAS writers cannot both take
  -- SHARE and then deadlock while upgrading to UPDATE.
  select * into v_vault from public.vaults where id = p_vault_id for update;
  select * into v_resolution
  from public.resolve_vault_capability_internal(p_vault_id, p_capability, 'editor');

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
  if p_expected_generation < 0 or v_vault.snapshot_generation <> p_expected_generation then
    raise exception using message = 'VAULT_SNAPSHOT_CONFLICT', errcode = 'P0001';
  end if;
  perform public.assert_vault_envelope_v1(
    p_vault_id, 'snapshot', 'snapshot.scene', v_new_generation, p_encrypted_envelope
  );
  if p_ciphertext_bytes <= 0 or p_ciphertext_bytes > 52428800 then
    raise exception using message = 'VAULT_PAYLOAD_TOO_LARGE', errcode = 'P0001';
  end if;
  if octet_length(public.vault_base64url_decode(p_encrypted_envelope ->> 'ciphertext'))
    <> p_ciphertext_bytes
  then
    raise exception using message = 'VAULT_ENVELOPE_INVALID', errcode = 'P0001';
  end if;

  insert into public.vault_snapshots (
    vault_id, generation, encrypted_envelope, ciphertext_bytes
  ) values (
    p_vault_id, v_new_generation, p_encrypted_envelope, p_ciphertext_bytes
  )
  on conflict (vault_id) do update set
    generation = excluded.generation,
    encrypted_envelope = excluded.encrypted_envelope,
    ciphertext_bytes = excluded.ciphertext_bytes;

  update public.vaults set snapshot_generation = v_new_generation where id = p_vault_id;
  return jsonb_build_object(
    'vaultId', p_vault_id,
    'generation', v_new_generation,
    'updatedAt', now()
  );
end;
$$;

create or replace function public.register_vault_asset(
  p_vault_id uuid,
  p_capability text,
  p_file_id text,
  p_encrypted_digest text,
  p_ciphertext_bytes bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_resolution record;
  v_vault public.vaults;
  v_invitation public.vault_invitations;
  v_asset public.vault_assets;
  v_path text := 'vault/' || lower(p_vault_id::text) || '/' || p_file_id;
begin
  select * into v_vault from public.vaults where id = p_vault_id for share;
  select * into v_resolution
  from public.resolve_vault_capability_internal(p_vault_id, p_capability, 'editor');
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
  if p_file_id !~ '^[A-Za-z0-9_-]{16,128}$'
    or p_encrypted_digest !~ '^[A-Za-z0-9_-]{43}$'
    or p_ciphertext_bytes <= 0
    or p_ciphertext_bytes > 104857600
  then
    raise exception using message = 'VAULT_ENVELOPE_INVALID', errcode = 'P0001';
  end if;
  select * into v_asset from public.vault_assets
  where vault_id = p_vault_id and file_id = p_file_id for update;
  if v_asset.id is not null then
    if v_asset.encrypted_digest <> p_encrypted_digest
      or v_asset.ciphertext_bytes <> p_ciphertext_bytes
    then
      raise exception using message = 'VAULT_ASSET_CONFLICT', errcode = 'P0001';
    end if;
  else
    insert into public.vault_assets (
      vault_id, file_id, storage_path, encrypted_digest,
      ciphertext_bytes
    ) values (
      p_vault_id, p_file_id, v_path, p_encrypted_digest,
      p_ciphertext_bytes
    )
    on conflict (vault_id, file_id) do nothing
    returning * into v_asset;

    -- A concurrent first registration may have won the unique key while this
    -- transaction was waiting. Re-read the winner and apply the same exact
    -- digest/size idempotency contract instead of leaking SQLSTATE 23505.
    if v_asset.id is null then
      select * into v_asset from public.vault_assets
      where vault_id = p_vault_id and file_id = p_file_id for update;
      if v_asset.id is null
        or v_asset.encrypted_digest <> p_encrypted_digest
        or v_asset.ciphertext_bytes <> p_ciphertext_bytes
      then
        raise exception using message = 'VAULT_ASSET_CONFLICT', errcode = 'P0001';
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'vaultId', v_asset.vault_id,
    'fileId', v_asset.file_id,
    'storagePath', v_asset.storage_path,
    'state', v_asset.state
  );
end;
$$;

create or replace function public.complete_vault_asset(
  p_vault_id uuid,
  p_capability text,
  p_file_id text,
  p_observed_encrypted_digest text,
  p_observed_ciphertext_bytes bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_resolution record;
  v_vault public.vaults;
  v_invitation public.vault_invitations;
  v_asset public.vault_assets;
begin
  select * into v_vault from public.vaults where id = p_vault_id for share;
  select * into v_resolution
  from public.resolve_vault_capability_internal(p_vault_id, p_capability, 'editor');
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
  select * into v_asset from public.vault_assets
  where vault_id = p_vault_id and file_id = p_file_id and deleted_at is null
  for update;
  if v_asset.id is null then
    raise exception using message = 'VAULT_NOT_FOUND', errcode = 'P0001';
  end if;
  if v_asset.encrypted_digest <> p_observed_encrypted_digest
    or v_asset.ciphertext_bytes <> p_observed_ciphertext_bytes
  then
    raise exception using message = 'VAULT_ASSET_CONFLICT', errcode = 'P0001';
  end if;
  update public.vault_assets set state = 'ready'
  where id = v_asset.id
  returning * into v_asset;
  return jsonb_build_object(
    'vaultId', v_asset.vault_id,
    'fileId', v_asset.file_id,
    'storagePath', v_asset.storage_path,
    'state', v_asset.state
  );
end;
$$;

create or replace function public.resolve_vault_asset(
  p_vault_id uuid,
  p_capability text,
  p_file_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_resolution record;
  v_asset public.vault_assets;
begin
  select * into v_resolution
  from public.resolve_vault_capability_internal(p_vault_id, p_capability, null);
  select * into v_asset from public.vault_assets
  where vault_id = p_vault_id and file_id = p_file_id
    and state = 'ready' and deleted_at is null;
  if v_asset.id is null then
    raise exception using message = 'VAULT_NOT_FOUND', errcode = 'P0001';
  end if;
  return jsonb_build_object(
    'vaultId', v_asset.vault_id,
    'fileId', v_asset.file_id,
    'storagePath', v_asset.storage_path,
    'encryptedDigest', v_asset.encrypted_digest,
    'ciphertextBytes', v_asset.ciphertext_bytes
  );
end;
$$;

create or replace function public.revoke_vault_invitation(
  p_vault_id uuid,
  p_invitation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_invitation public.vault_invitations;
begin
  if not exists (
    select 1 from public.vaults where id = p_vault_id and owner_id = auth.uid()
  ) then
    raise exception using message = 'VAULT_CAPABILITY_FORBIDDEN', errcode = 'P0001';
  end if;

  update public.vault_invitations
  set revoked_at = coalesce(revoked_at, now()),
      authorization_version = authorization_version + case when revoked_at is null then 1 else 0 end
  where id = p_invitation_id and vault_id = p_vault_id
  returning * into v_invitation;
  if v_invitation.id is null then
    raise exception using message = 'VAULT_NOT_FOUND', errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'vaultId', v_invitation.vault_id,
    'invitationId', v_invitation.id,
    'authorizationVersion', v_invitation.authorization_version,
    'reason', 'revoked'
  );
end;
$$;

create or replace function public.revoke_vault(p_vault_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.vaults
  set state = 'revoked', revoked_at = coalesce(revoked_at, now())
  where id = p_vault_id and owner_id = auth.uid() and state in ('active', 'revoked');
  if not found then
    raise exception using message = 'VAULT_NOT_FOUND', errcode = 'P0001';
  end if;
  update public.vault_invitations
  set revoked_at = coalesce(revoked_at, now()),
      authorization_version = authorization_version + case when revoked_at is null then 1 else 0 end
  where vault_id = p_vault_id;
  return jsonb_build_object('vaultId', p_vault_id, 'reason', 'vault-revoked');
end;
$$;

create or replace function public.soft_delete_vault(p_vault_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_delete_after timestamptz := now() + interval '7 days';
  v_vault public.vaults;
begin
  update public.vaults
  set state = 'deleted',
      revoked_at = coalesce(revoked_at, now()),
      deleted_at = coalesce(deleted_at, now()),
      delete_after = coalesce(delete_after, v_delete_after)
  where id = p_vault_id
    and owner_id = auth.uid()
    and state in ('revoked', 'failed', 'deleted')
  returning * into v_vault;
  if v_vault.id is null then
    raise exception using message = 'VAULT_NOT_FOUND', errcode = 'P0001';
  end if;
  update public.vault_invitations
  set revoked_at = coalesce(revoked_at, now()),
      authorization_version = authorization_version + case when revoked_at is null then 1 else 0 end
  where vault_id = p_vault_id;
  return jsonb_build_object(
    'vaultId', p_vault_id,
    'reason', 'vault-deleted',
    'deleteAfter', v_vault.delete_after
  );
end;
$$;

-- Explicit function execute allowlist. Internal helpers remain inaccessible.
revoke all on function public.create_vault(uuid, smallint, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.activate_vault(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.fail_vault_creation(uuid) from public, anon, authenticated, service_role;
revoke all on function public.create_vault_invitation(uuid, text, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.resolve_vault_capability(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.load_vault_snapshot(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.cas_vault_snapshot(uuid, text, bigint, jsonb, bigint) from public, anon, authenticated, service_role;
revoke all on function public.register_vault_asset(uuid, text, text, text, bigint) from public, anon, authenticated, service_role;
revoke all on function public.complete_vault_asset(uuid, text, text, text, bigint) from public, anon, authenticated, service_role;
revoke all on function public.resolve_vault_asset(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.revoke_vault_invitation(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.revoke_vault(uuid) from public, anon, authenticated, service_role;
revoke all on function public.soft_delete_vault(uuid) from public, anon, authenticated, service_role;

grant execute on function public.create_vault(uuid, smallint, text, timestamptz) to authenticated;
grant execute on function public.activate_vault(uuid, text) to authenticated;
grant execute on function public.fail_vault_creation(uuid) to authenticated;
grant execute on function public.create_vault_invitation(uuid, text, text, timestamptz) to authenticated;
grant execute on function public.revoke_vault_invitation(uuid, uuid) to authenticated;
grant execute on function public.revoke_vault(uuid) to authenticated;
grant execute on function public.soft_delete_vault(uuid) to authenticated;

grant execute on function public.resolve_vault_capability(uuid, text) to anon, authenticated, service_role;
grant execute on function public.load_vault_snapshot(uuid, text) to anon, authenticated;
grant execute on function public.cas_vault_snapshot(uuid, text, bigint, jsonb, bigint) to anon, authenticated;
grant execute on function public.register_vault_asset(uuid, text, text, text, bigint) to anon, authenticated, service_role;
grant execute on function public.complete_vault_asset(uuid, text, text, text, bigint) to service_role;
grant execute on function public.resolve_vault_asset(uuid, text, text) to anon, authenticated, service_role;

-- Storage boundary (frozen F0 contract): do not add policies that authorize by
-- active vault ID/path alone. A controlled backend/service-role endpoint must
-- revalidate the invitation capability and issue a short-lived scoped upload or
-- download URL for the exact storage_path returned by these RPCs.
