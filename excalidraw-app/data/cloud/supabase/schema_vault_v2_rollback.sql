-- P4c Vault v2 rollback. Removes only the v2 additions of schema_vault_v2.sql.
-- Refuses while any v2 Vault exists: v2 ciphertext is never converted, moved
-- into v1 tables or into plain/legacy scene tables.

do $$
begin
  if exists (select 1 from public.vaults where protocol_version = 2) then
    raise exception 'Vault v2 rollback refused: v2 Vaults exist (soft-delete and purge them first)';
  end if;
end;
$$;

drop trigger if exists vault_snapshots_v1_guard on public.vault_snapshots;
drop function if exists public.vault_snapshots_v1_guard();
drop function if exists public.cas_vault_snapshot_v2(uuid, text, bigint, uuid, jsonb);
drop function if exists public.load_vault_snapshot_v2(uuid, text);
drop function if exists public.resolve_vault_capability_v2(uuid, text);
drop function if exists public.create_vault_v2(uuid, text, timestamptz);
drop function if exists public.assert_vault_envelope_v2(uuid, text, bigint, integer, integer, jsonb);
drop function if exists public.assert_vault_protocol(uuid, smallint);
drop function if exists public.vault_protocol_of(uuid);
drop function if exists public.get_vault_v2_contract();
drop table if exists public.vault_snapshot_commits;
drop table if exists public.vault_snapshot_chunks;
alter table public.vaults drop constraint if exists vaults_protocol_check;
alter table public.vaults
  add constraint vaults_protocol_v1_check check (protocol_version = 1);
