-- ============================================================================
-- Excalidraw self-hosted backend - Phase 2C AI task metadata
-- ----------------------------------------------------------------------------
-- Run after schema.sql, schema_assets.sql, and schema_shares.sql.
-- This script is idempotent.
--
-- This indexes browser-direct AI Workbench runs for cloud whiteboards. It does
-- not store AI provider credentials, Authorization headers, base URLs, or raw
-- provider response bodies.
-- ============================================================================

create table if not exists public.ai_tasks (
  id                      uuid primary key default gen_random_uuid(),
  owner_id                uuid not null references auth.users (id) on delete cascade,
  scene_id                uuid not null references public.scenes (id) on delete cascade,
  feature_source          text not null default 'workbench',
  media_type              text not null check (media_type in ('image', 'video', 'audio')),
  mode                    text not null,
  status                  text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  model_id                text not null default '',
  model_label             text,
  provider_label          text,
  prompt_summary          text not null default '',
  negative_prompt_summary text,
  params                  jsonb not null default '{}'::jsonb,
  input_asset_ids         text[] not null default array[]::text[],
  output_asset_ids        text[] not null default array[]::text[],
  source_element_ids      text[] not null default array[]::text[],
  inserted_element_ids    text[] not null default array[]::text[],
  error_code              text,
  error_message           text,
  submitted_at            timestamptz not null default now(),
  completed_at            timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz
);

create index if not exists ai_tasks_owner_submitted_idx
  on public.ai_tasks (owner_id, submitted_at desc)
  where deleted_at is null;

create index if not exists ai_tasks_scene_submitted_idx
  on public.ai_tasks (owner_id, scene_id, submitted_at desc)
  where deleted_at is null;

alter table public.ai_tasks enable row level security;

drop policy if exists "owner can read own ai tasks"   on public.ai_tasks;
drop policy if exists "owner can insert own ai tasks" on public.ai_tasks;
drop policy if exists "owner can update own ai tasks" on public.ai_tasks;
drop policy if exists "owner can delete own ai tasks" on public.ai_tasks;

create policy "owner can read own ai tasks"
  on public.ai_tasks for select
  using (auth.uid() = owner_id);

create policy "owner can insert own ai tasks"
  on public.ai_tasks for insert
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

create policy "owner can update own ai tasks"
  on public.ai_tasks for update
  using (auth.uid() = owner_id)
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

create policy "owner can delete own ai tasks"
  on public.ai_tasks for delete
  using (auth.uid() = owner_id);

drop trigger if exists ai_tasks_touch_updated_at on public.ai_tasks;

create trigger ai_tasks_touch_updated_at
  before update on public.ai_tasks
  for each row execute function public.touch_updated_at();
