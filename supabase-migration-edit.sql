-- ===========================================================================
--  MIGRATION — allow people to edit their own entry
--
--  Run this once in the Supabase SQL Editor if you set the project up before
--  the Edit button existed. (supabase-setup.sql now includes it, so a fresh
--  project does not need this file.)
--
--  Until you run this, the Edit button will report that the database refused
--  the change. Everything else keeps working.
-- ===========================================================================

-- Only the editable columns. `secret` is deliberately excluded, so nobody can
-- overwrite the token that proves ownership of a row, and `id` is excluded so
-- a row cannot be re-pointed at someone else's entry.
grant update (name, label, lat, lng, note) on public.pins to anon;

drop policy if exists pins_update_own on public.pins;

-- Same proof-of-ownership as deletion: you must hand back the exact secret
-- stored on the row, in an X-Pin-Secret header. USING controls which rows you
-- may target; WITH CHECK controls what they may look like afterwards. Both are
-- required — USING alone would let a row be edited into an unownable state.
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
