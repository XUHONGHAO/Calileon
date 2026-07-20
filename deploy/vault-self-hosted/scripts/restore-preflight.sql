select case
  when to_regclass('public.vaults') is null
   and to_regclass('public.vault_invitations') is null
   and to_regclass('public.vault_snapshots') is null
   and to_regclass('public.vault_assets') is null
   and to_regclass('public.vault_deployment_metadata') is null
  then case
    when to_regrole('supabase_admin') is not null
     and to_regrole('supabase_auth_admin') is not null
     and to_regrole('supabase_storage_admin') is not null
     and to_regrole('supabase_realtime_admin') is not null
     and to_regrole('supabase_functions_admin') is not null
     and to_regrole('authenticator') is not null
     and to_regrole('anon') is not null
     and to_regrole('authenticated') is not null
     and to_regrole('service_role') is not null
     and to_regrole('pgbouncer') is not null
    then 0
    else 2
  end
  else 1
end;
