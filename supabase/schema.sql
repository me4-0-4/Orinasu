-- Orinasu クラウド保存用のテーブルとアクセス制限（RLS）。
-- Supabase の「SQL Editor」に全部貼って「Run」を1回押す。何度実行しても壊れない。
--
-- ログインした人は「自分のデータだけ」読み書きできる。他の人のデータは見えない。
-- 削除は行を消さず deleted = true の印（墓標）を付ける。別の端末にも削除を伝えるため。

create table if not exists public.phrases (
  user_id    uuid    not null default auth.uid() references auth.users (id) on delete cascade,
  id         text    not null,
  data       jsonb   not null,
  updated_at bigint  not null,
  deleted    boolean not null default false,
  primary key (user_id, id)
);

create table if not exists public.presets (
  user_id    uuid    not null default auth.uid() references auth.users (id) on delete cascade,
  id         text    not null,
  data       jsonb   not null,
  updated_at bigint  not null,
  deleted    boolean not null default false,
  primary key (user_id, id)
);

-- 刻んだ曲（名前を付けて残したもの。作業中の曲は同期しない）
create table if not exists public.songs (
  user_id    uuid    not null default auth.uid() references auth.users (id) on delete cascade,
  id         text    not null,
  data       jsonb   not null,
  updated_at bigint  not null,
  deleted    boolean not null default false,
  primary key (user_id, id)
);

alter table public.phrases enable row level security;
alter table public.songs enable row level security;
alter table public.presets enable row level security;

-- ログインしていない人（anon）には何も許可しない。ログイン済み（authenticated）にだけ許可する。
revoke all on public.phrases from anon;
revoke all on public.presets from anon;
revoke all on public.songs from anon;
grant select, insert, update on public.phrases to authenticated;
grant select, insert, update on public.presets to authenticated;
grant select, insert, update on public.songs to authenticated;

drop policy if exists "own rows" on public.phrases;
create policy "own rows" on public.phrases
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "own rows" on public.presets;
create policy "own rows" on public.presets
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "own rows" on public.songs;
create policy "own rows" on public.songs
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- --- 読み込んだ音（段階7） ------------------------------------------------------
-- 音の情報（名前・長さ・テンポなど）はこの表に、音の中身は Storage の「sounds」置き場に入れる。

create table if not exists public.sounds (
  user_id    uuid    not null default auth.uid() references auth.users (id) on delete cascade,
  id         text    not null,
  data       jsonb   not null,
  updated_at bigint  not null,
  deleted    boolean not null default false,
  primary key (user_id, id)
);

alter table public.sounds enable row level security;
revoke all on public.sounds from anon;
grant select, insert, update on public.sounds to authenticated;

drop policy if exists "own rows" on public.sounds;
create policy "own rows" on public.sounds
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- 音の中身の置き場。公開しない。1ファイル 50MB まで。
insert into storage.buckets (id, name, public, file_size_limit)
values ('sounds', 'sounds', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

-- 置き場の中は「ユーザーID/音のID」。自分のフォルダの中だけ読み書き・削除できる。
drop policy if exists "own sounds select" on storage.objects;
create policy "own sounds select" on storage.objects
  for select to authenticated
  using (bucket_id = 'sounds' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "own sounds insert" on storage.objects;
create policy "own sounds insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'sounds' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "own sounds update" on storage.objects;
create policy "own sounds update" on storage.objects
  for update to authenticated
  using (bucket_id = 'sounds' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'sounds' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "own sounds delete" on storage.objects;
create policy "own sounds delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'sounds' and (storage.foldername(name))[1] = (select auth.uid())::text);
