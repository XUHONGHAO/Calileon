-- ============================================================================
-- Excalidraw 自部署后端 · Phase 1 一键建表脚本（账号 + 云端白板）
-- ----------------------------------------------------------------------------
-- 用法：登录你自己的 Supabase 项目 → 左侧 SQL Editor → New query →
--       把本文件全部内容粘进去 → 点 Run（运行）。跑一次即可。
--
-- 这个脚本做三件事：
--   1. 建 scenes 表（存云端白板，payload 是明文 scene JSON）
--   2. 开行级安全 RLS（每个用户只能读写自己的白板）
--   3. 装一个触发器（更新时自动刷新 updated_at 时间戳）
--
-- 安全说明（决策 0004）：Phase 1 不做端到端加密，靠账号 + RLS 隔离用户。
-- 你作为 Supabase 项目所有者理论上能看到明文数据——自部署场景可接受。
-- 图片二进制不存这里（Phase 2 才上云），Phase 1 只存 scene JSON。
-- 可重复运行：用了 if not exists / drop ... if exists，跑第二次不会报错。
-- ============================================================================

-- 1) scenes 表 ---------------------------------------------------------------
create table if not exists public.scenes (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users (id) on delete cascade,
  title          text not null default 'Untitled',
  payload_kind   text not null default 'plain',   -- 'plain' | 'encrypted'(P4 预留)
  payload        jsonb not null,                   -- 明文 scene JSON（决策 0004）
  version        integer not null default 1,
  thumbnail_meta jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz                       -- 软删除：非空即已删除
);

-- 列表查询用的索引（按 owner + 最近更新排序，只看未删除的）
create index if not exists scenes_owner_updated_idx
  on public.scenes (owner_id, updated_at desc)
  where deleted_at is null;

-- 2) 行级安全（RLS）：用户只能碰自己的白板 -------------------------------------
alter table public.scenes enable row level security;

drop policy if exists "owner can read own scenes"   on public.scenes;
drop policy if exists "owner can insert own scenes" on public.scenes;
drop policy if exists "owner can update own scenes" on public.scenes;
drop policy if exists "owner can delete own scenes" on public.scenes;

create policy "owner can read own scenes"
  on public.scenes for select
  using (auth.uid() = owner_id);

create policy "owner can insert own scenes"
  on public.scenes for insert
  with check (auth.uid() = owner_id);

create policy "owner can update own scenes"
  on public.scenes for update
  using (auth.uid() = owner_id);

create policy "owner can delete own scenes"
  on public.scenes for delete
  using (auth.uid() = owner_id);

-- 3) updated_at 自动更新触发器 ------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists scenes_touch_updated_at on public.scenes;

create trigger scenes_touch_updated_at
  before update on public.scenes
  for each row execute function public.touch_updated_at();

-- ============================================================================
-- 完成。跑完后可在左侧 Table Editor 看到 public.scenes 表。
-- 分享/嵌入的「他人受控读取」是 Phase 2/3 的事，到时再加独立 policy，不在此脚本。
-- ============================================================================
