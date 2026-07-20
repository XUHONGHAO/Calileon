-- P4a F4 deployment compatibility contract.
-- The public client never reads this table directly; the control-plane Edge
-- Function resolves it with service_role and advertises only version metadata.

create table if not exists public.vault_deployment_metadata (
  singleton                boolean primary key default true,
  deployment_version       text not null,
  schema_version           smallint not null,
  protocol_version         smallint not null,
  updated_at               timestamptz not null default now(),
  constraint vault_deployment_metadata_singleton_check check (singleton),
  constraint vault_deployment_metadata_version_check
    check (
      deployment_version = 'p4a-f4-v1'
      and schema_version = 1
      and protocol_version = 1
    )
);

insert into public.vault_deployment_metadata (
  singleton,
  deployment_version,
  schema_version,
  protocol_version,
  updated_at
)
values (true, 'p4a-f4-v1', 1, 1, now())
on conflict (singleton) do update
set deployment_version = excluded.deployment_version,
    schema_version = excluded.schema_version,
    protocol_version = excluded.protocol_version,
    updated_at = now();

alter table public.vault_deployment_metadata enable row level security;
revoke all on table public.vault_deployment_metadata from anon, authenticated;

create or replace function public.get_vault_deployment_contract()
returns jsonb
language sql
security definer
set search_path = pg_catalog, public
stable
as $$
  select jsonb_build_object(
    'deploymentVersion', deployment_version,
    'schemaVersion', schema_version,
    'protocolVersion', protocol_version
  )
  from public.vault_deployment_metadata
  where singleton = true;
$$;

revoke all on function public.get_vault_deployment_contract()
  from public, anon, authenticated, service_role;
grant execute on function public.get_vault_deployment_contract() to service_role;
