-- ============================================================================
-- Excalidraw self-hosted backend - Phase 2A assets
-- ----------------------------------------------------------------------------
-- Run after schema.sql. This script is idempotent.
--
-- Storage bucket:
--   excalidraw-assets, private, signed URL access only.
--
-- Object path rule:
--   {owner_id}/{scene_id}/{file_id}
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'excalidraw-assets',
  'excalidraw-assets',
  false,
  20971520,
  array[
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'image/svg+xml',
    'application/json',
    'video/mp4',
    'video/webm'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.assets (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users (id) on delete cascade,
  scene_id     uuid references public.scenes (id) on delete cascade,
  file_id      text,
  type         text not null default 'image',
  storage_path text not null,
  mime_type    text,
  bytes        bigint not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  constraint assets_owner_scene_file_unique unique (owner_id, scene_id, file_id)
);

create index if not exists assets_scene_idx
  on public.assets (owner_id, scene_id, created_at)
  where deleted_at is null;

create unique index if not exists assets_storage_path_unique
  on public.assets (storage_path);

alter table public.assets enable row level security;

drop policy if exists "owner can read own assets"   on public.assets;
drop policy if exists "owner can insert own assets" on public.assets;
drop policy if exists "owner can update own assets" on public.assets;
drop policy if exists "owner can delete own assets" on public.assets;

create policy "owner can read own assets"
  on public.assets for select
  using (auth.uid() = owner_id);

create policy "owner can insert own assets"
  on public.assets for insert
  with check (auth.uid() = owner_id);

create policy "owner can update own assets"
  on public.assets for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create policy "owner can delete own assets"
  on public.assets for delete
  using (auth.uid() = owner_id);

drop trigger if exists assets_touch_updated_at on public.assets;

create trigger assets_touch_updated_at
  before update on public.assets
  for each row execute function public.touch_updated_at();

drop policy if exists "owner can read own asset objects"   on storage.objects;
drop policy if exists "owner can insert own asset objects" on storage.objects;
drop policy if exists "owner can update own asset objects" on storage.objects;
drop policy if exists "owner can delete own asset objects" on storage.objects;

create policy "owner can read own asset objects"
  on storage.objects for select
  using (
    bucket_id = 'excalidraw-assets'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "owner can insert own asset objects"
  on storage.objects for insert
  with check (
    bucket_id = 'excalidraw-assets'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "owner can update own asset objects"
  on storage.objects for update
  using (
    bucket_id = 'excalidraw-assets'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'excalidraw-assets'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "owner can delete own asset objects"
  on storage.objects for delete
  using (
    bucket_id = 'excalidraw-assets'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
