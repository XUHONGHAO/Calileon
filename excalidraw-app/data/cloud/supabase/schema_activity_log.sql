-- ============================================================================
-- Excalidraw self-hosted backend - Phase 3A collaboration metadata
-- ----------------------------------------------------------------------------
-- Run after schema.sql. This script is idempotent.
--
-- This table stores lightweight "who changed what and when" metadata for cloud
-- whiteboards. It is not a realtime transport and should not contain full
-- element payloads or high-frequency cursor/move data.
-- ============================================================================

create table if not exists public.activity_log (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users (id) on delete cascade,
  scene_id   uuid not null references public.scenes (id) on delete cascade,
  element_id text,
  actor_id   text not null,
  op_type    text not null check (
    op_type in (
      'create',
      'update',
      'delete',
      'bind',
      'status-change',
      'tone-change'
    )
  ),
  summary    text,
  created_at timestamptz not null default now()
);

create index if not exists activity_log_scene_created_idx
  on public.activity_log (owner_id, scene_id, created_at desc);

create index if not exists activity_log_element_created_idx
  on public.activity_log (owner_id, scene_id, element_id, created_at desc)
  where element_id is not null;

alter table public.activity_log enable row level security;

drop policy if exists "owner can read own activity"   on public.activity_log;
drop policy if exists "owner can insert own activity" on public.activity_log;
drop policy if exists "owner can delete own activity" on public.activity_log;

create policy "owner can read own activity"
  on public.activity_log for select
  using (auth.uid() = owner_id);

create policy "owner can insert own activity"
  on public.activity_log for insert
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

create policy "owner can delete own activity"
  on public.activity_log for delete
  using (auth.uid() = owner_id);
