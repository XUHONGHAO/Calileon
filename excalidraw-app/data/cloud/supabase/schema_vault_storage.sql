-- ============================================================================
-- Excalidraw P4a Vault Online - private encrypted asset bucket
-- ----------------------------------------------------------------------------
-- Run after the Supabase Storage schema is available. Vault asset access is
-- only issued by vault-asset-access with a service-role client. This script
-- deliberately creates no anon/authenticated storage.objects policy.
-- ============================================================================

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'vault-assets',
  'vault-assets',
  false,
  104857600,
  null
)
-- Never repair or take over a pre-existing bucket implicitly. The assertion
-- below fails the enclosing install transaction if its settings differ.
on conflict (id) do nothing;

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
    raise exception using
      message = 'VAULT_PERSISTENCE_UNAVAILABLE',
      errcode = 'P0001';
  end if;
end;
$$;
