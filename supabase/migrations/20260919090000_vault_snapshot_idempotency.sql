-- P4b B2: durable snapshot outbox idempotency ledger.
-- Stores encrypted envelopes only; no keys, capabilities, or plaintext.

create table if not exists public.vault_snapshot_updates (
  vault_id               uuid not null references public.vaults (id) on delete cascade,
  room_id                text not null,
  update_id              uuid not null,
  generation             bigint not null,
  encrypted_envelope     jsonb not null,
  ciphertext_bytes       bigint not null,
  created_at             timestamptz not null default now(),
  primary key (vault_id, room_id, update_id),
  constraint vault_snapshot_updates_room_id_check
    check (room_id ~ '^[A-Za-z0-9_-]{16,128}$'),
  constraint vault_snapshot_updates_generation_check check (generation >= 1),
  constraint vault_snapshot_updates_bytes_check
    check (ciphertext_bytes > 0 and ciphertext_bytes <= 52428800)
);

do $$
begin
  if to_regclass('public.vault_snapshot_updates') is not null then
    alter table public.vault_snapshot_updates
      add column if not exists room_id text;

    update public.vault_snapshot_updates u
    set room_id = v.active_room_id
    from public.vaults v
    where u.vault_id = v.id and u.room_id is null;

    alter table public.vault_snapshot_updates
      drop constraint if exists vault_snapshot_updates_pkey;
    alter table public.vault_snapshot_updates
      alter column room_id set not null;
    alter table public.vault_snapshot_updates
      add constraint vault_snapshot_updates_pkey
      primary key (vault_id, room_id, update_id);
    alter table public.vault_snapshot_updates
      drop constraint if exists vault_snapshot_updates_room_id_check;
    alter table public.vault_snapshot_updates
      add constraint vault_snapshot_updates_room_id_check
      check (room_id ~ '^[A-Za-z0-9_-]{16,128}$');
  end if;
end;
$$;

alter table public.vault_snapshot_updates enable row level security;
revoke all on table public.vault_snapshot_updates from anon, authenticated;

create or replace function public.cas_vault_snapshot(
  p_vault_id uuid,
  p_capability text,
  p_expected_generation bigint,
  p_encrypted_envelope jsonb,
  p_ciphertext_bytes bigint,
  p_update_id uuid
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
  v_previous public.vault_snapshot_updates;
  v_new_generation bigint := p_expected_generation + 1;
begin
  select * into v_vault from public.vaults where id = p_vault_id for update;
  select * into v_resolution
  from public.resolve_vault_capability_internal(p_vault_id, p_capability, 'editor');
  if v_vault.state <> 'active' or v_vault.revoked_at is not null or v_vault.deleted_at is not null then
    raise exception using message = 'VAULT_NOT_ACTIVE', errcode = 'P0001';
  end if;
  select * into v_invitation from public.vault_invitations
  where id = v_resolution.invitation_id and vault_id = p_vault_id for share;
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
  if p_update_id is null
    or (p_encrypted_envelope ->> 'messageId') is distinct from p_update_id::text
  then
    raise exception using message = 'VAULT_ENVELOPE_INVALID', errcode = 'P0001';
  end if;
  perform public.assert_vault_envelope_v1(
    p_vault_id, 'snapshot', 'snapshot.scene', v_new_generation, p_encrypted_envelope
  );
  if p_ciphertext_bytes <= 0 or p_ciphertext_bytes > 52428800
    or octet_length(public.vault_base64url_decode(p_encrypted_envelope ->> 'ciphertext')) <> p_ciphertext_bytes
  then
    raise exception using message = 'VAULT_ENVELOPE_INVALID', errcode = 'P0001';
  end if;

  select * into v_previous from public.vault_snapshot_updates
  where vault_id = p_vault_id
    and room_id = v_vault.active_room_id
    and update_id = p_update_id
  for update;
  if v_previous.update_id is not null then
    if v_previous.generation <> (p_encrypted_envelope ->> 'generation')::bigint
      or v_previous.ciphertext_bytes <> p_ciphertext_bytes
      or v_previous.encrypted_envelope <> p_encrypted_envelope
    then
      raise exception using message = 'VAULT_SNAPSHOT_CONFLICT', errcode = 'P0001';
    end if;
    return jsonb_build_object(
      'vaultId', p_vault_id,
      'updateId', p_update_id,
      'generation', v_previous.generation,
      'updatedAt', v_previous.created_at
    );
  end if;

  if p_expected_generation < 0 or v_vault.snapshot_generation <> p_expected_generation then
    raise exception using message = 'VAULT_SNAPSHOT_CONFLICT', errcode = 'P0001';
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
  insert into public.vault_snapshot_updates (
    vault_id, room_id, update_id, generation, encrypted_envelope, ciphertext_bytes
  ) values (
    p_vault_id, v_vault.active_room_id, p_update_id, v_new_generation,
    p_encrypted_envelope, p_ciphertext_bytes
  );
  return jsonb_build_object(
    'vaultId', p_vault_id,
    'updateId', p_update_id,
    'generation', v_new_generation,
    'updatedAt', now()
  );
end;
$$;

revoke all on function public.cas_vault_snapshot(uuid, text, bigint, jsonb, bigint, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.cas_vault_snapshot(uuid, text, bigint, jsonb, bigint, uuid)
  to anon, authenticated;
