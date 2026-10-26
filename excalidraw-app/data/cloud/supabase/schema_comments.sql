-- ============================================================================
-- Calileon self-hosted backend - cloud scene comments (ADR 0037)
-- ----------------------------------------------------------------------------
-- Run after schema.sql, schema_shares.sql and schema_e2e_cloud.sql. This
-- script is idempotent.
--
-- Three tables:
--   scene_comments            every entry of the feed (message or event)
--   scene_comment_redactions  original text the owner chose to hide; never
--                             readable directly, only through the list RPC
--                             and only for the owner and the author
--   scene_comment_participants signed-in users who joined through a share
--                             link; access is re-checked against that share
--                             on every request, so revoking it cuts access
--
-- Clients may only SELECT scene_comments (RLS) and receive Realtime signals.
-- Every write goes through the SECURITY DEFINER RPCs below, which enforce the
-- delete rules, limits and author snapshots with server time. Nothing here is
-- granted to anon: reading comments requires a signed-in account (Q2).
-- ============================================================================

-- 1) Tables -------------------------------------------------------------------

create table if not exists public.scene_comments (
  id              uuid primary key default gen_random_uuid(),
  scene_id        uuid not null references public.scenes (id) on delete cascade,
  -- scene owner, copied for RLS and delete rules
  owner_id        uuid not null references auth.users (id) on delete cascade,
  -- null once the account is deleted; the snapshot below stays
  author_id       uuid references auth.users (id) on delete set null,
  author_name     text not null,
  author_avatar   jsonb,
  kind            text not null check (kind in ('message', 'event')),
  event_type      text check (event_type in ('resolved', 'reopened')),
  -- events follow the message they describe
  target_id       uuid references public.scene_comments (id) on delete cascade,
  -- "no action" is checked at the end of the statement, so a whole-scene
  -- cascade is not blocked, but a quoted message can never be hard-deleted
  quoted_id       uuid references public.scene_comments (id) on delete no action,
  body            text,
  status          text not null default 'open' check (status in ('open', 'resolved')),
  resolved_at     timestamptz,
  resolved_by     uuid references auth.users (id) on delete set null,
  edited_at       timestamptz,
  deleted_at      timestamptz,
  deleted_by      uuid references auth.users (id) on delete set null,
  deleted_role    text check (deleted_role in ('author', 'owner')),
  delete_reason   text,
  original_hidden boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint scene_comments_shape check (
    (kind = 'message' and event_type is null and target_id is null
      and (body is not null or original_hidden))
    or (kind = 'event' and event_type is not null and target_id is not null
      and quoted_id is null and body is null)
  )
);

create index if not exists scene_comments_scene_created_idx
  on public.scene_comments (scene_id, created_at);

create index if not exists scene_comments_scene_updated_idx
  on public.scene_comments (scene_id, updated_at);

-- rate limits count by author per scene
create index if not exists scene_comments_author_created_idx
  on public.scene_comments (scene_id, author_id, created_at);

-- reply / event lookups and the self-referencing foreign keys
create index if not exists scene_comments_quoted_idx
  on public.scene_comments (quoted_id)
  where quoted_id is not null;

create index if not exists scene_comments_target_idx
  on public.scene_comments (target_id)
  where target_id is not null;

drop trigger if exists scene_comments_touch_updated_at on public.scene_comments;

create trigger scene_comments_touch_updated_at
  before update on public.scene_comments
  for each row execute function public.touch_updated_at();

create table if not exists public.scene_comment_redactions (
  comment_id    uuid primary key references public.scene_comments (id) on delete cascade,
  scene_id      uuid not null references public.scenes (id) on delete cascade,
  owner_id      uuid not null references auth.users (id) on delete cascade,
  original_body text not null,
  created_at    timestamptz not null default now()
);

