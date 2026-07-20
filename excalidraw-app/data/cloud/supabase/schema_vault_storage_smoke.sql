-- P4a Vault Online private Storage bucket smoke.
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

  if exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and roles && array['public', 'anon', 'authenticated']::name[]
  ) then
    raise exception 'isolated Vault acceptance refuses client storage.objects policies';
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
end;
$$;
