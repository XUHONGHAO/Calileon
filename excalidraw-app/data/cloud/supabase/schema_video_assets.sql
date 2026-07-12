-- AI video asset hardening (P1-08).
-- Run after schema_assets.sql. Idempotent.

update storage.buckets
set
  file_size_limit = 104857600,
  allowed_mime_types = array[
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'image/svg+xml',
    'application/json',
    'video/mp4',
    'video/webm'
  ]
where id = 'excalidraw-assets';

create index if not exists assets_ai_video_scene_idx
  on public.assets (scene_id, created_at)
  where deleted_at is null and type = 'ai-video-output';

comment on index public.assets_ai_video_scene_idx is
  'AI video outputs are addressed by stable assets.id; provider source URLs are never stored.';
