-- ============================================================================
-- Calileon self-hosted backend - cloud scene comments smoke (ADR 0037)
-- ----------------------------------------------------------------------------
-- Run after schema_comments.sql, as a superuser, with psql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f schema_comments_smoke.sql
--
-- Everything happens in one transaction that always rolls back: the fixture
-- accounts, scenes, shares and comments never persist. A failed check raises
-- "comments smoke FAIL: ..." and stops; the last statement prints
-- "comments smoke: PASS" only when every check before it passed.
-- ============================================================================

begin;

-- Helpers (session-temporary). Switching roles works from any current role
-- because the session user is a superuser.
create function pg_temp.cs_as(p_who text)
returns void
language plpgsql
as $$
declare
  v_sub text := case p_who
    when 'owner'    then 'c0000000-0000-4000-8000-0000000000a0'
    when 'reader'   then 'c0000000-0000-4000-8000-0000000000a1'
    when 'writer'   then 'c0000000-0000-4000-8000-0000000000a2'
    when 'outsider' then 'c0000000-0000-4000-8000-0000000000a3'
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

create function pg_temp.cs_assert(p_ok boolean, p_what text)
returns void
language plpgsql
as $$
begin
  if p_ok is not true then
    raise exception 'comments smoke FAIL: %', p_what;
  end if;
end;
$$;

-- Runs p_sql as the current role and requires it to fail with the given
-- `comments-*` code, or with "permission denied" when p_code = 'denied'.
create function pg_temp.cs_expect(p_sql text, p_code text, p_what text)
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
      raise exception 'comments smoke FAIL: % (got permission denied, want %)', p_what, p_code;
    when raise_exception then
      if sqlerrm = p_code then
        return;
      end if;
      raise exception 'comments smoke FAIL: % (got %, want %)', p_what, sqlerrm, p_code;
  end;
  raise exception 'comments smoke FAIL: % (succeeded, want %)', p_what, p_code;
end;
$$;

create function pg_temp.cs_id(p_key text)
returns uuid
language sql
as $$ select nullif(current_setting('comments_smoke.' || p_key, true), '')::uuid $$;

create function pg_temp.cs_keep(p_key text, p_id uuid)
returns void
language sql
as $$ select set_config('comments_smoke.' || p_key, p_id::text, true) $$;

-- The row with this id from a list_scene_comments() result, as the current
-- role sees it (null when absent).
create function pg_temp.cs_row(p_scene uuid, p_id uuid)
returns jsonb
language sql
as $$
  select e
  from jsonb_array_elements(public.list_scene_comments(p_scene) -> 'comments') e
  where (e ->> 'id')::uuid = p_id
$$;

-- 1) Structure ------------------------------------------------------------------
do $$
declare
  v_name text;
begin
  foreach v_name in array array[
    'scene_comments', 'scene_comment_redactions', 'scene_comment_participants'
  ] loop
    perform pg_temp.cs_assert(to_regclass('public.' || v_name) is not null, 'missing table ' || v_name);
    perform pg_temp.cs_assert(
      (select relrowsecurity from pg_class where oid = ('public.' || v_name)::regclass),
      'RLS disabled on ' || v_name
    );
  end loop;
end;
$$;

do $$
declare
  v_sig text;
  v_rpcs text[] := array[
    'join_scene_comments(uuid,text)',
    'list_scene_comments(uuid,timestamp with time zone,timestamp with time zone,integer)',
    'post_scene_comment(uuid,text,uuid)',
    'edit_scene_comment(uuid,text)',
    'set_scene_comment_status(uuid,text)',
    'delete_scene_comment(uuid,text,boolean)',
    'mark_scene_comments_seen(uuid)'
  ];
  v_internal text[] := array[
    'can_access_scene_comments(uuid,uuid)',
    'scene_comment_author_snapshot(uuid)',
    'scene_comment_to_json(scene_comments,uuid)',
    'scene_comment_clean_body(text)',
    'scene_comment_check_limits(uuid,uuid,boolean)'
  ];
