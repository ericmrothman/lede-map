-- ===========================================================================
--  MIGRATION — let anyone edit any pin
--
--  Run this once in the Supabase SQL Editor. It replaces the owner-only edit
--  policy with an open one: any visitor may correct any entry, the way a
--  shared whiteboard works.
--
--  What this does NOT change:
--    • `secret` is still ungranted for update and unreadable, so nobody can
--      overwrite the token that lets a person delete their own pin.
--    • Deletion is still owner-only. Editing a mistake is recoverable by
--      editing it again; deleting someone is not.
--    • The length and range constraints still apply to every write.
-- ===========================================================================

drop policy if exists pins_update_own on public.pins;
drop policy if exists pins_update_any on public.pins;

create policy pins_update_any on public.pins
  for update to anon
  using (true)
  with check (true);
