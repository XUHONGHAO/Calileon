-- ============================================================================
-- Excalidraw self-hosted backend - Phase 4C Supabase collab persistence
-- ----------------------------------------------------------------------------
-- Run after schema.sql, schema_assets.sql, and schema_collab_rooms.sql.
--
-- High-frequency collaboration still uses excalidraw-room. These tables store
-- encrypted room snapshots and encrypted room asset metadata for recovery.
-- The server never receives or stores room keys.
-- ============================================================================

create table if not exists public.collab_room_snapshots (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references auth.users (id) on delete cascade,
  scene_id          uuid not null references public.scenes (id) on delete cascade,
  room_id           text not null references public.collab_rooms (room_id) on delete cascade,
  encrypted_payload jsonb not null,
  version           integer not null default 1,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint collab_room_snapshots_room_unique unique (room_id)
);

create table if not exists public.collab_room_assets (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users (id) on delete cascade,
  scene_id     uuid not null references public.scenes (id) on delete cascade,
  room_id      text not null references public.collab_rooms (room_id) on delete cascade,
  file_id      text not null,
  storage_path text not null,
  mime_type    text,
  bytes        bigint not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  constraint collab_room_assets_room_file_unique unique (room_id, file_id)
);

create index if not exists collab_room_assets_room_idx
  on public.collab_room_assets (room_id, created_at)
  where deleted_at is null;

alter table public.collab_room_snapshots enable row level security;
alter table public.collab_room_assets enable row level security;

drop policy if exists "owner can read own collab snapshots" on public.collab_room_snapshots;
drop policy if exists "owner can write own collab snapshots" on public.collab_room_snapshots;
drop policy if exists "owner can read own collab room assets" on public.collab_room_assets;
drop policy if exists "owner can write own collab room assets" on public.collab_room_assets;

create policy "owner can read own collab snapshots"
  on public.collab_room_snapshots for select
  using (auth.uid() = owner_id);

create policy "owner can write own collab snapshots"
  on public.collab_room_snapshots for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create policy "owner can read own collab room assets"
  on public.collab_room_assets for select
  using (auth.uid() = owner_id);

create policy "owner can write own collab room assets"
  on public.collab_room_assets for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop trigger if exists collab_room_snapshots_touch_updated_at on public.collab_room_snapshots;
drop trigger if exists collab_room_assets_touch_updated_at on public.collab_room_assets;

create trigger collab_room_snapshots_touch_updated_at
  before update on public.collab_room_snapshots
  for each row execute function public.touch_updated_at();

create trigger collab_room_assets_touch_updated_at
  before update on public.collab_room_assets
  for each row execute function public.touch_updated_at();

