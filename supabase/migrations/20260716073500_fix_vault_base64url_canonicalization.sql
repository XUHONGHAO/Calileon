create or replace function public.assert_vault_envelope_v1(
  p_vault_id uuid,
  p_purpose text,
  p_message_type text,
  p_generation bigint,
  p_envelope jsonb
)
returns void
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_expected_keys integer;
  v_actual_keys integer;
begin
  if p_envelope is null or jsonb_typeof(p_envelope) <> 'object' then
    raise exception using message = 'VAULT_ENVELOPE_INVALID', errcode = 'P0001';
  end if;
  if jsonb_typeof(p_envelope -> 'version') <> 'number'
    or (p_envelope ->> 'version') <> '1'
  then
    raise exception using message = 'VAULT_PROTOCOL_UNSUPPORTED', errcode = 'P0001';
  end if;
  if jsonb_typeof(p_envelope -> 'messageType') <> 'string'
    or (p_envelope ->> 'messageType') not in (
      'realtime.content', 'realtime.presence', 'snapshot.scene', 'asset.content'
    )
  then
    raise exception using message = 'VAULT_MESSAGE_TYPE_UNSUPPORTED', errcode = 'P0001';
  end if;

  v_expected_keys := case p_purpose when 'snapshot' then 8 when 'asset' then 7 else 0 end;
  select count(*) into v_actual_keys from jsonb_object_keys(p_envelope);

  if v_expected_keys = 0
    or v_actual_keys <> v_expected_keys
    or jsonb_typeof(p_envelope -> 'version') <> 'number'
    or (p_envelope ->> 'version') <> '1'
    or jsonb_typeof(p_envelope -> 'vaultId') <> 'string'
    or (p_envelope ->> 'vaultId') <> lower(p_vault_id::text)
    or jsonb_typeof(p_envelope -> 'purpose') <> 'string'
    or (p_envelope ->> 'purpose') <> p_purpose
    or jsonb_typeof(p_envelope -> 'messageType') <> 'string'
    or (p_envelope ->> 'messageType') <> p_message_type
    or jsonb_typeof(p_envelope -> 'messageId') <> 'string'
    or coalesce(p_envelope ->> 'messageId', '') !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    or jsonb_typeof(p_envelope -> 'iv') <> 'string'
    or coalesce(p_envelope ->> 'iv', '') !~ '^[A-Za-z0-9_-]{16}$'
    or octet_length(public.vault_base64url_decode(p_envelope ->> 'iv')) <> 12
    or rtrim(translate(replace(replace(
      encode(public.vault_base64url_decode(p_envelope ->> 'iv'), 'base64'),
      E'\n', ''
    ), E'\r', ''), '+/', '-_'), '=')
      <> (p_envelope ->> 'iv')
    or jsonb_typeof(p_envelope -> 'ciphertext') <> 'string'
    or coalesce(p_envelope ->> 'ciphertext', '') !~ '^[A-Za-z0-9_-]+$'
    or rtrim(translate(replace(replace(
      encode(public.vault_base64url_decode(p_envelope ->> 'ciphertext'), 'base64'),
      E'\n', ''
    ), E'\r', ''), '+/', '-_'), '=')
      <> (p_envelope ->> 'ciphertext')
    or (p_purpose = 'snapshot' and (
      not (p_envelope ? 'generation')
      or jsonb_typeof(p_envelope -> 'generation') <> 'number'
      or (p_envelope ->> 'generation') <> p_generation::text
    ))
    or (p_purpose = 'asset' and (p_envelope ? 'generation'))
  then
    raise exception using message = 'VAULT_ENVELOPE_INVALID', errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.assert_vault_envelope_v1(uuid, text, text, bigint, jsonb)
  from public, anon, authenticated, service_role;
