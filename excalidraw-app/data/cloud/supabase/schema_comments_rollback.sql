-- ============================================================================
-- Calileon self-hosted backend - cloud scene comments ROLLBACK (ADR 0037)
-- ----------------------------------------------------------------------------
-- DESTRUCTIVE: drops the three comment tables, their functions and the
-- Realtime publication entry. Every comment, hidden original and unread
-- marker is lost.
--
-- Turning comments off does not need this: set VITE_APP_SCENE_COMMENTS=false
-- and rebuild the App; the tables can stay. Run this only after the owner has
-- explicitly agreed to delete the comment data (ADR 0037 §10).
--
-- Through compose it is guarded: the rollback-comments-schema service refuses
-- unless ALLOW_COMMENTS_SCHEMA_ROLLBACK=YES.
-- ============================================================================

begin;

do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'scene_comments'
  ) and not exists (
    select 1 from pg_publication
    where pubname = 'supabase_realtime' and puballtables
  ) then
    alter publication supabase_realtime drop table public.scene_comments;
  end if;
end;
$$;

drop function if exists public.mark_scene_comments_seen(uuid);
drop function if exists public.delete_scene_comment(uuid, text, boolean);
drop function if exists public.set_scene_comment_status(uuid, text);
drop function if exists public.edit_scene_comment(uuid, text);
drop function if exists public.post_scene_comment(uuid, text, uuid);
drop function if exists public.list_scene_comments(uuid, timestamptz, timestamptz, integer);
drop function if exists public.join_scene_comments(uuid, text);
drop function if exists public.scene_comment_check_limits(uuid, uuid, boolean);
drop function if exists public.scene_comment_clean_body(text);
drop function if exists public.scene_comment_author_snapshot(uuid);
-- takes the table's row type, so it goes before the table
do $$
begin
  if to_regclass('public.scene_comments') is not null then
    drop function if exists public.scene_comment_to_json(public.scene_comments, uuid);
  end if;
end;
$$;

drop table if exists public.scene_comment_participants;
drop table if exists public.scene_comment_redactions;
drop table if exists public.scene_comments;
-- used by the policy on scene_comments, so it goes after the table
drop function if exists public.scene_comments_visible(uuid);
drop function if exists public.can_access_scene_comments(uuid, uuid);

commit;