begin
  foreach v_sig in array v_rpcs || array['scene_comments_visible(uuid)'] loop
    perform pg_temp.cs_assert(to_regprocedure('public.' || v_sig) is not null, 'missing function ' || v_sig);
    perform pg_temp.cs_assert(
      (select p.prosecdef and coalesce(array_to_string(p.proconfig, ',') like '%search_path=public%', false)
         from pg_proc p where p.oid = to_regprocedure('public.' || v_sig)),
      'not SECURITY DEFINER with search_path=public: ' || v_sig
    );
    perform pg_temp.cs_assert(has_function_privilege('authenticated', 'public.' || v_sig, 'execute'), 'authenticated cannot execute ' || v_sig);
    perform pg_temp.cs_assert(not has_function_privilege('anon', 'public.' || v_sig, 'execute'), 'anon can execute ' || v_sig);
  end loop;

  foreach v_sig in array v_internal loop
    perform pg_temp.cs_assert(to_regprocedure('public.' || v_sig) is not null, 'missing function ' || v_sig);
    perform pg_temp.cs_assert(not has_function_privilege('authenticated', 'public.' || v_sig, 'execute'), 'authenticated can execute internal ' || v_sig);
    perform pg_temp.cs_assert(not has_function_privilege('anon', 'public.' || v_sig, 'execute'), 'anon can execute internal ' || v_sig);
  end loop;

  -- the client cannot pass an author name: there is only the one signature
  perform pg_temp.cs_assert(
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'post_scene_comment') = 1,
    'post_scene_comment has extra overloads'
  );
end;
$$;

do $$
declare
  v_priv text;
begin
  perform pg_temp.cs_assert(has_table_privilege('authenticated', 'public.scene_comments', 'select'), 'authenticated cannot select scene_comments');
  foreach v_priv in array array['insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
    perform pg_temp.cs_assert(not has_table_privilege('authenticated', 'public.scene_comments', v_priv), 'authenticated has ' || v_priv || ' on scene_comments');
  end loop;
  foreach v_priv in array array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
    perform pg_temp.cs_assert(not has_table_privilege('anon', 'public.scene_comments', v_priv), 'anon has ' || v_priv || ' on scene_comments');
    perform pg_temp.cs_assert(not has_table_privilege('authenticated', 'public.scene_comment_redactions', v_priv), 'authenticated has ' || v_priv || ' on scene_comment_redactions');
    perform pg_temp.cs_assert(not has_table_privilege('anon', 'public.scene_comment_redactions', v_priv), 'anon has ' || v_priv || ' on scene_comment_redactions');
    perform pg_temp.cs_assert(not has_table_privilege('authenticated', 'public.scene_comment_participants', v_priv), 'authenticated has ' || v_priv || ' on scene_comment_participants');
    perform pg_temp.cs_assert(not has_table_privilege('anon', 'public.scene_comment_participants', v_priv), 'anon has ' || v_priv || ' on scene_comment_participants');
  end loop;

  -- Realtime: only the feed table, and UPDATEs never carry the old row
  perform pg_temp.cs_assert(
    exists (select 1 from pg_publication_tables
             where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'scene_comments'),
    'scene_comments is not in the supabase_realtime publication'
  );
  perform pg_temp.cs_assert(
    not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public'
                   and tablename in ('scene_comment_redactions', 'scene_comment_participants')),
    'a private comment table is published to Realtime'
  );
  perform pg_temp.cs_assert(
    (select relreplident from pg_class where oid = 'public.scene_comments'::regclass) = 'd',
    'scene_comments replica identity is not DEFAULT'
  );
end;
$$;

-- 2) Fixtures (rolled back) -------------------------------------------------------
-- owner: has a display name, an http avatar URL (must be dropped) and a circle
-- avatar; reader: https avatar URL; writer: no name (falls back to the email's
-- local part); outsider: signed in, never joins.
insert into auth.users (id, aud, role, email, encrypted_password, raw_user_meta_data, created_at, updated_at)
values
  ('c0000000-0000-4000-8000-0000000000a0', 'authenticated', 'authenticated', 'cs-owner@example.invalid', '',
   '{"full_name":"Smoke Owner","avatar_url":"http://insecure.invalid/a.png","avatar":{"color":"#1f9e8f","glyph":"S","extra":1}}', now(), now()),
  ('c0000000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'cs-reader@example.invalid', '',
   '{"name":"Smoke Reader","avatar_url":"https://example.invalid/r.png"}', now(), now()),
  ('c0000000-0000-4000-8000-0000000000a2', 'authenticated', 'authenticated', 'cs-writer@example.invalid', '',
   '{}', now(), now()),
  ('c0000000-0000-4000-8000-0000000000a3', 'authenticated', 'authenticated', 'cs-outsider@example.invalid', '',
   '{"display_name":"Smoke Outsider"}', now(), now());

insert into public.scenes (id, owner_id, title, payload_kind, payload, version)
values
  ('c0000000-0000-4000-8000-0000000000b1', 'c0000000-0000-4000-8000-0000000000a0', 'comments smoke A', 'plain',
   '{"elements":[],"appState":{}}', 1),
  ('c0000000-0000-4000-8000-0000000000b2', 'c0000000-0000-4000-8000-0000000000a0', 'comments smoke B', 'plain',
   '{"elements":[],"appState":{}}', 1),
  ('c0000000-0000-4000-8000-0000000000b3', 'c0000000-0000-4000-8000-0000000000a0', 'comments smoke E', 'encrypted',
   '{"version":1,"algorithm":"AES-GCM","iv":"x","ciphertext":"y"}', 1);

