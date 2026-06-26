-- ============================================================================
-- Excalidraw self-hosted backend - Phase 4A schema presence smoke
-- ----------------------------------------------------------------------------
-- Run after the Phase 1/2/3 schema files. This does not mutate business data.
-- It checks that the self-hosted Supabase project has the expected tables,
-- storage bucket, and token RPCs installed.
-- ============================================================================

with checks(check_name, ok, details) as (
  values
    (
      'scenes table',
      to_regclass('public.scenes') is not null,
      coalesce(to_regclass('public.scenes')::text, 'missing')
    ),
    (
      'assets table',
      to_regclass('public.assets') is not null,
      coalesce(to_regclass('public.assets')::text, 'missing')
    ),
    (
      'shares table',
      to_regclass('public.shares') is not null,
      coalesce(to_regclass('public.shares')::text, 'missing')
    ),
    (
      'activity_log table',
      to_regclass('public.activity_log') is not null,
      coalesce(to_regclass('public.activity_log')::text, 'missing')
    ),
    (
      'cast_sessions table',
      to_regclass('public.cast_sessions') is not null,
      coalesce(to_regclass('public.cast_sessions')::text, 'missing')
    ),
    (
      'cast_exports table',
      to_regclass('public.cast_exports') is not null,
      coalesce(to_regclass('public.cast_exports')::text, 'missing')
    ),
    (
      'embeds table',
      to_regclass('public.embeds') is not null,
      coalesce(to_regclass('public.embeds')::text, 'missing')
    ),
    (
      'asset bucket',
      exists (
        select 1
        from storage.buckets
        where id = 'excalidraw-assets'
          and public = false
      ),
      'excalidraw-assets private bucket'
    ),
    (
      'share load RPC',
      to_regprocedure('public.load_shared_scene(text)') is not null,
      coalesce(to_regprocedure('public.load_shared_scene(text)')::text, 'missing')
    ),
    (
      'embed load RPC',
      to_regprocedure('public.load_embedded_scene(text,text)') is not null,
      coalesce(to_regprocedure('public.load_embedded_scene(text,text)')::text, 'missing')
    )
)
select
  case
    when exists (select 1 from checks where not ok) then 'FAIL'
    else 'PASS'
  end as overall_result,
  check_name,
  case when ok then 'PASS' else 'FAIL' end as result,
  details
from checks;
