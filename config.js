/* ---------------------------------------------------------------------------
   Fill these in, then commit. See README.md for the two-minute Supabase setup.

   Both values below are SAFE TO MAKE PUBLIC. The anon key is designed to sit
   in client-side code; what it can actually do is controlled by the row-level
   security policies in supabase-setup.sql (read pins, add a pin, edit any pin,
   delete only your own). Never put the `service_role` key here.

   Leave them blank to run in demo mode: the map works, but pins are stored
   only in this browser's localStorage.
--------------------------------------------------------------------------- */

window.MAP_CONFIG = {
  supabaseUrl: 'https://qppptqodjiwusagbmrqy.supabase.co',
  supabaseKey: 'sb_publishable_BO7KN4iL0dwNTESSg9ykKw_-PgPosIx',

  // Cosmetic — change freely.
  title: 'LEDE 2026 WORLD MAP',

  // How often (ms) to poll for pins other people have added. 0 disables it.
  refreshMs: 12000,

  /* Opening look. A visitor's own choice, once they make one, wins over this;
     a `#t=…&a=…` fragment in the link wins over both. Themes: voyager, paper,
     night, ink. Accents: coral, cobalt, moss, plum, ochre. */
  theme: 'voyager',
  accent: 'coral',

  /* Where the connection arcs radiate from — Pulitzer Hall, Columbia. Set to
     null to drop the arcs feature entirely. */
  arcOrigin: { lat: 40.8075, lng: -73.9626, label: 'Pulitzer Hall' },
};
