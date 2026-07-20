-- P4a Vault F0 rollback. This disables/removes only the independent Vault path.
-- It never migrates Vault ciphertext into plain/legacy scene tables.

drop function if exists public.get_vault_deployment_contract();
drop function if exists public.soft_delete_vault(uuid);
drop function if exists public.revoke_vault(uuid);
drop function if exists public.revoke_vault_invitation(uuid, uuid);
drop function if exists public.resolve_vault_asset(uuid, text, text);
drop function if exists public.complete_vault_asset(uuid, text, text, text, bigint);
drop function if exists public.register_vault_asset(uuid, text, text, text, bigint);
drop function if exists public.cas_vault_snapshot(uuid, text, bigint, jsonb, bigint);
drop function if exists public.load_vault_snapshot(uuid, text);
drop function if exists public.resolve_vault_capability(uuid, text);
drop function if exists public.create_vault_invitation(uuid, text, text, timestamptz);
drop function if exists public.fail_vault_creation(uuid);
drop function if exists public.activate_vault(uuid, text);
drop function if exists public.create_vault(uuid, smallint, text, timestamptz);
drop function if exists public.resolve_vault_capability_internal(uuid, text, text);
drop function if exists public.assert_vault_envelope_v1(uuid, text, text, bigint, jsonb);
drop function if exists public.vault_capability_hash(uuid, text);
drop function if exists public.vault_base64url_decode(text);

drop table if exists public.vault_assets;
drop table if exists public.vault_snapshots;
drop table if exists public.vault_invitations;
drop table if exists public.vaults;
drop table if exists public.vault_deployment_metadata;
drop function if exists public.vault_touch_updated_at();
