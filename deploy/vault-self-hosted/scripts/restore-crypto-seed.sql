\set ON_ERROR_STOP on

begin;

delete from auth.users
where id = '40000000-0000-4000-8000-000000000001'::uuid;

insert into auth.users (
  id,
  aud,
  role,
  email,
  encrypted_password,
  created_at,
  updated_at
) values (
  '40000000-0000-4000-8000-000000000001'::uuid,
  'authenticated',
  'authenticated',
  'vault-restore-fixture@example.invalid',
  '',
  now(),
  now()
);

insert into public.vaults (
  id,
  owner_id,
  state,
  protocol_version,
  active_room_id,
  snapshot_generation
) values (
  '40000000-0000-4000-8000-000000000002'::uuid,
  '40000000-0000-4000-8000-000000000001'::uuid,
  'active',
  1,
  'restore-crypto-fixture-room',
  0
);

insert into public.vault_invitations (
  vault_id,
  role,
  capability_hash,
  authorization_version,
  created_by,
  expires_at
) values (
  '40000000-0000-4000-8000-000000000002'::uuid,
  'editor',
  public.vault_capability_hash(
    '40000000-0000-4000-8000-000000000002'::uuid,
    repeat('C', 43)
  ),
  1,
  '40000000-0000-4000-8000-000000000001'::uuid,
  now() + interval '1 hour'
);

set local role anon;
select public.cas_vault_snapshot(
  '40000000-0000-4000-8000-000000000002'::uuid,
  repeat('C', 43),
  0,
  convert_from(decode(:'envelope_base64', 'base64'), 'utf8')::jsonb,
  :ciphertext_bytes::bigint
);
reset role;

commit;
