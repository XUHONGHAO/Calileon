-- AI video asset hardening (P1-08).
-- Run after schema_assets.sql. Idempotent.

-- Append, never replace: schema_assets.sql runs first and sets the full list
-- (including audio, ADR 0034); replacing it here dropped those types.
update storage.buckets
set
  file_size_limit = 104857600,
  allowed_mime_types = array(
    select distinct unnest(
      coalesce(allowed_mime_types, array[]::text[])
      || array[
        'image/png',
        'image/jpeg',
        'image/webp',
        'image/gif',
        'image/svg+xml',
        'application/json',
        'video/mp4',
        'video/webm'
      ]
    )
  )
where id = 'excalidraw-assets';

create index if not exists assets_ai_video_scene_idx
  on public.assets (scene_id, created_at)
  where deleted_at is null and type = 'ai-video-output';

comment on index public.assets_ai_video_scene_idx is
  'AI video outputs are addressed by stable assets.id; provider source URLs are never stored.';