insert into public.shares (id, scene_id, owner_id, mode, token)
values
  ('c0000000-0000-4000-8000-0000000000c1', 'c0000000-0000-4000-8000-0000000000b1', 'c0000000-0000-4000-8000-0000000000a0', 'read',  'comments-smoke-read-a'),
  ('c0000000-0000-4000-8000-0000000000c2', 'c0000000-0000-4000-8000-0000000000b1', 'c0000000-0000-4000-8000-0000000000a0', 'write', 'comments-smoke-write-a'),
  ('c0000000-0000-4000-8000-0000000000c3', 'c0000000-0000-4000-8000-0000000000b2', 'c0000000-0000-4000-8000-0000000000a0', 'read',  'comments-smoke-read-b'),
  ('c0000000-0000-4000-8000-0000000000c4', 'c0000000-0000-4000-8000-0000000000b3', 'c0000000-0000-4000-8000-0000000000a0', 'read',  'comments-smoke-read-e');

-- 3) Owner joins and posts ----------------------------------------------------------
do $$
declare
  v jsonb;
begin
  perform pg_temp.cs_as('owner');
  v := public.join_scene_comments('c0000000-0000-4000-8000-0000000000b1');
  perform pg_temp.cs_assert(v ->> 'role' = 'owner', 'owner join role');
  perform pg_temp.cs_assert((v ->> 'unread_deleted')::int = 0, 'owner join unread');

  v := public.post_scene_comment('c0000000-0000-4000-8000-0000000000b1', E'  First note\n  ');
  perform pg_temp.cs_assert(v ->> 'body' = 'First note', 'body is trimmed');
  perform pg_temp.cs_assert(v ->> 'author_name' = 'Smoke Owner', 'owner name snapshot');
  perform pg_temp.cs_assert((v ->> 'is_owner_author')::boolean, 'owner badge computed by the server');
  perform pg_temp.cs_assert(
    v -> 'author_avatar' = '{"audio":{"color":"#1f9e8f","glyph":"S"}}'::jsonb,
    'avatar snapshot drops http URLs and extra keys: ' || coalesce(v ->> 'author_avatar', 'null')
  );
  perform pg_temp.cs_keep('o1', (v ->> 'id')::uuid);
end;
$$;

-- 4) A signed-in outsider gets nothing ---------------------------------------------
do $$
declare
  v_count integer;
begin
  perform pg_temp.cs_as('outsider');
  perform pg_temp.cs_expect($q$select public.join_scene_comments('c0000000-0000-4000-8000-0000000000b1')$q$,
    'comments-forbidden', 'outsider join without token');
  perform pg_temp.cs_expect($q$select public.join_scene_comments('c0000000-0000-4000-8000-0000000000b1', 'comments-smoke-read-b')$q$,
    'comments-forbidden', 'outsider join with another scene''s token');
  perform pg_temp.cs_expect($q$select public.list_scene_comments('c0000000-0000-4000-8000-0000000000b1')$q$,
    'comments-forbidden', 'outsider list');
  perform pg_temp.cs_expect($q$select public.post_scene_comment('c0000000-0000-4000-8000-0000000000b1', 'hi')$q$,
    'comments-forbidden', 'outsider post');
  perform pg_temp.cs_expect($q$select public.mark_scene_comments_seen('c0000000-0000-4000-8000-0000000000b1')$q$,
    'comments-forbidden', 'outsider mark seen');
  perform pg_temp.cs_expect(format('select public.delete_scene_comment(%L)', pg_temp.cs_id('o1')),
    'comments-forbidden', 'outsider delete');
  perform pg_temp.cs_expect(format('select public.set_scene_comment_status(%L, %L)', pg_temp.cs_id('o1'), 'resolved'),
    'comments-forbidden', 'outsider resolve');
  perform pg_temp.cs_expect($q$select public.can_access_scene_comments('c0000000-0000-4000-8000-0000000000b1', 'c0000000-0000-4000-8000-0000000000a0')$q$,
    'denied', 'internal access helper is not callable');
  perform pg_temp.cs_expect($q$select count(*) from public.scene_comment_redactions$q$,
    'denied', 'outsider reads redactions');
  perform pg_temp.cs_expect($q$select count(*) from public.scene_comment_participants$q$,
    'denied', 'outsider reads participants');

  select count(*) into v_count from public.scene_comments
  where scene_id = 'c0000000-0000-4000-8000-0000000000b1';
  perform pg_temp.cs_assert(v_count = 0, 'outsider direct select sees ' || v_count || ' rows');
