-- 青帳：雲端帳本資料表與安全規則
-- 請在 Supabase Dashboard 的 SQL Editor 貼上並執行此完整檔案一次。

create table if not exists public.user_books (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '我' check (char_length(display_name) between 1 and 30),
  book jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_books enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on table public.user_books to authenticated;

drop policy if exists "Users can read only their own book" on public.user_books;
create policy "Users can read only their own book"
  on public.user_books for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create only their own book" on public.user_books;
create policy "Users can create only their own book"
  on public.user_books for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update only their own book" on public.user_books;
create policy "Users can update only their own book"
  on public.user_books for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete only their own book" on public.user_books;
create policy "Users can delete only their own book"
  on public.user_books for delete
  to authenticated
  using ((select auth.uid()) = user_id);
