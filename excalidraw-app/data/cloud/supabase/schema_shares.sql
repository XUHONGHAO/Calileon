-- ============================================================================
-- Excalidraw self-hosted backend - Phase 2B cloud share links
-- ----------------------------------------------------------------------------
-- Run after schema.sql and schema_assets.sql. This script is idempotent.
--
-- Share URL shape in the app:
--   #cloud={token}
--
-- Buckets stay private. Anonymous access goes through token-checked RPC plus
-- storage policies scoped to scenes that currently have active shares.
-- ============================================================================

create table if not exists public.shares (
  id         uuid primary key default gen_random_uuid(),
  scene_id   uuid not null references public.scenes (id) on delete cascade,
  owner_id   uuid not null references auth.users (id) on delete cascade,
  mode       text not null check (mode in ('read', 'write')),
  token      text not null unique,
  revoked    boolean not null default false,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists shares_scene_created_idx
  on public.shares (owner_id, scene_id, created_at desc);

create index if not exists shares_active_token_idx
  on public.shares (token)
  where revoked = false;

alter table public.shares enable row level security;

drop policy if exists "owner can read own shares"   on public.shares;
drop policy if exists "owner can insert own shares" on public.shares;
drop policy if exists "owner can update own shares" on public.shares;
drop policy if exists "owner can delete own shares" on public.shares;

create policy "owner can read own shares"
  on public.shares for select
  using (auth.uid() = owner_id);

create policy "owner can insert own shares"
  on public.shares for insert
  with check (
    auth.uid() = owner_id
    and exists (
      select 1
      from public.scenes s
      where s.id = scene_id
        and s.owner_id = auth.uid()
        and s.deleted_at is null
    )
  );

create policy "owner can update own shares"
  on public.shares for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create policy "owner can delete own shares"
  on public.shares for delete
  using (auth.uid() = owner_id);

drop trigger if exists shares_touch_updated_at on public.shares;

create trigger shares_touch_updated_at
  before update on public.shares
  for each row execute function public.touch_updated_at();

create or replace function public.resolve_cloud_share(p_token text)
returns table(scene_id uuid, owner_id uuid, mode text)
language sql
security definer
set search_path = public
as $$
  select sh.scene_id, sh.owner_id, sh.mode
  from public.shares sh
  join public.scenes s on s.id = sh.scene_id
  where sh.token = p_token
    and sh.revoked = false
    and (sh.expires_at is null or sh.expires_at > now())
    and s.deleted_at is null
  limit 1;
$$;

create or replace function public.load_shared_scene(p_token text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'mode', sh.mode,
    'scene', to_jsonb(s),
    'assets', coalesce(
      jsonb_agg(to_jsonb(a) order by a.created_at)
        filter (where a.id is not null),
      '[]'::jsonb
    )
  )
  from public.shares sh
  join public.scenes s on s.id = sh.scene_id
  left join public.assets a
    on a.scene_id = s.id
   and a.owner_id = s.owner_id
   and a.deleted_at is null
  where sh.token = p_token
    and sh.revoked = false
    and (sh.expires_at is null or sh.expires_at > now())
    and s.deleted_at is null
  group by sh.mode, s.id;
$$;

create or replace function public.save_shared_scene(
  p_token text,
  p_payload jsonb,
  p_title text,
  p_version integer,
  p_thumbnail_meta jsonb default null
)
returns table(id uuid, version integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scene_id uuid;
begin
  select sh.scene_id
    into v_scene_id
  from public.shares sh
  join public.scenes s on s.id = sh.scene_id
  where sh.token = p_token
    and sh.mode = 'write'
    and sh.revoked = false
    and (sh.expires_at is null or sh.expires_at > now())
    and s.deleted_at is null
  limit 1;

  if v_scene_id is null then
    raise exception 'cloud-share-forbidden';
  end if;

  return query
  update public.scenes s
     set payload = p_payload,
         title = coalesce(nullif(trim(p_title), ''), s.title),
         thumbnail_meta = p_thumbnail_meta,
         version = s.version + 1
   where s.id = v_scene_id
     and s.deleted_at is null
     and s.version = p_version
   returning s.id, s.version;

  if not found then
    raise exception 'cloud-share-version-conflict';
  end if;
end;
$$;

create or replace function public.upsert_shared_asset(
  p_token text,
  p_file_id text,
  p_type text,
  p_storage_path text,
  p_mime_type text,
  p_bytes bigint
)
returns public.assets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scene_id uuid;
  v_owner_id uuid;
  v_expected_path text;
  v_asset public.assets;
begin
  select sh.scene_id, sh.owner_id
    into v_scene_id, v_owner_id
  from public.shares sh
  join public.scenes s on s.id = sh.scene_id
  where sh.token = p_token
    and sh.mode = 'write'
    and sh.revoked = false
    and (sh.expires_at is null or sh.expires_at > now())
    and s.deleted_at is null
  limit 1;

  if v_scene_id is null then
    raise exception 'cloud-share-forbidden';
  end if;

  v_expected_path := v_owner_id::text || '/' || v_scene_id::text || '/' || p_file_id;
  if p_storage_path <> v_expected_path then
    raise exception 'cloud-share-forbidden';
  end if;

  insert into public.assets (
    owner_id,
    scene_id,
    file_id,
    type,
    storage_path,
    mime_type,
    bytes,
    deleted_at
  )
  values (
    v_owner_id,
    v_scene_id,
    p_file_id,
    p_type,
    p_storage_path,
    p_mime_type,
    p_bytes,
    null
  )
  on conflict (owner_id, scene_id, file_id) do update set
    type = excluded.type,
    storage_path = excluded.storage_path,
    mime_type = excluded.mime_type,
    bytes = excluded.bytes,
    deleted_at = null
  returning * into v_asset;

  return v_asset;
end;
$$;

grant execute on function public.resolve_cloud_share(text) to anon, authenticated;
grant execute on function public.load_shared_scene(text) to anon, authenticated;
grant execute on function public.save_shared_scene(text, jsonb, text, integer, jsonb) to anon, authenticated;
grant execute on function public.upsert_shared_asset(text, text, text, text, text, bigint) to anon, authenticated;

create or replace function public.has_active_cloud_share_for_asset(
  p_owner_id text,
  p_scene_id text,
  p_requires_write boolean default false
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.shares sh
    join public.scenes s on s.id = sh.scene_id
    where sh.owner_id::text = p_owner_id
      and sh.scene_id::text = p_scene_id
      and sh.revoked = false
      and (sh.expires_at is null or sh.expires_at > now())
      and (not p_requires_write or sh.mode = 'write')
      and s.deleted_at is null
  );
$$;

grant execute on function public.has_active_cloud_share_for_asset(text, text, boolean) to anon, authenticated;

drop policy if exists "shared scenes can read asset objects" on storage.objects;
drop policy if exists "shared write scenes can insert asset objects" on storage.objects;
drop policy if exists "shared write scenes can update asset objects" on storage.objects;

create policy "shared scenes can read asset objects"
  on storage.objects for select
  using (
    bucket_id = 'excalidraw-assets'
    and public.has_active_cloud_share_for_asset(
      (storage.foldername(name))[1],
      (storage.foldername(name))[2],
      false
    )
  );

create policy "shared write scenes can insert asset objects"
  on storage.objects for insert
  with check (
    bucket_id = 'excalidraw-assets'
    and public.has_active_cloud_share_for_asset(
      (storage.foldername(name))[1],
      (storage.foldername(name))[2],
      true
    )
  );

create policy "shared write scenes can update asset objects"
  on storage.objects for update
  using (
    bucket_id = 'excalidraw-assets'
    and public.has_active_cloud_share_for_asset(
      (storage.foldername(name))[1],
      (storage.foldername(name))[2],
      true
    )
  )
  with check (
    bucket_id = 'excalidraw-assets'
    and public.has_active_cloud_share_for_asset(
      (storage.foldername(name))[1],
      (storage.foldername(name))[2],
      true
    )
  );