end;
$$;

-- 5) Reader joins with the read link, replies, hits the limits ----------------------
do $$
declare
  v jsonb;
  v_count integer;
begin
  perform pg_temp.cs_as('reader');
  v := public.join_scene_comments('c0000000-0000-4000-8000-0000000000b1', 'comments-smoke-read-a');
  perform pg_temp.cs_assert(v ->> 'role' = 'participant', 'read link joins as participant');

  v := public.list_scene_comments('c0000000-0000-4000-8000-0000000000b1');
  perform pg_temp.cs_assert(jsonb_array_length(v -> 'comments') = 1, 'reader lists one comment');
  perform pg_temp.cs_assert((v -> 'comments' -> 0 ->> 'id')::uuid = pg_temp.cs_id('o1'), 'reader sees the owner note');
  perform pg_temp.cs_assert(not (v ->> 'has_more')::boolean, 'no older page');

  select count(*) into v_count from public.scene_comments
  where scene_id = 'c0000000-0000-4000-8000-0000000000b1';
  perform pg_temp.cs_assert(v_count = 1, 'participant direct select through RLS');

  v := public.post_scene_comment('c0000000-0000-4000-8000-0000000000b1', 'Agreed', pg_temp.cs_id('o1'));
  perform pg_temp.cs_assert(v ->> 'author_name' = 'Smoke Reader', 'reader name snapshot');
  perform pg_temp.cs_assert(not (v ->> 'is_owner_author')::boolean, 'participant is not the owner');
  perform pg_temp.cs_assert(v -> 'author_avatar' = '{"url":"https://example.invalid/r.png"}'::jsonb, 'https avatar URL kept');
  perform pg_temp.cs_assert(v -> 'quoted' ->> 'excerpt' = 'First note', 'quote excerpt');
  perform pg_temp.cs_assert(v -> 'quoted' ->> 'author_name' = 'Smoke Owner', 'quote author');
  perform pg_temp.cs_keep('r1', (v ->> 'id')::uuid);

  perform pg_temp.cs_expect($q$select public.post_scene_comment('c0000000-0000-4000-8000-0000000000b1', E' \n\t ')$q$,
    'comments-empty', 'blank body');
  perform pg_temp.cs_expect($q$select public.post_scene_comment('c0000000-0000-4000-8000-0000000000b1', repeat('x', 4001))$q$,
    'comments-too-long', '4001 characters');
  v := public.post_scene_comment('c0000000-0000-4000-8000-0000000000b1', repeat('长', 4000));
  perform pg_temp.cs_assert(char_length(v ->> 'body') = 4000, '4000 characters accepted');
  perform pg_temp.cs_keep('rLong', (v ->> 'id')::uuid);
  perform pg_temp.cs_expect($q$select public.post_scene_comment('c0000000-0000-4000-8000-0000000000b1', 'x', gen_random_uuid())$q$,
    'comments-quoted-missing', 'quote of an unknown id');

  -- no direct writes, whatever RLS would say
  perform pg_temp.cs_expect($q$insert into public.scene_comments (scene_id, owner_id, author_id, author_name, kind, body)
    values ('c0000000-0000-4000-8000-0000000000b1', 'c0000000-0000-4000-8000-0000000000a0', 'c0000000-0000-4000-8000-0000000000a0', 'Fake Owner', 'message', 'x')$q$,
    'denied', 'direct insert');
  perform pg_temp.cs_expect(format('update public.scene_comments set body = %L where id = %L', 'x', pg_temp.cs_id('o1')),
    'denied', 'direct update');
  perform pg_temp.cs_expect(format('delete from public.scene_comments where id = %L', pg_temp.cs_id('o1')),
    'denied', 'direct delete');

  -- someone else's message
  perform pg_temp.cs_expect(format('select public.edit_scene_comment(%L, %L)', pg_temp.cs_id('o1'), 'x'),
    'comments-forbidden', 'edit another author''s message');
  perform pg_temp.cs_expect(format('select public.set_scene_comment_status(%L, %L)', pg_temp.cs_id('o1'), 'resolved'),
    'comments-forbidden', 'participant resolves another author''s message');
  perform pg_temp.cs_expect(format('select public.delete_scene_comment(%L)', pg_temp.cs_id('o1')),
    'comments-forbidden', 'participant deletes another author''s message');
end;
$$;

-- 6) Writer: edit, resolve / reopen, retract --------------------------------------
do $$
declare
  v jsonb;
  v_id uuid;
  v_count integer;
