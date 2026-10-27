-- ============================================================================
-- Calileon self-hosted backend - account AI settings smoke (ADR 0038)
-- ----------------------------------------------------------------------------
-- Run after schema_account_settings.sql, as a superuser, with psql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f schema_account_settings_smoke.sql
--
-- One transaction that always rolls back, so the fixture accounts and rows
-- never persist. A failed check raises "account settings smoke FAIL: ...";
-- the last statement prints "account settings smoke: PASS".
-- ============================================================================

begin;

create function pg_temp.as_as(p_who text)
returns void
language plpgsql
as $$
declare
  v_sub text := case p_who
    when 'alice' then 'd0000000-0000-4000-8000-0000000000a0'
    when 'bob'   then 'd0000000-0000-4000-8000-0000000000a1'
    else ''
  end;
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claim.sub', v_sub, true);
  perform set_config(
    'request.jwt.claims',
    case when v_sub = '' then '' else json_build_object('sub', v_sub, 'role', 'authenticated')::text end,
    true
  );
  if p_who = 'anon' then
    perform set_config('role', 'anon', true);
  elsif p_who <> 'admin' then
    perform set_config('role', 'authenticated', true);
  end if;
end;
$$;

create function pg_temp.as_assert(p_ok boolean, p_what text)
returns void
language plpgsql
as $$
begin
  if p_ok is not true then
    raise exception 'account settings smoke FAIL: %', p_what;
  end if;
end;
$$;

-- Requires p_sql to fail: with "permission denied" / an RLS check when
-- p_code = 'denied', otherwise with the given raised message.
create function pg_temp.as_expect(p_sql text, p_code text, p_what text)
returns void
language plpgsql
as $$
begin
  begin
    execute p_sql;
  exception
    when insufficient_privilege then
      if p_code = 'denied' then
        return;
      end if;
      raise exception 'account settings smoke FAIL: % (got permission denied, want %)', p_what, p_code;
    when raise_exception then
      if sqlerrm = p_code then
        return;
      end if;
      raise exception 'account settings smoke FAIL: % (got %, want %)', p_what, sqlerrm, p_code;
    when check_violation then
      if p_code = 'check' then
        return;
      end if;
      raise exception 'account settings smoke FAIL: % (got check violation, want %)', p_what, p_code;
  end;
  raise exception 'account settings smoke FAIL: % (succeeded, want %)', p_what, p_code;
end;
$$;

insert into auth.users (id, aud, role, email, encrypted_password, raw_user_meta_data, created_at, updated_at)
values
  ('d0000000-0000-4000-8000-0000000000a0', 'authenticated', 'authenticated', 'as-alice@example.invalid', '', '{}', now(), now()),
  ('d0000000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'as-bob@example.invalid', '', '{}', now(), now());

-- 1) Owner inserts revision 1, reads it back ----------------------------------
do $$
declare
  v_count integer;
begin
  perform pg_temp.as_as('alice');
  insert into public.account_ai_settings (owner_id, format_version, kdf, iv, ciphertext)
  values ('d0000000-0000-4000-8000-0000000000a0', 1,
          '{"name":"PBKDF2","hash":"SHA-256","iterations":600000,"salt":"c2FsdHNhbHRzYWx0c2FsdA=="}',
          'aXZpdml2aXZpdml2', 'Y2lwaGVydGV4dA==');
  select count(*) into v_count from public.account_ai_settings;
  perform pg_temp.as_assert(v_count = 1, 'owner sees ' || v_count || ' rows, want 1');
end;
$$;