create or replace function public.save_collab_room_snapshot(
  p_room_id text,
  p_encrypted_payload jsonb
)
returns table(room_id text, version integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.collab_rooms;
begin
  select *
    into v_room
  from public.collab_rooms cr
  where cr.room_id = p_room_id
    and cr.status = 'active'
    and cr.revoked_at is null
  limit 1;

  if v_room.id is null then
    raise exception 'cloud-collab-room-not-found';
  end if;

  insert into public.collab_room_snapshots (
    owner_id,
    scene_id,
    room_id,
    encrypted_payload,
    version
  )
  values (
    v_room.owner_id,
    v_room.scene_id,
    v_room.room_id,
    p_encrypted_payload,
    1
  )
  on conflict on constraint collab_room_snapshots_room_unique do update set
    encrypted_payload = excluded.encrypted_payload,
    version = public.collab_room_snapshots.version + 1
  returning public.collab_room_snapshots.room_id, public.collab_room_snapshots.version
  into room_id, version;

  return next;
end;
$$;

create or replace function public.load_collab_room_snapshot(p_room_id text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'room_id', snap.room_id,
    'version', snap.version,
    'encrypted_payload', snap.encrypted_payload,
    'updated_at', snap.updated_at
  )
  from public.collab_room_snapshots snap
  join public.collab_rooms cr on cr.room_id = snap.room_id
  where snap.room_id = p_room_id
    and cr.status = 'active'
    and cr.revoked_at is null
  limit 1;
$$;

create or replace function public.register_collab_room_asset(
  p_room_id text,
  p_file_id text,
  p_storage_path text,
  p_mime_type text,
  p_bytes bigint
)
returns public.collab_room_assets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.collab_rooms;
  v_expected_path text;
  v_asset public.collab_room_assets;
begin
  select *
    into v_room
  from public.collab_rooms cr
  where cr.room_id = p_room_id
    and cr.status = 'active'
    and cr.revoked_at is null
  limit 1;

  if v_room.id is null then
    raise exception 'cloud-collab-room-not-found';
  end if;

  v_expected_path := 'collab/' || p_room_id || '/' || p_file_id;
  if p_storage_path <> v_expected_path then
    raise exception 'cloud-collab-forbidden';
  end if;

  insert into public.collab_room_assets (
    owner_id,
    scene_id,
    room_id,
    file_id,
    storage_path,
    mime_type,
    bytes,
    deleted_at
  )
  values (
    v_room.owner_id,
    v_room.scene_id,
    v_room.room_id,
    p_file_id,
    p_storage_path,
    p_mime_type,
    p_bytes,
    null
  )
  on conflict on constraint collab_room_assets_room_file_unique do update set
    storage_path = excluded.storage_path,
    mime_type = excluded.mime_type,
    bytes = excluded.bytes,
    deleted_at = null
  returning * into v_asset;

  return v_asset;
end;
$$;

grant execute on function public.save_collab_room_snapshot(text, jsonb) to anon, authenticated;
grant execute on function public.load_collab_room_snapshot(text) to anon, authenticated;
grant execute on function public.register_collab_room_asset(text, text, text, text, bigint) to anon, authenticated;

create or replace function public.has_active_collab_room(p_room_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.collab_rooms cr
    join public.scenes s on s.id = cr.scene_id
    where cr.room_id = p_room_id
      and cr.status = 'active'
      and cr.revoked_at is null
      and s.deleted_at is null
  );
$$;

grant execute on function public.has_active_collab_room(text) to anon, authenticated;

create or replace function public.get_collab_room_access(p_room_id text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select case
        when cr.status = 'active'
          and cr.revoked_at is null
          and s.deleted_at is null
          then 'active'
        else 'revoked'
      end
      from public.collab_rooms cr
      join public.scenes s on s.id = cr.scene_id
      where cr.room_id = p_room_id
      limit 1
    ),
    'unknown'
  );
$$;

grant execute on function public.get_collab_room_access(text) to anon, authenticated;

drop policy if exists "active collab rooms can read asset objects" on storage.objects;
drop policy if exists "active collab rooms can insert asset objects" on storage.objects;
drop policy if exists "active collab rooms can update asset objects" on storage.objects;

create policy "active collab rooms can read asset objects"
  on storage.objects for select
  using (
    bucket_id = 'excalidraw-assets'
    and (storage.foldername(name))[1] = 'collab'
    and public.has_active_collab_room((storage.foldername(name))[2])
  );

create policy "active collab rooms can insert asset objects"
  on storage.objects for insert
  with check (
    bucket_id = 'excalidraw-assets'
    and (storage.foldername(name))[1] = 'collab'
    and public.has_active_collab_room((storage.foldername(name))[2])
  );

create policy "active collab rooms can update asset objects"
  on storage.objects for update
  using (
    bucket_id = 'excalidraw-assets'
    and (storage.foldername(name))[1] = 'collab'
    and public.has_active_collab_room((storage.foldername(name))[2])
  )
  with check (
    bucket_id = 'excalidraw-assets'
    and (storage.foldername(name))[1] = 'collab'
    and public.has_active_collab_room((storage.foldername(name))[2])
  );