begin
  perform pg_temp.cs_as('writer');
  v := public.join_scene_comments('c0000000-0000-4000-8000-0000000000b1', 'comments-smoke-write-a');
  perform pg_temp.cs_assert(v ->> 'role' = 'participant', 'write link joins as participant');

  v := public.post_scene_comment('c0000000-0000-4000-8000-0000000000b1', 'Price looks wrong');
  perform pg_temp.cs_assert(v ->> 'author_name' = 'cs-writer', 'name falls back to the email local part');
  perform pg_temp.cs_assert(v -> 'author_avatar' = 'null'::jsonb, 'no avatar snapshot');
  v_id := (v ->> 'id')::uuid;
  perform pg_temp.cs_keep('q1', v_id);

  v := public.edit_scene_comment(v_id, 'Price looks wrong: 300?');
  perform pg_temp.cs_assert(v ->> 'body' = 'Price looks wrong: 300?', 'edited body');
  perform pg_temp.cs_assert(v ->> 'edited_at' is not null, 'edited_at set');

  v := public.set_scene_comment_status(v_id, 'resolved');
  perform pg_temp.cs_assert(v ->> 'status' = 'resolved' and v ->> 'resolved_by' = 'c0000000-0000-4000-8000-0000000000a2', 'author resolves');
  v := public.set_scene_comment_status(v_id, 'resolved');
  select count(*) into v_count from public.scene_comments where target_id = v_id;
  perform pg_temp.cs_assert(v_count = 1, 'no event when the status does not change (' || v_count || ')');
  v := public.set_scene_comment_status(v_id, 'open');
  perform pg_temp.cs_assert(v ->> 'status' = 'open' and v ->> 'resolved_at' is null, 'author reopens');
  select count(*) into v_count from public.scene_comments where target_id = v_id and kind = 'event';
  perform pg_temp.cs_assert(v_count = 2, 'resolved + reopened events');
  perform pg_temp.cs_assert(
    (select event_type from public.scene_comments where target_id = v_id order by created_at desc, event_type limit 1) in ('resolved', 'reopened'),
    'event type stored'
  );
  perform pg_temp.cs_expect(format('select public.set_scene_comment_status(%L, %L)', v_id, 'done'),
    'comments-invalid', 'unknown status');
  perform pg_temp.cs_expect(format('select public.delete_scene_comment(%L, null, true)', v_id),
    'comments-forbidden', 'author cannot hide the original');

  -- under an hour, no replies: gone without a trace, events included
  perform pg_temp.cs_assert(public.delete_scene_comment(v_id) = 'retracted', 'fresh retract');
  select count(*) into v_count from public.scene_comments where id = v_id or target_id = v_id;
  perform pg_temp.cs_assert(v_count = 0, 'retract leaves ' || v_count || ' rows');

  v := public.post_scene_comment('c0000000-0000-4000-8000-0000000000b1', 'old one');
  perform pg_temp.cs_keep('qOld', (v ->> 'id')::uuid);
  v := public.post_scene_comment('c0000000-0000-4000-8000-0000000000b1', 'recent one');
  perform pg_temp.cs_keep('qRecent', (v ->> 'id')::uuid);
  v := public.post_scene_comment('c0000000-0000-4000-8000-0000000000b1', 'will get a reply');
  perform pg_temp.cs_keep('qReplied', (v ->> 'id')::uuid);
end;
$$;

-- fixtures for the one-hour boundary
do $$
begin
  perform pg_temp.cs_as('admin');
  update public.scene_comments set created_at = now() - interval '61 minutes' where id = pg_temp.cs_id('qOld');
  update public.scene_comments set created_at = now() - interval '59 minutes' where id = pg_temp.cs_id('qRecent');
end;
$$;

do $$
declare
  v jsonb;
  v_scene uuid := 'c0000000-0000-4000-8000-0000000000b1';
