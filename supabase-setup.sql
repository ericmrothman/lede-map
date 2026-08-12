-- ===========================================================================
--  Where We're From — database setup
--  Paste this whole file into the Supabase SQL Editor and hit Run.
--  Safe to re-run: it drops and recreates the policies and grants.
-- ===========================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------

create table if not exists public.pins (
  id         uuid primary key default gen_random_uuid(),
  name       text,                       -- optional; null means anonymous
  label      text not null,              -- "Lagos, Nigeria"
  lat        double precision not null,
  lng        double precision not null,
  note       text,                       -- optional one-liner
  secret     text not null,              -- random token; lets one person delete their own pin
  created_at timestamptz not null default now(),

  -- Length and range limits are enforced here, in the database, because the
  -- browser is not a trustworthy place to enforce anything.
  constraint pins_name_len   check (name is null or char_length(name) <= 40),
  constraint pins_label_len  check (char_length(label) between 1 and 120),
  constraint pins_note_len   check (note is null or char_length(note) <= 140),
  constraint pins_lat_range  check (lat between -90 and 90),
  constraint pins_lng_range  check (lng between -180 and 180),
  constraint pins_secret_len check (char_length(secret) between 20 and 128)
);

create index if not exists pins_created_at_idx on public.pins (created_at);

-- ---------------------------------------------------------------------------
-- 2. Column privileges
--
--    `anon` is the role behind the public key shipped in config.js. It may
--    read the public columns, insert, and delete. It must never be able to
--    read `secret` — that token is the only thing standing between a visitor
--    and deleting someone else's pin.
-- ---------------------------------------------------------------------------

revoke all on public.pins from anon;
grant select (id, name, label, lat, lng, note, created_at) on public.pins to anon;
grant insert on public.pins to anon;
grant delete on public.pins to anon;
-- Editable columns only: `secret` stays unwritable so the ownership token
-- cannot be overwritten, and `id` so a row cannot be re-pointed at someone else.
grant update (name, label, lat, lng, note) on public.pins to anon;

-- ---------------------------------------------------------------------------
-- 3. Row-level security
-- ---------------------------------------------------------------------------

alter table public.pins enable row level security;

drop policy if exists pins_public_read   on public.pins;
drop policy if exists pins_public_insert on public.pins;
drop policy if exists pins_delete_own    on public.pins;
drop policy if exists pins_update_own    on public.pins;

-- Anyone with the link can see the map.
create policy pins_public_read on public.pins
  for select to anon
  using (true);

-- Anyone with the link can add themselves. The check constraints above are
-- what keep this from being abusable.
create policy pins_public_insert on public.pins
  for insert to anon
  with check (true);

-- You may delete a row only if you send back the exact secret stored on it,
-- in an X-Pin-Secret request header. Since nobody can read the secret column,
-- only the browser that created the pin can produce a match.
create policy pins_delete_own on public.pins
  for delete to anon
  using (
    secret <> ''
    and secret = coalesce(
      current_setting('request.headers', true)::json ->> 'x-pin-secret',
      ''
    )
  );

-- Editing works the same way: prove ownership with the secret. USING picks the
-- rows you may target, WITH CHECK constrains what they may become — both are
-- needed, since USING alone would let a row be edited into an unownable state.
create policy pins_update_own on public.pins
  for update to anon
  using (
    secret <> ''
    and secret = coalesce(
      current_setting('request.headers', true)::json ->> 'x-pin-secret', ''
    )
  )
  with check (
    secret <> ''
    and secret = coalesce(
      current_setting('request.headers', true)::json ->> 'x-pin-secret', ''
    )
  );

-- So: a visitor may read every pin, add one, and edit or delete only the pin
-- whose secret their browser holds. Nobody can touch anybody else's entry.

-- ===========================================================================
--  Moderation cheat sheet (run these yourself in the SQL Editor, which uses
--  a privileged connection and ignores the policies above):
--
--    select created_at, name, label, note from public.pins order by created_at desc;
--    delete from public.pins where id = '<paste-the-id>';
--    delete from public.pins where created_at > now() - interval '10 minutes';
--    truncate public.pins;   -- nuclear option
-- ===========================================================================
