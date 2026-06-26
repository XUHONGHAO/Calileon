-- ============================================================================
-- Excalidraw self-hosted backend - Phase 4D E2E cloud storage guardrails
-- ----------------------------------------------------------------------------
-- Run after schema.sql. This keeps plaintext scenes as the default and adds
-- validation for encrypted scene payloads when clients opt in.
-- ============================================================================

alter table public.scenes
  drop constraint if exists scenes_payload_kind_check;

alter table public.scenes
  add constraint scenes_payload_kind_check
  check (payload_kind in ('plain', 'encrypted'));

alter table public.scenes
  drop constraint if exists scenes_encrypted_payload_v1_check;

alter table public.scenes
  add constraint scenes_encrypted_payload_v1_check
  check (
    payload_kind <> 'encrypted'
    or (
      jsonb_typeof(payload) = 'object'
      and payload->>'version' = '1'
      and payload ? 'algorithm'
      and payload ? 'iv'
      and payload ? 'ciphertext'
    )
  );

comment on constraint scenes_encrypted_payload_v1_check on public.scenes is
  'Encrypted scenes must use EncryptedScenePayloadV1: version, algorithm, iv, ciphertext. Keys are never stored server-side.';

update storage.buckets
   set allowed_mime_types = array(
     select distinct unnest(
       coalesce(allowed_mime_types, array[]::text[])
       || array['application/octet-stream']
     )
   )
 where id = 'excalidraw-assets';