create table if not exists public.scene_comment_participants (
  scene_id     uuid not null references public.scenes (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  -- the share the user came through; null for the owner
  share_id     uuid references public.shares (id) on delete cascade,
  joined_at    timestamptz not null default now(),
  -- unread marker (C9): the user's comments deleted by someone else after this
  last_seen_at timestamptz not null default now(),
  primary key (scene_id, user_id)
);

alter table public.scene_comments enable row level security;
alter table public.scene_comment_redactions enable row level security;
alter table public.scene_comment_participants enable row level security;

-- 2) Access ------------------------------------------------------------------
-- The single access rule (ADR 0037 §2): a plain, non-deleted scene, and the
-- caller is its owner or a participant whose share is still valid now.
-- Internal: it takes any user id, so it is not executable by clients.

create or replace function public.can_access_scene_comments(
  p_scene_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_user_id is not null and exists (
    select 1
    from public.scenes s
    where s.id = p_scene_id
      and s.deleted_at is null
      and s.payload_kind = 'plain'
      and (
        s.owner_id = p_user_id
        or exists (
          select 1
          from public.scene_comment_participants p
          join public.shares sh on sh.id = p.share_id
          where p.scene_id = s.id
            and p.user_id = p_user_id
            and sh.scene_id = s.id
            and sh.revoked = false
            and (sh.expires_at is null or sh.expires_at > now())
        )
      )
  );
$$;

-- What the RLS policy (and so Realtime) calls: the same rule, but only ever
-- for the caller's own JWT subject.
create or replace function public.scene_comments_visible(p_scene_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.can_access_scene_comments(p_scene_id, auth.uid());
$$;

-- 3) Internal helpers ---------------------------------------------------------

-- Display name and avatar as they are now, read from auth.users instead of
-- the client (ADR 0037 §4). Same order as SupabaseAuthProvider: full_name,
-- name, display_name, then the part of the email before "@". The full email
-- is never stored.
create or replace function public.scene_comment_author_snapshot(
  p_user_id uuid,
  out author_name text,
  out author_avatar jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_meta jsonb;
  v_email text;
  v_url text;
  v_audio jsonb;
begin
  select coalesce(u.raw_user_meta_data, '{}'::jsonb), u.email
    into v_meta, v_email
  from auth.users u
  where u.id = p_user_id;

  author_name := left(coalesce(
    nullif(btrim(case when jsonb_typeof(v_meta -> 'full_name') = 'string'
      then v_meta ->> 'full_name' end), ''),
    nullif(btrim(case when jsonb_typeof(v_meta -> 'name') = 'string'
      then v_meta ->> 'name' end), ''),
    nullif(btrim(case when jsonb_typeof(v_meta -> 'display_name') = 'string'
      then v_meta ->> 'display_name' end), ''),
    nullif(btrim(split_part(coalesce(v_email, ''), '@', 1)), ''),
    ''
  ), 100);

  if jsonb_typeof(v_meta -> 'avatar_url') = 'string' then
    v_url := btrim(v_meta ->> 'avatar_url');
    if v_url !~* '^https://' or char_length(v_url) > 2048 then
      v_url := null;
    end if;
  end if;

  -- ADR 0034 circle avatar: shape check only; the client validates the
  -- palette and glyph again when it reads the snapshot
  if jsonb_typeof(v_meta -> 'avatar') = 'object'
     and (v_meta -> 'avatar' ->> 'color') ~ '^#[0-9a-fA-F]{6}$'
     and char_length(v_meta -> 'avatar' ->> 'glyph') = 1
  then
    v_audio := jsonb_build_object(
      'color', v_meta -> 'avatar' ->> 'color',
      'glyph', v_meta -> 'avatar' ->> 'glyph'
    );
  end if;

  author_avatar := nullif(
    jsonb_strip_nulls(jsonb_build_object('url', v_url, 'audio', v_audio)),
    '{}'::jsonb
  );
end;
$$;

-- The one row shape every RPC returns. Hidden originals come back only for
-- the scene owner and the comment's author (Q4); the "owner" badge is computed
-- here, never taken from the snapshot name (§10).
create or replace function public.scene_comment_to_json(
  c public.scene_comments,
  p_viewer uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', c.id,
    'scene_id', c.scene_id,
    'author_id', c.author_id,
    'author_name', c.author_name,
    'author_avatar', c.author_avatar,
    'is_owner_author', c.author_id is not null and c.author_id = c.owner_id,
    'kind', c.kind,
    'event_type', c.event_type,
    'target_id', c.target_id,
    'quoted_id', c.quoted_id,
    'body', case when c.original_hidden then null else c.body end,
    'original_hidden', c.original_hidden,
    'original_body', case
      when c.original_hidden
        and p_viewer is not null
        and (p_viewer = c.owner_id or p_viewer = c.author_id)
      then (select r.original_body
              from public.scene_comment_redactions r
             where r.comment_id = c.id)
    end,
    'status', c.status,
    'resolved_at', c.resolved_at,
    'resolved_by', c.resolved_by,
    'edited_at', c.edited_at,
    'deleted_at', c.deleted_at,
    'deleted_role', c.deleted_role,
    'delete_reason', c.delete_reason,
    'created_at', c.created_at,
    'updated_at', c.updated_at,
    'quoted', case when c.quoted_id is not null then (
      select jsonb_build_object(
        'author_name', q.author_name,
        'created_at', q.created_at,
        'deleted', q.deleted_at is not null,
        -- a deleted or hidden quote never shows its text (§9.2)
        'excerpt', case
          when q.deleted_at is null and not q.original_hidden
          then left(regexp_replace(btrim(q.body), '\s+', ' ', 'g'), 60)
        end
      )
      from public.scene_comments q
      where q.id = c.quoted_id
    ) end
  );
$$;

-- Plain text only, trimmed, 1–4000 characters (§7). NUL bytes never reach
-- here: PostgreSQL text cannot hold them and PostgREST rejects the request.
create or replace function public.scene_comment_clean_body(p_body text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_body text := regexp_replace(coalesce(p_body, ''), '^\s+|\s+$', '', 'g');
begin
  if v_body = '' then
    raise exception 'comments-empty';
  end if;
  if char_length(v_body) > 4000 then
    raise exception 'comments-too-long';
  end if;
  return v_body;
end;
$$;

-- Per user per scene: 20 a minute, 500 a day (messages and events together);
-- at most 5000 messages per scene. Counted by server time (§7).
create or replace function public.scene_comment_check_limits(
  p_scene_id uuid,
  p_user_id uuid,
  p_is_message boolean
)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if (
    select count(*)
    from public.scene_comments c
    where c.scene_id = p_scene_id
      and c.author_id = p_user_id
      and c.created_at > now() - interval '1 minute'
  ) >= 20 or (
    select count(*)
    from public.scene_comments c
    where c.scene_id = p_scene_id
      and c.author_id = p_user_id
      and c.created_at > now() - interval '1 day'
  ) >= 500 then
    raise exception 'comments-rate-limited';
  end if;

  if p_is_message and (
    select count(*)
    from public.scene_comments c
    where c.scene_id = p_scene_id
      and c.kind = 'message'
  ) >= 5000 then
    raise exception 'comments-scene-full';
  end if;
end;
$$;

-- 4) RPCs ---------------------------------------------------------------------
-- All SECURITY DEFINER, authenticated only. Errors are `comments-<code>`,
-- mapped to localized text by the client (errorMapping.ts).

-- Enter a scene's comments. The owner needs no token; anyone else needs a
-- valid share token for this very scene. Returns the previous last_seen_at
-- and how many of the caller's own comments someone else deleted since then.
create or replace function public.join_scene_comments(
  p_scene_id uuid,
  p_token text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_owner_id uuid;
  v_payload_kind text;
  v_share_id uuid;
  v_role text;
  v_last_seen timestamptz;
begin
  if v_uid is null then
    raise exception 'comments-unauthorized';
  end if;

  select s.owner_id, s.payload_kind
    into v_owner_id, v_payload_kind
  from public.scenes s
  where s.id = p_scene_id
    and s.deleted_at is null;

  if v_owner_id is null then
    raise exception 'comments-forbidden';
  end if;

  if v_owner_id = v_uid then
    v_role := 'owner';
  else
    select sh.id
      into v_share_id
    from public.shares sh
    where sh.token = p_token
      and sh.scene_id = p_scene_id
      and sh.revoked = false
      and (sh.expires_at is null or sh.expires_at > now())
    limit 1;

    if v_share_id is null then
      raise exception 'comments-forbidden';
    end if;
    v_role := 'participant';
  end if;

  -- checked after the token so the answer does not reveal the scene's kind
  if v_payload_kind <> 'plain' then
    raise exception 'comments-unsupported';
  end if;

  insert into public.scene_comment_participants (scene_id, user_id, share_id)
  values (p_scene_id, v_uid, v_share_id)
  on conflict (scene_id, user_id) do update
    set share_id = excluded.share_id
  returning last_seen_at into v_last_seen;

  return jsonb_build_object(
    'role', v_role,
    'owner_id', v_owner_id,
    'last_seen_at', v_last_seen,
    'unread_deleted', (
      select count(*)
      from public.scene_comments c
      where c.scene_id = p_scene_id
        and c.kind = 'message'
        and c.author_id = v_uid
        and c.deleted_by is distinct from v_uid
        and c.deleted_at > v_last_seen
    ),
    'server_time', now()
  );
end;
$$;

-- Read the feed. Three modes:
--   p_since   rows changed after this time (incremental, oldest change first)
--   p_before  the page of messages created before this time (older history)
--   neither   the latest page
-- Pages are at most 200 rows. `has_more` says whether another page exists.
create or replace function public.list_scene_comments(
  p_scene_id uuid,
  p_since timestamptz default null,
  p_before timestamptz default null,
  p_limit integer default 200
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 200);
  v_ids uuid[];
  v_oldest timestamptz;
  v_has_more boolean;
begin
  if v_uid is null then
    raise exception 'comments-unauthorized';
  end if;
  if not public.can_access_scene_comments(p_scene_id, v_uid) then
    raise exception 'comments-forbidden';
  end if;

  if p_since is not null then
    select array_agg(x.id order by x.updated_at, x.id)
      into v_ids
    from (
      select c.id, c.updated_at
      from public.scene_comments c
      where c.scene_id = p_scene_id
        and c.updated_at > p_since
      order by c.updated_at, c.id
      limit v_limit
    ) x;
    v_has_more := coalesce(array_length(v_ids, 1), 0) >= v_limit;
  else
    select array_agg(x.id order by x.created_at, x.id), min(x.created_at)
      into v_ids, v_oldest
    from (
      select c.id, c.created_at
      from public.scene_comments c
      where c.scene_id = p_scene_id
        and (p_before is null or c.created_at < p_before)
      order by c.created_at desc, c.id desc
      limit v_limit
    ) x;
    v_has_more := v_oldest is not null and exists (
      select 1
      from public.scene_comments c
      where c.scene_id = p_scene_id
        and c.created_at < v_oldest
    );
  end if;

  return jsonb_build_object(
    'comments', coalesce((
      select jsonb_agg(public.scene_comment_to_json(c, v_uid)
                       order by array_position(v_ids, c.id))
      from public.scene_comments c
      where c.id = any(coalesce(v_ids, '{}'::uuid[]))
    ), '[]'::jsonb),
    'has_more', coalesce(v_has_more, false),
    'server_time', now()
  );
end;
$$;

-- Post a message, or a reply when p_quoted_id is set (one level, D3). The
-- author snapshot comes from auth.users; the client cannot pass a name.
create or replace function public.post_scene_comment(
  p_scene_id uuid,
  p_body text,
  p_quoted_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_owner_id uuid;
  v_body text;
  v_author record;
  v_row public.scene_comments;
begin
  if v_uid is null then
    raise exception 'comments-unauthorized';
  end if;
  if not public.can_access_scene_comments(p_scene_id, v_uid) then
    raise exception 'comments-forbidden';
  end if;

  v_body := public.scene_comment_clean_body(p_body);

  if p_quoted_id is not null and not exists (
    select 1
    from public.scene_comments q
    where q.id = p_quoted_id
      and q.scene_id = p_scene_id
      and q.kind = 'message'
      and q.deleted_at is null
  ) then
    raise exception 'comments-quoted-missing';
  end if;

  perform public.scene_comment_check_limits(p_scene_id, v_uid, true);

  select s.owner_id into v_owner_id
  from public.scenes s
  where s.id = p_scene_id;

  select * into v_author
  from public.scene_comment_author_snapshot(v_uid);

  begin
    insert into public.scene_comments (
      scene_id, owner_id, author_id, author_name, author_avatar,
      kind, quoted_id, body
    )
    values (
      p_scene_id, v_owner_id, v_uid, v_author.author_name,
      v_author.author_avatar, 'message', p_quoted_id, v_body
    )
    returning * into v_row;
  exception when foreign_key_violation then
    -- the quoted message was retracted while this reply was being sent
    raise exception 'comments-quoted-missing';
  end;

  return public.scene_comment_to_json(v_row, v_uid);
end;
$$;

-- Edit one's own message. Only "edited at" is kept, no history (C14).
create or replace function public.edit_scene_comment(
  p_id uuid,
  p_body text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.scene_comments;
  v_body text;
begin
  if v_uid is null then
    raise exception 'comments-unauthorized';
  end if;

  select * into v_row
  from public.scene_comments c
  where c.id = p_id
  for update;

  if v_row.id is null then
    raise exception 'comments-not-found';
  end if;
  if not public.can_access_scene_comments(v_row.scene_id, v_uid) then
    raise exception 'comments-forbidden';
  end if;
  if v_row.kind <> 'message' or v_row.deleted_at is not null then
    raise exception 'comments-not-found';
  end if;
  if v_row.author_id is distinct from v_uid then
    raise exception 'comments-forbidden';
  end if;

  v_body := public.scene_comment_clean_body(p_body);

  if v_body is distinct from v_row.body then
    update public.scene_comments c
       set body = v_body,
           edited_at = now()
     where c.id = p_id
    returning * into v_row;
  end if;

  return public.scene_comment_to_json(v_row, v_uid);
end;
$$;

-- Resolve / reopen. Allowed for the scene owner and the message's author
-- (Q3). A real change also adds an event entry to the feed (D3).
create or replace function public.set_scene_comment_status(
  p_id uuid,
  p_status text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.scene_comments;
  v_author record;
begin
  if v_uid is null then
    raise exception 'comments-unauthorized';
  end if;
  if p_status is null or p_status not in ('open', 'resolved') then
    raise exception 'comments-invalid';
  end if;

  select * into v_row
  from public.scene_comments c
  where c.id = p_id
  for update;

  if v_row.id is null then
    raise exception 'comments-not-found';
  end if;
  if not public.can_access_scene_comments(v_row.scene_id, v_uid) then
    raise exception 'comments-forbidden';
  end if;
  if v_row.kind <> 'message' or v_row.deleted_at is not null then
    raise exception 'comments-not-found';
  end if;
  if v_uid <> v_row.owner_id and v_row.author_id is distinct from v_uid then
    raise exception 'comments-forbidden';
  end if;

  if v_row.status = p_status then
    return public.scene_comment_to_json(v_row, v_uid);
  end if;

  perform public.scene_comment_check_limits(v_row.scene_id, v_uid, false);

  update public.scene_comments c
     set status = p_status,
         resolved_at = case when p_status = 'resolved' then now() end,
         resolved_by = case when p_status = 'resolved' then v_uid end
   where c.id = p_id
  returning * into v_row;

  select * into v_author
  from public.scene_comment_author_snapshot(v_uid);

  insert into public.scene_comments (
    scene_id, owner_id, author_id, author_name, author_avatar,
    kind, event_type, target_id
  )
  values (
    v_row.scene_id, v_row.owner_id, v_uid, v_author.author_name,
    v_author.author_avatar, 'event',
    case when p_status = 'resolved' then 'resolved' else 'reopened' end,
    v_row.id
  );

  return public.scene_comment_to_json(v_row, v_uid);
end;
$$;

-- Delete (ADR 0037 §5, technical design §6). Returns:
--   'retracted'  the author's own message, under 1 hour old and unanswered:
--                the row (and its events) is gone, nothing is kept (D2)
--   'struck'     soft delete: strike-through, optional reason
--   'hidden'     owner deleting someone else's message with "also hide the
--                original": the text moves to scene_comment_redactions (D1)
create or replace function public.delete_scene_comment(
  p_id uuid,
  p_reason text default null,
  p_hide_original boolean default false
)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.scene_comments;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_has_replies boolean;
begin
  if v_uid is null then
    raise exception 'comments-unauthorized';
  end if;
  if v_reason is not null and char_length(v_reason) > 500 then
    raise exception 'comments-too-long';
  end if;

  -- the lock conflicts with the key-share lock a concurrent reply takes on
  -- its quoted row, so "has replies" cannot change underneath us
  select * into v_row
  from public.scene_comments c
  where c.id = p_id
  for update;

  if v_row.id is null then
    raise exception 'comments-not-found';
  end if;
  if not public.can_access_scene_comments(v_row.scene_id, v_uid) then
    raise exception 'comments-forbidden';
  end if;
  if v_row.kind <> 'message' or v_row.deleted_at is not null then
    raise exception 'comments-not-found';
  end if;

  select exists (
    select 1
    from public.scene_comments r
    where r.quoted_id = v_row.id
      and r.kind = 'message'
  ) into v_has_replies;

  if v_row.author_id = v_uid then
    if coalesce(p_hide_original, false) then
      raise exception 'comments-forbidden';
    end if;
    if now() - v_row.created_at < interval '1 hour' and not v_has_replies then
      delete from public.scene_comments c where c.id = v_row.id;
      return 'retracted';
    end if;
    update public.scene_comments c
       set deleted_at = now(),
           deleted_by = v_uid,
           deleted_role = 'author',
           delete_reason = v_reason
     where c.id = v_row.id;
    return 'struck';
  end if;

  if v_row.owner_id = v_uid then
    if coalesce(p_hide_original, false) then
      insert into public.scene_comment_redactions (
        comment_id, scene_id, owner_id, original_body
      )
      values (v_row.id, v_row.scene_id, v_row.owner_id, v_row.body)
      on conflict (comment_id) do update
        set original_body = excluded.original_body;

      update public.scene_comments c
         set deleted_at = now(),
             deleted_by = v_uid,
             deleted_role = 'owner',
             delete_reason = v_reason,
             body = null,
             original_hidden = true
       where c.id = v_row.id;
      return 'hidden';
    end if;

    update public.scene_comments c
       set deleted_at = now(),
           deleted_by = v_uid,
           deleted_role = 'owner',
           delete_reason = v_reason
     where c.id = v_row.id;
    return 'struck';
  end if;

  raise exception 'comments-forbidden';
end;
$$;

-- Opening the comments tab clears the unread marker (C9).
create or replace function public.mark_scene_comments_seen(p_scene_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_seen timestamptz;
begin
  if v_uid is null then
    raise exception 'comments-unauthorized';
  end if;
  if not public.can_access_scene_comments(p_scene_id, v_uid) then
    raise exception 'comments-forbidden';
  end if;

  -- participants always have a row; the owner may not have joined yet
  insert into public.scene_comment_participants (scene_id, user_id, share_id)
  values (p_scene_id, v_uid, null)
  on conflict (scene_id, user_id) do update
    set last_seen_at = now()
  returning last_seen_at into v_seen;

  return v_seen;
end;
$$;

-- 5) RLS policy and privileges ----------------------------------------------

drop policy if exists "comment readers can read scene comments" on public.scene_comments;

create policy "comment readers can read scene comments"
  on public.scene_comments for select
  to authenticated
  using (public.scene_comments_visible(scene_id));

-- The deployment grants table privileges to anon/authenticated by default and
-- relies on RLS; these tables are stricter. Readers only SELECT the feed; the
-- other two tables are reachable through the RPCs alone.
revoke all on table public.scene_comments from public, anon, authenticated;
revoke all on table public.scene_comment_redactions from public, anon, authenticated;
revoke all on table public.scene_comment_participants from public, anon, authenticated;
grant select on table public.scene_comments to authenticated;

-- Internal helpers: callable from the RPCs (same owner), never by clients.
revoke execute on function public.can_access_scene_comments(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.scene_comment_author_snapshot(uuid) from public, anon, authenticated;
revoke execute on function public.scene_comment_to_json(public.scene_comments, uuid) from public, anon, authenticated;
revoke execute on function public.scene_comment_clean_body(text) from public, anon, authenticated;
revoke execute on function public.scene_comment_check_limits(uuid, uuid, boolean) from public, anon, authenticated;

-- The policy runs as the reader, so the reader needs this one.
revoke execute on function public.scene_comments_visible(uuid) from public, anon;
grant execute on function public.scene_comments_visible(uuid) to authenticated;

revoke execute on function public.join_scene_comments(uuid, text) from public, anon;
revoke execute on function public.list_scene_comments(uuid, timestamptz, timestamptz, integer) from public, anon;
revoke execute on function public.post_scene_comment(uuid, text, uuid) from public, anon;
revoke execute on function public.edit_scene_comment(uuid, text) from public, anon;
revoke execute on function public.set_scene_comment_status(uuid, text) from public, anon;
revoke execute on function public.delete_scene_comment(uuid, text, boolean) from public, anon;
revoke execute on function public.mark_scene_comments_seen(uuid) from public, anon;

grant execute on function public.join_scene_comments(uuid, text) to authenticated;
grant execute on function public.list_scene_comments(uuid, timestamptz, timestamptz, integer) to authenticated;
grant execute on function public.post_scene_comment(uuid, text, uuid) to authenticated;
grant execute on function public.edit_scene_comment(uuid, text) to authenticated;
grant execute on function public.set_scene_comment_status(uuid, text) to authenticated;
grant execute on function public.delete_scene_comment(uuid, text, boolean) to authenticated;
grant execute on function public.mark_scene_comments_seen(uuid) to authenticated;

-- 6) Realtime -----------------------------------------------------------------
-- Only scene_comments is published, and clients treat each change as a "pull
-- now" signal (ADR 0037 §6). Realtime checks the reader's JWT against the
-- policy above for INSERT/UPDATE. Replica identity stays DEFAULT so an UPDATE
-- never carries the previous row (and with it a just-hidden original).
alter table public.scene_comments replica identity default;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime publication not found: comments fall back to polling';
  elsif exists (
    select 1 from pg_publication
    where pubname = 'supabase_realtime' and puballtables
  ) then
    raise notice 'supabase_realtime publishes all tables; scene_comments is included';
  elsif not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'scene_comments'
  ) then
    alter publication supabase_realtime add table public.scene_comments;
  end if;
end;
$$;