begin
  perform pg_temp.cs_as('writer');
  perform pg_temp.cs_assert(public.delete_scene_comment(pg_temp.cs_id('qRecent')) = 'retracted', '59 minutes: retracted');
  perform pg_temp.cs_assert(public.delete_scene_comment(pg_temp.cs_id('qOld'), '  typo  ') = 'struck', '61 minutes: struck');
  v := pg_temp.cs_row(v_scene, pg_temp.cs_id('qOld'));
  perform pg_temp.cs_assert(v ->> 'deleted_role' = 'author', 'author delete role');
  perform pg_temp.cs_assert(v ->> 'delete_reason' = 'typo', 'reason trimmed and kept');
  perform pg_temp.cs_assert(v ->> 'body' = 'old one', 'struck keeps the text');
  perform pg_temp.cs_expect(format('select public.delete_scene_comment(%L)', pg_temp.cs_id('qOld')),
    'comments-not-found', 'second delete');
  perform pg_temp.cs_expect(format('select public.edit_scene_comment(%L, %L)', pg_temp.cs_id('qOld'), 'x'),
    'comments-not-found', 'edit a deleted message');

  perform pg_temp.cs_as('reader');
  v := public.post_scene_comment(v_scene, 'a reply', pg_temp.cs_id('qReplied'));
  perform pg_temp.cs_keep('rReply', (v ->> 'id')::uuid);

  -- under an hour but answered: struck, and the reply stays
  perform pg_temp.cs_as('writer');
  perform pg_temp.cs_assert(public.delete_scene_comment(pg_temp.cs_id('qReplied')) = 'struck', 'answered message is struck');
  v := pg_temp.cs_row(v_scene, pg_temp.cs_id('rReply'));
  perform pg_temp.cs_assert(v is not null, 'reply survives');
  perform pg_temp.cs_assert((v -> 'quoted' ->> 'deleted')::boolean and v -> 'quoted' ->> 'excerpt' is null,
    'quote of a deleted message shows no text');
  perform pg_temp.cs_expect(format('select public.post_scene_comment(%L, %L, %L)', v_scene, 'x', pg_temp.cs_id('qReplied')),
    'comments-quoted-missing', 'reply to a deleted message');
end;
$$;

-- 7) Owner deletes other people's messages ------------------------------------------
do $$
begin
  perform pg_temp.cs_as('admin');
  -- the reader last looked a while ago, so the next deletions are unread
  update public.scene_comment_participants
     set last_seen_at = now() - interval '1 minute'
   where scene_id = 'c0000000-0000-4000-8000-0000000000b1'
     and user_id = 'c0000000-0000-4000-8000-0000000000a1';
end;
$$;

do $$
declare
  v jsonb;
  v_scene uuid := 'c0000000-0000-4000-8000-0000000000b1';
begin
  perform pg_temp.cs_as('owner');
  perform pg_temp.cs_assert(public.delete_scene_comment(pg_temp.cs_id('r1'), 'duplicate') = 'struck', 'owner strike');
  v := pg_temp.cs_row(v_scene, pg_temp.cs_id('r1'));
  perform pg_temp.cs_assert(v ->> 'deleted_role' = 'owner' and v ->> 'body' = 'Agreed', 'owner strike keeps the text');

  perform pg_temp.cs_assert(public.delete_scene_comment(pg_temp.cs_id('rLong'), null, true) = 'hidden', 'owner hide');
  v := pg_temp.cs_row(v_scene, pg_temp.cs_id('rLong'));
  perform pg_temp.cs_assert(v ->> 'body' is null and (v ->> 'original_hidden')::boolean, 'hidden body is null');
  perform pg_temp.cs_assert(char_length(v ->> 'original_body') = 4000, 'owner still sees the original');
  perform pg_temp.cs_assert(v ->> 'delete_reason' is null, 'no reason given');

  perform pg_temp.cs_expect(format('select public.delete_scene_comment(%L, %L)', pg_temp.cs_id('o1'), repeat('r', 501)),
    'comments-too-long', '501-character reason');

  -- the owner's own message follows the author rules (Q6): it has a reply
  perform pg_temp.cs_assert(public.delete_scene_comment(pg_temp.cs_id('o1')) = 'struck', 'owner own answered message');
  v := public.post_scene_comment(v_scene, 'owner typo');
  perform pg_temp.cs_assert(public.delete_scene_comment((v ->> 'id')::uuid) = 'retracted', 'owner own fresh message');
end;
$$;

do $$
declare
  v_body text;
  v_original text;
begin
  perform pg_temp.cs_as('admin');
  select c.body, r.original_body into v_body, v_original
  from public.scene_comments c
  left join public.scene_comment_redactions r on r.comment_id = c.id
  where c.id = pg_temp.cs_id('rLong');
  perform pg_temp.cs_assert(v_body is null and char_length(v_original) = 4000, 'original moved to redactions');
end;
$$;

-- 8) Who sees a hidden original; the unread marker ---------------------------------
do $$
declare
  v jsonb;
  v_scene uuid := 'c0000000-0000-4000-8000-0000000000b1';
begin
  perform pg_temp.cs_as('reader');
  v := public.join_scene_comments(v_scene, 'comments-smoke-read-a');
  perform pg_temp.cs_assert((v ->> 'unread_deleted')::int = 2, 'two of the reader''s messages deleted by the owner, got ' || (v ->> 'unread_deleted'));
  v := pg_temp.cs_row(v_scene, pg_temp.cs_id('rLong'));
  perform pg_temp.cs_assert(char_length(v ->> 'original_body') = 4000, 'the author sees their hidden original (Q4)');
  perform public.mark_scene_comments_seen(v_scene);
  v := public.join_scene_comments(v_scene, 'comments-smoke-read-a');
  perform pg_temp.cs_assert((v ->> 'unread_deleted')::int = 0, 'seen clears the marker');

  perform pg_temp.cs_as('writer');
  v := pg_temp.cs_row(v_scene, pg_temp.cs_id('rLong'));
  perform pg_temp.cs_assert(v ->> 'body' is null and v ->> 'original_body' is null, 'other participants never see a hidden original');
