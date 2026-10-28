-- =========================================================
-- セトリシェアアプリ  データベース初期設定（Supabase / Postgres）
-- Supabase の SQL Editor に貼り付けて上から実行する
-- 事前に Authentication > Sign In / Providers で
--   ・Anonymous sign-ins を ON
--   ・Google と Email を ON
-- にしておくこと
-- =========================================================


-- ---------------------------------------------------------
-- 1. テーブル
-- ---------------------------------------------------------

-- 気分・シーン
create table public.scenes (
  id          serial primary key,
  name        text not null unique,
  sort_order  int  not null default 0
);

-- セトリ本体
create table public.setlists (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  scene_id    int  not null references public.scenes(id),
  comment     text check (
                comment is null or (
                  char_length(comment) <= 100
                  -- URL や SNS の ID を書けないようにする
                  and comment !~* '(https?://|www\.|\.com|@[a-z0-9_]{2,})'
                )
              ),
  is_hidden   boolean not null default false,
  created_at  timestamptz not null default now()
);
create index on public.setlists (scene_id) where not is_hidden;

-- 曲リンク
create table public.tracks (
  id          uuid primary key default gen_random_uuid(),
  setlist_id  uuid not null references public.setlists(id) on delete cascade,
  url         text not null check (url ~* '^https://'),
  service     text not null check (service in ('youtube','spotify','apple_music','amazon_music')),
  title       text,          -- Edge Function であとから埋める
  thumbnail   text,          -- 同上
  position    smallint not null,
  unique (setlist_id, position)
);

-- 誰に何が届いたか
create table public.deliveries (
  id           uuid primary key default gen_random_uuid(),
  setlist_id   uuid not null references public.setlists(id) on delete cascade,
  receiver_id  uuid not null references auth.users(id) on delete cascade,
  delivered_at timestamptz not null default now(),
  unique (setlist_id, receiver_id)          -- 同じセトリは同じ人に2回届かない
);
create index on public.deliveries (receiver_id, delivered_at);

-- 匿名感想（1配信につき1回）
create table public.reactions (
  id          uuid primary key default gen_random_uuid(),
  delivery_id uuid not null unique references public.deliveries(id) on delete cascade,
  setlist_id  uuid not null references public.setlists(id) on delete cascade,
  stamp       text not null check (stamp in ('sasatta','naita','genki','wakaru','suki','mata')),
  message     text check (message is null or char_length(message) <= 50),  -- 短文は後で解放
  is_hidden   boolean not null default false,
  created_at  timestamptz not null default now()
);

-- 通報
create table public.reports (
  id           uuid primary key default gen_random_uuid(),
  reporter_id  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  target_type  text not null check (target_type in ('setlist','reaction')),
  target_id    uuid not null,
  reason       text check (reason is null or char_length(reason) <= 200),
  created_at   timestamptz not null default now(),
  unique (reporter_id, target_type, target_id)
);

-- ブロック
create table public.blocks (
  blocker_id  uuid not null references auth.users(id) on delete cascade,
  blocked_id  uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (blocker_id, blocked_id)
);


-- ---------------------------------------------------------
-- 2. 初期データ（シーン11個）
-- ---------------------------------------------------------
insert into public.scenes (name, sort_order) values
  ('悲しい時',     1),
  ('嬉しい時',     2),
  ('通勤通学中',   3),
  ('作業中',       4),
  ('子育て中',     5),
  ('家事中',       6),
  ('眠れない夜',   7),
  ('朝起きた時',   8),
  ('失恋した時',   9),
  ('恋してる時',  10),
  ('ドライブ',    11);


-- ---------------------------------------------------------
-- 3. 補助関数
-- ---------------------------------------------------------

-- 今のユーザーがゲスト（匿名ログイン）か
create or replace function public.is_guest()
returns boolean
language sql stable
as $$
  select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false);
$$;


-- ---------------------------------------------------------
-- 4. RLS（行単位のアクセス制限）
--    書き込みは基本的に下の RPC 経由。直接触れるのは最小限
-- ---------------------------------------------------------
alter table public.scenes     enable row level security;
alter table public.setlists   enable row level security;
alter table public.tracks     enable row level security;
alter table public.deliveries enable row level security;
alter table public.reactions  enable row level security;
alter table public.reports    enable row level security;
alter table public.blocks     enable row level security;

