-- ============================================================================
-- Calileon self-hosted backend - account AI settings sync (ADR 0038)
-- ----------------------------------------------------------------------------
-- Run after schema.sql (needs public.touch_updated_at). Idempotent.
--
-- One row per account holding the user's AI global settings (models, agents,
-- prompt templates, network) as an AES-GCM ciphertext. The key is derived in
-- the browser from a sync passphrase the server never sees, so this table
-- only ever holds ciphertext, the KDF salt/parameters and the IV. Provider
-- API keys and proxy tokens are inside the ciphertext.
--
-- `revision` is the optimistic-concurrency token: clients update with
-- `where revision = <seen>` and write `<seen> + 1`; the trigger below rejects
-- any other step so two devices can't silently overwrite each other.
-- ============================================================================

create table if not exists public.account_ai_settings (
  owner_id        uuid primary key references auth.users (id) on delete cascade,
  format_version  integer not null check (format_version = 1),
  kdf             jsonb not null,
  iv              text not null check (char_length(iv) between 8 and 64),
  ciphertext      text not null check (char_length(ciphertext) between 1 and 1048576),
  revision        bigint not null default 1 check (revision >= 1),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.account_ai_settings enable row level security;

drop policy if exists "owner can read own ai settings"   on public.account_ai_settings;
drop policy if exists "owner can insert own ai settings" on public.account_ai_settings;
drop policy if exists "owner can update own ai settings" on public.account_ai_settings;
drop policy if exists "owner can delete own ai settings" on public.account_ai_settings;

create policy "owner can read own ai settings"
  on public.account_ai_settings for select
  to authenticated
  using (auth.uid() = owner_id);

create policy "owner can insert own ai settings"
  on public.account_ai_settings for insert
  to authenticated
  with check (auth.uid() = owner_id and revision = 1);

create policy "owner can update own ai settings"
  on public.account_ai_settings for update
  to authenticated
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create policy "owner can delete own ai settings"
  on public.account_ai_settings for delete
  to authenticated
  using (auth.uid() = owner_id);

revoke all on public.account_ai_settings from anon;
grant select, insert, update, delete on public.account_ai_settings to authenticated;

-- Each update must advance the revision by exactly one and keep the owner.
create or replace function public.account_ai_settings_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.owner_id <> old.owner_id then
    raise exception 'account-settings-owner-immutable';
  end if;
  if new.revision <> old.revision + 1 then
    raise exception 'account-settings-revision-step';
  end if;
  new.created_at := old.created_at;
  return new;
end;
$$;

drop trigger if exists account_ai_settings_guard on public.account_ai_settings;

create trigger account_ai_settings_guard
  before update on public.account_ai_settings
  for each row execute function public.account_ai_settings_guard();

drop trigger if exists account_ai_settings_touch_updated_at on public.account_ai_settings;

create trigger account_ai_settings_touch_updated_at
  before update on public.account_ai_settings
  for each row execute function public.touch_updated_at();