end;
$$;

-- 9) Revoked or expired links cut access at once ------------------------------------
do $$
begin
  perform pg_temp.cs_as('admin');
  update public.shares set revoked = true where id = 'c0000000-0000-4000-8000-0000000000c1';
  update public.shares set expires_at = now() - interval '1 second' where id = 'c0000000-0000-4000-8000-0000000000c2';
end;
$$;

do $$
declare
  v jsonb;
  v_count integer;
  v_scene uuid := 'c0000000-0000-4000-8000-0000000000b1';
begin
  perform pg_temp.cs_as('reader');
  perform pg_temp.cs_expect($q$select public.list_scene_comments('c0000000-0000-4000-8000-0000000000b1')$q$,
    'comments-forbidden', 'revoked link: list');
  perform pg_temp.cs_expect($q$select public.post_scene_comment('c0000000-0000-4000-8000-0000000000b1', 'still here?')$q$,
    'comments-forbidden', 'revoked link: post');
  perform pg_temp.cs_expect($q$select public.join_scene_comments('c0000000-0000-4000-8000-0000000000b1', 'comments-smoke-read-a')$q$,
    'comments-forbidden', 'revoked link: join');
  select count(*) into v_count from public.scene_comments where scene_id = v_scene;
  perform pg_temp.cs_assert(v_count = 0, 'revoked link: direct select sees ' || v_count || ' rows');

  perform pg_temp.cs_as('writer');
  perform pg_temp.cs_expect($q$select public.list_scene_comments('c0000000-0000-4000-8000-0000000000b1')$q$,
    'comments-forbidden', 'expired link: list');

  perform pg_temp.cs_as('owner');
  v := public.list_scene_comments(v_scene);
  perform pg_temp.cs_assert(jsonb_array_length(v -> 'comments') > 0, 'owner unaffected by revocation');
end;
$$;

-- a new link restores access; earlier comments were kept
do $$
begin
  perform pg_temp.cs_as('admin');
  insert into public.shares (id, scene_id, owner_id, mode, token)
  values ('c0000000-0000-4000-8000-0000000000c5', 'c0000000-0000-4000-8000-0000000000b1',
          'c0000000-0000-4000-8000-0000000000a0', 'read', 'comments-smoke-read-a2');
  perform pg_temp.cs_as('reader');
  perform public.join_scene_comments('c0000000-0000-4000-8000-0000000000b1', 'comments-smoke-read-a2');
  perform pg_temp.cs_assert(
    pg_temp.cs_row('c0000000-0000-4000-8000-0000000000b1', pg_temp.cs_id('rReply')) is not null,
    'comments kept across revocation'
  );
end;
$$;

-- 10) Encrypted and deleted scenes ----------------------------------------------------
do $$
begin
  perform pg_temp.cs_as('outsider');
  perform pg_temp.cs_expect($q$select public.join_scene_comments('c0000000-0000-4000-8000-0000000000b3', 'comments-smoke-read-e')$q$,
    'comments-unsupported', 'encrypted scene with a valid link');
  perform pg_temp.cs_expect($q$select public.join_scene_comments('c0000000-0000-4000-8000-0000000000b3')$q$,
    'comments-forbidden', 'encrypted scene without a link reveals nothing');
  perform pg_temp.cs_as('owner');
  perform pg_temp.cs_expect($q$select public.join_scene_comments('c0000000-0000-4000-8000-0000000000b3')$q$,
    'comments-unsupported', 'owner of an encrypted scene');
  perform pg_temp.cs_expect($q$select public.list_scene_comments('c0000000-0000-4000-8000-0000000000b3')$q$,
    'comments-forbidden', 'list on an encrypted scene');

  perform pg_temp.cs_as('admin');
  update public.scenes set deleted_at = now() where id = 'c0000000-0000-4000-8000-0000000000b1';
  perform pg_temp.cs_as('owner');
  perform pg_temp.cs_expect($q$select public.list_scene_comments('c0000000-0000-4000-8000-0000000000b1')$q$,
    'comments-forbidden', 'soft-deleted scene: list');
  perform pg_temp.cs_expect($q$select public.join_scene_comments('c0000000-0000-4000-8000-0000000000b1')$q$,
    'comments-forbidden', 'soft-deleted scene: join');
  perform pg_temp.cs_as('admin');
  update public.scenes set deleted_at = null where id = 'c0000000-0000-4000-8000-0000000000b1';
