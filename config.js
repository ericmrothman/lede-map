/* ---------------------------------------------------------------------------
   Fill these in, then commit. See README.md for the two-minute Supabase setup.

   Both values below are SAFE TO MAKE PUBLIC. The anon key is designed to sit
   in client-side code; what it can actually do is controlled by the row-level
   security policies in supabase-setup.sql (read pins, add a pin, delete only
   your own). Never put the `service_role` key here.

   Leave them blank to run in demo mode: the map works, but pins are stored
   only in this browser's localStorage.
--------------------------------------------------------------------------- */

window.MAP_CONFIG = {
  supabaseUrl: '',   // e.g. 'https://abcdefghijklm.supabase.co'
  supabaseKey: '',   // the "anon / public" key from Project Settings → API

  // Cosmetic — change freely.
  title: "LEDE 2026 WORLD MAP",

  // How often (ms) to poll for pins other people have added. 0 disables it.
  refreshMs: 12000,
};
