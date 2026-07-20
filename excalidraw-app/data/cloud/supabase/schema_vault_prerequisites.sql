-- P4a Vault-only prerequisite used by the local and isolated remote workflows.
-- Keep this file free of ordinary/plain scene tables and policies.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

do $$
begin
  if not exists (
    select 1
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pgcrypto'
      and n.nspname = 'extensions'
  ) then
    raise exception using
      message = 'VAULT_PERSISTENCE_UNAVAILABLE',
      errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.vault_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.vault_touch_updated_at() from public,
  anon, authenticated, service_role;