-- シーンは誰でも見られる
create policy "scenes: read" on public.scenes
  for select to anon, authenticated using (true);

-- セトリ：自分のものだけ見る・消せる（届いた分は RPC が返す）
create policy "setlists: read own" on public.setlists
  for select to authenticated using (user_id = auth.uid());
create policy "setlists: delete own" on public.setlists
  for delete to authenticated using (user_id = auth.uid());

-- 曲：自分のセトリ、または自分に届いたセトリの曲だけ見られる
create policy "tracks: read own or delivered" on public.tracks
  for select to authenticated using (
    exists (select 1 from public.setlists s
            where s.id = tracks.setlist_id and s.user_id = auth.uid())
    or exists (select 1 from public.deliveries d
               where d.setlist_id = tracks.setlist_id and d.receiver_id = auth.uid())
  );

-- 届いた記録：自分が受け取った分だけ
create policy "deliveries: read own" on public.deliveries
  for select to authenticated using (receiver_id = auth.uid());

-- 感想：送った本人と、セトリを作った本人だけ見られる
--      （作った側には delivery の受け取り手が見えないので匿名が保たれる）
create policy "reactions: read" on public.reactions
  for select to authenticated using (
    exists (select 1 from public.deliveries d
            where d.id = reactions.delivery_id and d.receiver_id = auth.uid())
    or (
      not is_hidden
      and exists (select 1 from public.setlists s
                  where s.id = reactions.setlist_id and s.user_id = auth.uid())
    )
  );

-- 感想を送れるのは、実際に届いた人だけ。ゲストはスタンプのみ
create policy "reactions: insert" on public.reactions
  for insert to authenticated with check (
    exists (select 1 from public.deliveries d
            where d.id = reactions.delivery_id
              and d.receiver_id = auth.uid()
              and d.setlist_id = reactions.setlist_id)
    and (message is null or not public.is_guest())
  );

-- 通報：自分の通報だけ作れる・見られる
create policy "reports: insert own" on public.reports
  for insert to authenticated with check (reporter_id = auth.uid());
create policy "reports: read own" on public.reports
  for select to authenticated using (reporter_id = auth.uid());

-- ブロック：自分のブロックだけ見る・解除できる（追加は RPC）
create policy "blocks: read own" on public.blocks
  for select to authenticated using (blocker_id = auth.uid());
create policy "blocks: delete own" on public.blocks
  for delete to authenticated using (blocker_id = auth.uid());


-- ---------------------------------------------------------
-- 5. RPC（アプリから呼ぶ関数）
-- ---------------------------------------------------------

