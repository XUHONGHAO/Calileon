create schema if not exists ai_gateway;

create table if not exists ai_gateway.schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists ai_gateway.credentials (
  id text primary key,
  envelope jsonb not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ai_gateway.policy_assignments (
  issuer text not null,
  subject text not null,
  policy_id text not null,
  updated_at timestamptz not null default now(),
  primary key (issuer, subject)
);

create table if not exists ai_gateway.usage_buckets (
  issuer text not null,
  subject text not null,
  period_kind text not null check (period_kind in ('day', 'month')),
  period_start date not null,
  used_units bigint not null default 0 check (used_units >= 0),
  updated_at timestamptz not null default now(),
  primary key (issuer, subject, period_kind, period_start)
);

create table if not exists ai_gateway.requests (
  request_id text primary key,
  issuer text not null,
  subject text not null,
  route_id text not null,
  operation text not null,
  cost_units integer not null check (cost_units > 0),
  status text not null check (
    status in ('reserved', 'running', 'succeeded', 'failed', 'aborted', 'released')
  ),
  provider_attempts integer not null default 0,
  response_bytes bigint not null default 0,
  duration_ms bigint not null default 0,
  error_code text,
  lease_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists requests_identity_created_idx
  on ai_gateway.requests (issuer, subject, created_at desc);
create index if not exists requests_active_idx
  on ai_gateway.requests (issuer, subject, status, lease_expires_at);

create table if not exists ai_gateway.audit_consents (
  issuer text not null,
  subject text not null,
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (issuer, subject)
);

create table if not exists ai_gateway.audit_records (
  id uuid primary key,
  issuer text not null,
  subject text not null,
  request_id text references ai_gateway.requests (request_id) on delete set null,
  route_id text not null,
  content_bytes bigint not null check (content_bytes >= 0),
  envelope jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  deleted_at timestamptz
);

create index if not exists audit_records_identity_created_idx
  on ai_gateway.audit_records (issuer, subject, created_at desc)
  where deleted_at is null;
create index if not exists audit_records_expiry_idx
  on ai_gateway.audit_records (expires_at)
  where deleted_at is null;

create table if not exists ai_gateway.audit_access_events (
  id bigserial primary key,
  audit_id uuid not null,
  reason text not null,
  operator text not null,
  accessed_at timestamptz not null default now()
);

create table if not exists ai_gateway.device_authorizations (
  device_code_hash text primary key,
  user_code_hash text not null unique,
  interval_seconds integer not null,
  issuer text,
  subject text,
  email text,
  approved_at timestamptz,
  exchanged_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists device_authorizations_expiry_idx
  on ai_gateway.device_authorizations (expires_at);

create table if not exists ai_gateway.device_sessions (
  token_hash text primary key,
  issuer text not null,
  subject text not null,
  email text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists device_sessions_expiry_idx
  on ai_gateway.device_sessions (expires_at);

insert into ai_gateway.schema_migrations (version)
values ('0001_ai_gateway')
on conflict (version) do nothing;
