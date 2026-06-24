-- ============================================================================
-- Excalidraw self-hosted backend - Phase 3B cast session/export metadata
-- ----------------------------------------------------------------------------
-- Run after schema.sql and schema_assets.sql. This script is idempotent.
--
-- This phase only registers recording/playback metadata and exported assets.
-- It does not implement capture, playback, or server-side video transcoding.
-- ============================================================================

update storage.buckets
set allowed_mime_types = array[
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'application/json',
  'video/mp4',
  'video/webm'
]
where id = 'excalidraw-assets';

create table if not exists public.cast_sessions (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users (id) on delete cascade,
  scene_id        uuid not null references public.scenes (id) on delete cascade,
  title           text not null default '',
  status          text not null default 'draft' check (status in ('draft', 'ready', 'exported', 'archived')),
  script_asset_id uuid references public.assets (id) on delete set null,
  cover_asset_id  uuid references public.assets (id) on delete set null,
  duration_ms     bigint check (duration_ms is null or duration_ms >= 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

create index if not exists cast_sessions_scene_updated_idx
  on public.cast_sessions (owner_id, scene_id, updated_at desc)
  where deleted_at is null;

create index if not exists cast_sessions_script_asset_idx
  on public.cast_sessions (script_asset_id)
  where script_asset_id is not null;

create table if not exists public.cast_exports (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  scene_id    uuid not null references public.scenes (id) on delete cascade,
  session_id  uuid not null references public.cast_sessions (id) on delete cascade,
  asset_id    uuid not null references public.assets (id) on delete cascade,
  type        text not null check (type in ('gif', 'mp4', 'webm', 'interactive')),
  label       text,
  mime_type   text,
  bytes       bigint not null default 0 check (bytes >= 0),
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index if not exists cast_exports_scene_created_idx
  on public.cast_exports (owner_id, scene_id, created_at desc)
  where deleted_at is null;

create index if not exists cast_exports_session_created_idx
  on public.cast_exports (owner_id, session_id, created_at desc)
  where deleted_at is null;

alter table public.cast_sessions enable row level security;
alter table public.cast_exports enable row level security;

drop policy if exists "owner can read own cast sessions"   on public.cast_sessions;
drop policy if exists "owner can insert own cast sessions" on public.cast_sessions;
drop policy if exists "owner can update own cast sessions" on public.cast_sessions;
drop policy if exists "owner can delete own cast sessions" on public.cast_sessions;

create policy "owner can read own cast sessions"
  on public.cast_sessions for select
  using (auth.uid() = owner_id);

create policy "owner can insert own cast sessions"
  on public.cast_sessions for insert
  with check (
    auth.uid() = owner_id
    and exists (
      select 1
      from public.scenes s
      where s.id = public.cast_sessions.scene_id
        and s.owner_id = auth.uid()
        and s.deleted_at is null
    )
    and (
      script_asset_id is null
      or exists (
        select 1
        from public.assets a
        where a.id = public.cast_sessions.script_asset_id
          and a.owner_id = auth.uid()
          and a.type = 'recording'
          and a.deleted_at is null
          and (
            a.scene_id = public.cast_sessions.scene_id
            or a.scene_id is null
          )
      )
    )
    and (
      cover_asset_id is null
      or exists (
        select 1
        from public.assets a
        where a.id = public.cast_sessions.cover_asset_id
          and a.owner_id = auth.uid()
          and a.deleted_at is null
          and (
            a.scene_id = public.cast_sessions.scene_id
            or a.scene_id is null
          )
      )
    )
  );

create policy "owner can update own cast sessions"
  on public.cast_sessions for update
  using (auth.uid() = owner_id)
  with check (
    auth.uid() = owner_id
    and exists (
      select 1
      from public.scenes s
      where s.id = public.cast_sessions.scene_id
        and s.owner_id = auth.uid()
        and s.deleted_at is null
    )
    and (
      script_asset_id is null
      or exists (
        select 1
        from public.assets a
        where a.id = public.cast_sessions.script_asset_id
          and a.owner_id = auth.uid()
          and a.type = 'recording'
          and a.deleted_at is null
          and (
            a.scene_id = public.cast_sessions.scene_id
            or a.scene_id is null
          )
      )
    )
    and (
      cover_asset_id is null
      or exists (
        select 1
        from public.assets a
        where a.id = public.cast_sessions.cover_asset_id
          and a.owner_id = auth.uid()
          and a.deleted_at is null
          and (
            a.scene_id = public.cast_sessions.scene_id
            or a.scene_id is null
          )
      )
    )
  );

create policy "owner can delete own cast sessions"
  on public.cast_sessions for delete
  using (auth.uid() = owner_id);

drop policy if exists "owner can read own cast exports"   on public.cast_exports;
drop policy if exists "owner can insert own cast exports" on public.cast_exports;
drop policy if exists "owner can update own cast exports" on public.cast_exports;
drop policy if exists "owner can delete own cast exports" on public.cast_exports;

create policy "owner can read own cast exports"
  on public.cast_exports for select
  using (auth.uid() = owner_id);

create policy "owner can insert own cast exports"
  on public.cast_exports for insert
  with check (
    auth.uid() = owner_id
    and exists (
      select 1
      from public.scenes s
      where s.id = public.cast_exports.scene_id
        and s.owner_id = auth.uid()
        and s.deleted_at is null
    )
    and exists (
      select 1
      from public.cast_sessions cs
      where cs.id = public.cast_exports.session_id
        and cs.owner_id = auth.uid()
        and cs.scene_id = public.cast_exports.scene_id
        and cs.deleted_at is null
    )
    and exists (
      select 1
      from public.assets a
      where a.id = public.cast_exports.asset_id
        and a.owner_id = auth.uid()
        and a.type = 'export'
        and a.deleted_at is null
        and (
          a.scene_id = public.cast_exports.scene_id
          or a.scene_id is null
        )
    )
  );

create policy "owner can update own cast exports"
  on public.cast_exports for update
  using (auth.uid() = owner_id)
  with check (
    auth.uid() = owner_id
    and exists (
      select 1
      from public.scenes s
      where s.id = public.cast_exports.scene_id
        and s.owner_id = auth.uid()
        and s.deleted_at is null
    )
    and exists (
      select 1
      from public.cast_sessions cs
      where cs.id = public.cast_exports.session_id
        and cs.owner_id = auth.uid()
        and cs.scene_id = public.cast_exports.scene_id
        and cs.deleted_at is null
    )
    and exists (
      select 1
      from public.assets a
      where a.id = public.cast_exports.asset_id
        and a.owner_id = auth.uid()
        and a.type = 'export'
        and a.deleted_at is null
        and (
          a.scene_id = public.cast_exports.scene_id
          or a.scene_id is null
        )
    )
  );

create policy "owner can delete own cast exports"
  on public.cast_exports for delete
  using (auth.uid() = owner_id);

drop trigger if exists cast_sessions_touch_updated_at on public.cast_sessions;

create trigger cast_sessions_touch_updated_at
  before update on public.cast_sessions
  for each row execute function public.touch_updated_at();