-- 5-1. セトリを作る（ログイン必須、曲は3〜10曲）
--   p_tracks の形: [{"url":"https://...","service":"spotify"}, ...]
create or replace function public.create_setlist(
  p_scene_id int,
  p_comment  text,
  p_tracks   jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
  v_n   int  := jsonb_array_length(coalesce(p_tracks, '[]'::jsonb));
begin
  if v_uid is null or public.is_guest() then
    raise exception 'login_required';
  end if;
  if v_n < 3 or v_n > 10 then
    raise exception 'tracks_must_be_3_to_10';
  end if;

  insert into setlists (user_id, scene_id, comment)
  values (v_uid, p_scene_id, nullif(trim(p_comment), ''))
  returning id into v_id;

  insert into tracks (setlist_id, url, service, position)
  select v_id, t.value ->> 'url', t.value ->> 'service', t.ord
  from jsonb_array_elements(p_tracks) with ordinality as t(value, ord);

  return v_id;
end;
$$;


-- 5-2. 気分を選んでセトリを1つ受け取る
--   返り値: null = もう届けられるセトリがない
--   上限: ゲスト1日3つ、ログイン1日10個（日本時間で日付が変わる）
create or replace function public.receive_setlist(p_scene_id int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_limit   int  := case when public.is_guest() then 3 else 10 end;
  v_today   timestamptz := date_trunc('day', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo';
  v_count   int;
  v_setlist setlists%rowtype;
  v_deliv   uuid;
begin
  if v_uid is null then
    raise exception 'login_required';
  end if;

  select count(*) into v_count
  from deliveries
  where receiver_id = v_uid and delivered_at >= v_today;

  if v_count >= v_limit then
    raise exception 'daily_limit_reached';
  end if;

  -- 条件に合うセトリからランダムに1つ
  -- （数万件を超えたら order by random() は遅くなるので見直す）
  select s.* into v_setlist
  from setlists s
  where s.scene_id = p_scene_id
    and not s.is_hidden
    and s.user_id <> v_uid
    and not exists (select 1 from deliveries d
                    where d.setlist_id = s.id and d.receiver_id = v_uid)
    and not exists (select 1 from blocks b
                    where b.blocker_id = v_uid and b.blocked_id = s.user_id)
  order by random()
  limit 1;

  if v_setlist.id is null then
    return null;
  end if;

  insert into deliveries (setlist_id, receiver_id)
  values (v_setlist.id, v_uid)
  returning id into v_deliv;

  -- 作った人の user_id は返さない
  return jsonb_build_object(
    'delivery_id', v_deliv,
    'setlist_id',  v_setlist.id,
    'scene',       (select name from scenes where id = v_setlist.scene_id),
    'comment',     v_setlist.comment,
    'tracks', (
      select jsonb_agg(jsonb_build_object(
               'url', t.url, 'service', t.service,
               'title', t.title, 'thumbnail', t.thumbnail)
             order by t.position)
      from tracks t where t.setlist_id = v_setlist.id
    )
  );
end;
$$;


-- 5-3. 届いたセトリの作者をブロック（相手が誰かは見えないまま）
create or replace function public.block_author(p_delivery_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_owner uuid;
begin
  select s.user_id into v_owner
  from deliveries d join setlists s on s.id = d.setlist_id
  where d.id = p_delivery_id and d.receiver_id = v_uid;

  if v_owner is null then
    raise exception 'not_found';
  end if;

  insert into blocks (blocker_id, blocked_id)
  values (v_uid, v_owner)
  on conflict do nothing;
end;
$$;


-- 5-4. 自分のセトリ一覧＋スタンプの集計（「じぶん」タブ用）
create or replace function public.my_setlists()
returns table (
  setlist_id uuid,
  scene      text,
  comment    text,
  created_at timestamptz,
  deliveries bigint,
  stamps     jsonb
)
language sql
security definer
set search_path = public
as $$
  select
    s.id,
    sc.name,
    s.comment,
    s.created_at,
    (select count(*) from deliveries d where d.setlist_id = s.id),
    coalesce((
      select jsonb_object_agg(r.stamp, r.n)
      from (select stamp, count(*) as n
            from reactions
            where setlist_id = s.id and not is_hidden
            group by stamp) r
    ), '{}'::jsonb)
  from setlists s
  join scenes sc on sc.id = s.scene_id
  where s.user_id = auth.uid()
  order by s.created_at desc;
$$;


-- ---------------------------------------------------------
-- 6. 通報が3件たまったら自動で非表示
-- ---------------------------------------------------------
create or replace function public.auto_hide_on_reports()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  select count(*) into v_n
  from reports
  where target_type = new.target_type and target_id = new.target_id;

  if v_n >= 3 then
    if new.target_type = 'setlist' then
      update setlists  set is_hidden = true where id = new.target_id;
    else
      update reactions set is_hidden = true where id = new.target_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger reports_auto_hide
  after insert on public.reports
  for each row execute function public.auto_hide_on_reports();


-- ---------------------------------------------------------
-- 7. 実行権限：未ログインの anon ロールからは呼べなくする
--    （ゲストも匿名ログイン済みなので authenticated 扱い）
-- ---------------------------------------------------------
revoke execute on function public.create_setlist(int, text, jsonb) from public, anon;
revoke execute on function public.receive_setlist(int)             from public, anon;
revoke execute on function public.block_author(uuid)               from public, anon;
revoke execute on function public.my_setlists()                    from public, anon;
revoke execute on function public.auto_hide_on_reports()           from public, anon, authenticated;

grant execute on function public.create_setlist(int, text, jsonb) to authenticated;
grant execute on function public.receive_setlist(int)             to authenticated;
grant execute on function public.block_author(uuid)               to authenticated;
grant execute on function public.my_setlists()                    to authenticated;
