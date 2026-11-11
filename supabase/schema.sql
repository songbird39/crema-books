-- Supabase SQL Editor에서 실행 (여러 번 실행해도 됨)

-- ─── 즐겨찾기 (사용자별) ───
create table if not exists public.favorites (
  user_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  key       text not null,
  title     text not null,
  author    text not null default '',
  publisher text not null default '',
  crema_id  text,
  added_at  timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.favorites enable row level security;
drop policy if exists "own favorites" on public.favorites;
create policy "own favorites" on public.favorites for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ─── 관리자 (구글 계정 이메일) ───
create table if not exists public.admins (email text primary key);
alter table public.admins enable row level security; -- 정책 없음: API로는 못 읽고 is_admin()으로만 확인

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins where lower(email) = lower(auth.jwt() ->> 'email'));
$$;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ─── 동기화 기록 (GitHub Actions가 secret key로 씀, 관리자만 읽음) ───
create table if not exists public.sync_runs (
  id          bigint generated always as identity primary key,
  workflow    text not null,          -- sync | sync-kr
  run_id      bigint,                 -- GitHub Actions run id
  url         text,
  trigger     text,                   -- schedule | workflow_dispatch | push
  mode        text,                   -- full | export
  status      text not null default 'running', -- running | success | partial | failed
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  summary     jsonb not null default '{}'
);
alter table public.sync_runs enable row level security;
drop policy if exists "admins read" on public.sync_runs;
create policy "admins read" on public.sync_runs for select to authenticated using (public.is_admin());

-- ─── 로그인 전에 넣어 둔 즐겨찾기 (처음 로그인할 때 그 사람 즐겨찾기로 옮김) ───
create table if not exists public.pending_favorites (
  email     text not null,
  key       text not null,
  title     text not null,
  author    text not null default '',
  publisher text not null default '',
  crema_id  text,
  added_at  timestamptz not null default now(),
  primary key (email, key)
);
alter table public.pending_favorites enable row level security; -- 정책 없음

create or replace function public.claim_pending_favorites() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer; e text := lower(auth.jwt() ->> 'email');
begin
  if auth.uid() is null or e is null then return 0; end if;
  insert into favorites (user_id, key, title, author, publisher, crema_id, added_at)
    select auth.uid(), key, title, author, publisher, crema_id, added_at from pending_favorites where lower(email) = e
    on conflict do nothing;
  get diagnostics n = row_count;
  delete from pending_favorites where lower(email) = e;
  return n;
end $$;
revoke execute on function public.claim_pending_favorites() from public, anon;
grant execute on function public.claim_pending_favorites() to authenticated;