-- 2) Insert rules: own row only, revision starts at 1, one row per account ----
do $$
begin
  perform pg_temp.as_as('bob');
  perform pg_temp.as_expect($q$insert into public.account_ai_settings (owner_id, format_version, kdf, iv, ciphertext)
    values ('d0000000-0000-4000-8000-0000000000a0', 1, '{}', 'aXZpdml2aXZpdml2', 'eA==')$q$,
    'denied', 'insert for another account');
  perform pg_temp.as_expect($q$insert into public.account_ai_settings (owner_id, format_version, kdf, iv, ciphertext, revision)
    values ('d0000000-0000-4000-8000-0000000000a1', 1, '{}', 'aXZpdml2aXZpdml2', 'eA==', 5)$q$,
    'denied', 'insert with revision 5');
  perform pg_temp.as_expect($q$insert into public.account_ai_settings (owner_id, format_version, kdf, iv, ciphertext)
    values ('d0000000-0000-4000-8000-0000000000a1', 2, '{}', 'aXZpdml2aXZpdml2', 'eA==')$q$,
    'check', 'insert with an unknown format version');
end;
$$;

-- 3) Other accounts can't read, change or delete the row ----------------------
do $$
declare
  v_count integer;
begin
  perform pg_temp.as_as('bob');
  select count(*) into v_count from public.account_ai_settings;
  perform pg_temp.as_assert(v_count = 0, 'other account sees ' || v_count || ' rows');
  update public.account_ai_settings set ciphertext = 'eA==', revision = revision + 1;
  get diagnostics v_count = row_count;
  perform pg_temp.as_assert(v_count = 0, 'other account updated ' || v_count || ' rows');
  delete from public.account_ai_settings;
  get diagnostics v_count = row_count;
  perform pg_temp.as_assert(v_count = 0, 'other account deleted ' || v_count || ' rows');
end;
$$;

-- 4) Revision must advance by exactly one; a stale writer matches no row ------
do $$
declare
  v_count integer;
  v_revision bigint;
begin
  perform pg_temp.as_as('alice');
  update public.account_ai_settings set ciphertext = 'djI=', revision = 2 where revision = 1;
  get diagnostics v_count = row_count;
  perform pg_temp.as_assert(v_count = 1, 'next-revision update matched ' || v_count || ' rows');

  update public.account_ai_settings set ciphertext = 'c3RhbGU=', revision = 2 where revision = 1;
  get diagnostics v_count = row_count;
  perform pg_temp.as_assert(v_count = 0, 'stale update matched ' || v_count || ' rows');

  perform pg_temp.as_expect($q$update public.account_ai_settings set revision = 9$q$,
    'account-settings-revision-step', 'revision jump');
  perform pg_temp.as_expect($q$update public.account_ai_settings set ciphertext = 'eA=='$q$,
    'account-settings-revision-step', 'update without a revision bump');
  perform pg_temp.as_expect($q$update public.account_ai_settings
    set owner_id = 'd0000000-0000-4000-8000-0000000000a1', revision = revision + 1$q$,
    'account-settings-owner-immutable', 'moving the row to another account');

  select revision into v_revision from public.account_ai_settings;
  perform pg_temp.as_assert(v_revision = 2, 'revision is ' || v_revision || ', want 2');
end;
$$;

-- 5) Anonymous callers have no access at all ----------------------------------
do $$
begin
  perform pg_temp.as_as('anon');
  perform pg_temp.as_expect($q$select count(*) from public.account_ai_settings$q$,
    'denied', 'anon select');
end;
$$;

-- 6) Owner deletes; deleting the account cascades ------------------------------
do $$
declare
  v_count integer;
begin
  perform pg_temp.as_as('alice');
  delete from public.account_ai_settings;
  get diagnostics v_count = row_count;
  perform pg_temp.as_assert(v_count = 1, 'owner deleted ' || v_count || ' rows');

  insert into public.account_ai_settings (owner_id, format_version, kdf, iv, ciphertext)
  values ('d0000000-0000-4000-8000-0000000000a0', 1, '{}', 'aXZpdml2aXZpdml2', 'eA==');

  perform pg_temp.as_as('admin');
  delete from auth.users where id = 'd0000000-0000-4000-8000-0000000000a0';
  select count(*) into v_count from public.account_ai_settings
    where owner_id = 'd0000000-0000-4000-8000-0000000000a0';
  perform pg_temp.as_assert(v_count = 0, 'account delete leaves ' || v_count || ' rows');
end;
$$;

select 'account settings smoke: PASS' as result;

rollback;
