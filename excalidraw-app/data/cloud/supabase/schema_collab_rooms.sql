-- ============================================================================
-- Excalidraw self-hosted backend - Phase 4B collaboration room bindings
-- ----------------------------------------------------------------------------
-- Run after schema.sql.
--
-- This table binds a cloud scene to an excalidraw-room room id. It never stores
-- the room key; the key remains client-side in the URL hash.
-- ============================================================================

create table if not exists public.collab_rooms (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users (id) on delete cascade,
  scene_id   uuid not null references public.scenes (id) on delete cascade,
  room_id    text not null,
  status     text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists collab_rooms_scene_active_idx
  on public.collab_rooms (owner_id, scene_id, updated_at desc)
  where status = 'active' and revoked_at is null;

create unique index if not exists collab_rooms_room_id_unique
  on public.collab_rooms (room_id);

alter table public.collab_rooms enable row level security;

drop policy if exists "owner can read own collab rooms" on public.collab_rooms;
drop policy if exists "owner can insert own collab rooms" on public.collab_rooms;
drop policy if exists "owner can update own collab rooms" on public.collab_rooms;
drop policy if exists "owner can delete own collab rooms" on public.collab_rooms;

create policy "owner can read own collab rooms"
  on public.collab_rooms for select
  using (auth.uid() = owner_id);

create policy "owner can insert own collab rooms"
  on public.collab_rooms for insert
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

create policy "owner can update own collab rooms"
  on public.collab_rooms for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create policy "owner can delete own collab rooms"
  on public.collab_rooms for delete
  using (auth.uid() = owner_id);

drop trigger if exists collab_rooms_touch_updated_at on public.collab_rooms;

create trigger collab_rooms_touch_updated_at
  before update on public.collab_rooms
  for each row execute function public.touch_updated_at();