end;
$$;

-- 11) Quotes stay inside one scene and only point at messages ---------------------
do $$
declare
  v jsonb;
  v_event uuid;
begin
  perform pg_temp.cs_as('owner');
  v := public.post_scene_comment('c0000000-0000-4000-8000-0000000000b2', 'scene B note');
  perform pg_temp.cs_keep('b1', (v ->> 'id')::uuid);
  v := public.post_scene_comment('c0000000-0000-4000-8000-0000000000b1', 'to resolve');
  perform public.set_scene_comment_status((v ->> 'id')::uuid, 'resolved');
  select e ->> 'id' into v_event
  from jsonb_array_elements(public.list_scene_comments('c0000000-0000-4000-8000-0000000000b1') -> 'comments') e
  where e ->> 'kind' = 'event' and (e ->> 'target_id')::uuid = (v ->> 'id')::uuid;
  perform pg_temp.cs_assert(v_event is not null, 'resolve event is listed');

  perform pg_temp.cs_as('reader');
  perform pg_temp.cs_expect(format('select public.post_scene_comment(%L, %L, %L)',
      'c0000000-0000-4000-8000-0000000000b1', 'x', pg_temp.cs_id('b1')),
    'comments-quoted-missing', 'quote from another scene');
  perform pg_temp.cs_expect(format('select public.post_scene_comment(%L, %L, %L)',
      'c0000000-0000-4000-8000-0000000000b1', 'x', v_event),
    'comments-quoted-missing', 'quote of an event');
end;
$$;

-- 12) Limits -------------------------------------------------------------------------
do $$
declare
  v_posted integer := 0;
begin
  perform pg_temp.cs_as('owner');
  -- one message on scene B already counts toward this minute
  loop
    begin
      perform public.post_scene_comment('c0000000-0000-4000-8000-0000000000b2', 'flood ' || v_posted);
      v_posted := v_posted + 1;
    exception when raise_exception then
      perform pg_temp.cs_assert(sqlerrm = 'comments-rate-limited', 'flood stops with ' || sqlerrm);
      exit;
    end;
    perform pg_temp.cs_assert(v_posted <= 25, 'no rate limit after 25 posts');
  end loop;
  perform pg_temp.cs_assert(v_posted = 19, '20 per minute, got ' || (v_posted + 1));
end;
$$;

do $$
begin
  perform pg_temp.cs_as('admin');
  insert into public.scene_comments (scene_id, owner_id, author_id, author_name, kind, body, created_at)
  select 'c0000000-0000-4000-8000-0000000000b2', 'c0000000-0000-4000-8000-0000000000a0',
         'c0000000-0000-4000-8000-0000000000a3', 'filler', 'message', 'filler ' || g,
         now() - interval '2 days'
  from generate_series(1, 4980) g;

  perform pg_temp.cs_as('reader');
  perform public.join_scene_comments('c0000000-0000-4000-8000-0000000000b2', 'comments-smoke-read-b');
  perform pg_temp.cs_expect($q$select public.post_scene_comment('c0000000-0000-4000-8000-0000000000b2', 'one more')$q$,
    'comments-scene-full', '5000 messages per scene');
end;
$$;

-- 13) Anonymous visitors -----------------------------------------------------------
do $$
begin
  perform pg_temp.cs_as('anon');
  perform pg_temp.cs_expect($q$select public.join_scene_comments('c0000000-0000-4000-8000-0000000000b1', 'comments-smoke-read-a2')$q$,
    'denied', 'anon join');
  perform pg_temp.cs_expect($q$select public.list_scene_comments('c0000000-0000-4000-8000-0000000000b1')$q$,
    'denied', 'anon list');
  perform pg_temp.cs_expect($q$select count(*) from public.scene_comments$q$,
    'denied', 'anon direct select');
end;
$$;

-- 14) Deleting the scene removes everything; a quote does not block it ------------
do $$
declare
  v_left integer;
begin
  perform pg_temp.cs_as('admin');
  delete from public.scenes where id = 'c0000000-0000-4000-8000-0000000000b1';
  select (select count(*) from public.scene_comments where scene_id = 'c0000000-0000-4000-8000-0000000000b1')
       + (select count(*) from public.scene_comment_redactions where scene_id = 'c0000000-0000-4000-8000-0000000000b1')
       + (select count(*) from public.scene_comment_participants where scene_id = 'c0000000-0000-4000-8000-0000000000b1')
    into v_left;
  perform pg_temp.cs_assert(v_left = 0, 'scene delete leaves ' || v_left || ' comment rows');
end;
$$;

select 'comments smoke: PASS' as result;

rollback;
