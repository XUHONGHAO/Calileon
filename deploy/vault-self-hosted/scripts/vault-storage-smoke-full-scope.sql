-- Vault Storage check for the `full` deployment scope.
--
-- schema_vault_storage_smoke.sql also asserts that the database has no client
-- `storage.objects` policy at all. That only holds for an isolated Vault
-- deployment: the ordinary cloud backend needs such policies so browsers can
-- upload assets to the `excalidraw-assets` bucket.
--
-- This file keeps the assertions that still apply and replaces the isolation
-- assertion with the property that actually protects the Vault:
--
--   1. the `vault-assets` bucket stays fail-closed,
--   2. `storage.objects` keeps row level security enabled,
--   3. every client-facing policy is bucket-scoped -- a policy without a
--      `bucket_id` filter would expose objects in *every* bucket, including
--      the Vault one,
--   4. no client-facing policy reaches the `vault-assets` bucket.
--
-- Limitation: 3 and 4 inspect the policy expressions as text. A policy that
-- reaches the Vault bucket only indirectly (through a helper function or a
-- subquery) would not be caught. The ordinary backend's policies are all
-- written as direct `bucket_id = 'excalidraw-assets'` predicates, so this is
-- sufficient to catch a regression in the schemas this repository installs.
--
-- This does not upload an object. Signed upload/download behavior is an Edge
-- runtime gate and must be tested separately with a disposable capability.

do $$
begin
  if not exists (
    select 1
    from storage.buckets
    where id = 'vault-assets'
      and name = 'vault-assets'
      and public is false
      and file_size_limit = 104857600
      and allowed_mime_types is null
  ) then
    raise exception 'vault-assets bucket is missing or not fail-closed';
  end if;

  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'storage'
      and c.relname = 'objects'
      and c.relrowsecurity is true
  ) then
    raise exception 'storage.objects row level security must remain enabled';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and roles && array['public', 'anon', 'authenticated']::name[]
      and (
        (qual is not null and qual !~ 'bucket_id')
        or (with_check is not null and with_check !~ 'bucket_id')
      )
  ) then
    raise exception 'client storage.objects policies must be bucket-scoped';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and roles && array['public', 'anon', 'authenticated']::name[]
      and (coalesce(qual, '') || coalesce(with_check, '')) like '%vault-assets%'
  ) then
    raise exception 'no client storage.objects policy may reach the vault-assets bucket';
  end if;
end;
$$;
