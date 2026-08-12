# LEDE 2026 WORLD MAP

A shared world map. Open the link, add your city, see everyone else. No sign-in,
no accounts, no app. Built to be a keepsake at the end of a class.

Static site — HTML, CSS, one JS file — so it runs on GitHub Pages for free.

---

## Setup (about ten minutes, once)

### 1. Create the database

1. Go to [supabase.com](https://supabase.com) → **New project**. The free tier is
   plenty; a class of 40 uses a rounding error's worth of it.
2. Once it finishes provisioning, open **SQL Editor** → **New query**.
3. Paste in the entire contents of [supabase-setup.sql](supabase-setup.sql) and
   press **Run**. You should see "Success. No rows returned."

### 2. Point the site at it

In Supabase, go to **Project Settings → API** and copy two values:

- **Project URL** — looks like `https://abcdefghijklm.supabase.co`
- **anon / public** key — a long string starting `eyJ…`

Paste both into [config.js](config.js):

```js
window.MAP_CONFIG = {
  supabaseUrl: 'https://qppptqodjiwusagbmrqy.supabase.co',
  supabaseKey: 'sb_publishable_BO7KN4iL0dwNTESSg9ykKw_-PgPosIx',
  title: "Lede 2026 World Map",
  refreshMs: 12000,
};
```

> **Is it okay that the key is public?** Yes — that is what the anon key is for.
> It identifies the project, not a person. Everything it's permitted to do is
> defined by the policies you just ran: read pins, add a pin, edit any pin, and
> delete only a pin whose secret token you hold. It cannot read the secret
> column and cannot reach anything else in the database. Keep the
> **`service_role`** key out of this repo — that one really is a master key.

### 3. Publish

Already done. The site is live at:

```
https://ericmrothman.github.io/lede-map/
```

That's the link to send to the class.

**Pushing changes** — edit, then in the Source Control panel (`⌃⇧G`) write a
message, click **Commit**, then **Sync Changes**. Pages redeploys in under a
minute; hard-refresh (`⇧⌘R`) if you still see the old version.

> Don't rename the repository. The URL above is already in circulation, and
> renaming breaks every link that's been shared.

---

## Trying it locally first

With `config.js` left blank, the site runs in **demo mode** — fully functional,
but pins save to your browser's localStorage instead of a database. Good for
checking how it looks before you commit anything.

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` as a `file://` URL will not work — the geocoder needs a
real origin.

---

## How it works

| Concern | Approach |
| --- | --- |
| Map | [Leaflet](https://leafletjs.com) with CARTO Voyager tiles. No API key. |
| City → coordinates | [Nominatim](https://nominatim.org), OpenStreetMap's free geocoder. Debounced to stay well inside its usage policy. |
| Storage | Supabase Postgres over its REST API, straight from the browser. |
| Who can write | Anyone with the link. Row-level security, not authentication, is what constrains them. |
| Live updates | Polls every 12 seconds, and immediately when you switch back to the tab. |

Pins in the same place merge into one dot that grows with the number of people
there, and the popup lists everyone. Five people from Chicago should *look* like
five people from Chicago.

Names sit beside their dot as a label, and clicking either the dot or the name
opens the full entry. Labels are laid out against each other every time the view
changes, so they never stack; one that has to travel to find room leans a little
and keeps a curved arrow back to its own dot.

While the panel is open you can also click the map directly instead of
searching, which reverse geocodes the spot — useful for a village Nominatim has
never heard of.

---

## Things worth knowing

**Someone can put in a fake city.** With no authentication, that's the trade.
Realistically nobody in your class will. If someone does, delete the row from the
Supabase SQL Editor — there's a cheat sheet of moderation queries at the bottom
of `supabase-setup.sql`.

**Anyone can edit any pin.** Click a dot or a name, then **Edit**. This is
deliberate: it works like a shared whiteboard, so a typo or a wrong city can be
fixed by whoever notices, and nobody is locked out because they added their pin
on a different device. The trade is that there is no edit history — a bad edit
overwrites the old value for good, so take CSV exports if the data matters.

**Deleting** is still restricted to whoever created the pin, from the browser
they created it in. A wrong edit can be edited back; a deletion cannot be
undone. The ownership token lives in that browser's `localStorage`, so clearing
site data means you can no longer delete your own entry — you can still edit it,
and you can always delete rows yourself from the Supabase SQL Editor.

> **Upgrading an existing project:** run
> [supabase-migration-open-edit.sql](supabase-migration-open-edit.sql) once in
> the Supabase SQL Editor. Until then, Edit reports that the database refused
> the change. `supabase-setup.sql` already includes it for a fresh project.

**Nominatim is rate-limited** to roughly one request per second per user. The
debounce handles normal typing. If the whole class submits in the same thirty
seconds it still holds up, because each person's browser is a separate client.

**Free Supabase projects pause when idle** — currently after about a week with
no requests. A paused project returns errors, so the map goes blank until you
un-pause it from the Supabase dashboard (one click, data intact). This matters
here because a class map gets heavy use for a day and then sits still. Don't
rely on the live site being up in six months; rely on the CSV below.

---

## The Export panel

The **Export** button opens everything cosmetic, plus saving.

**Themes** — Voyager (the default), Paper (pale, best for printing), Night (dark,
best on a projector) and Ink (no place names at all, so only people's names
appear). Five accent colours drive the dots, the arcs and the tethers together.
Your choice is saved in your browser. A `#t=night&a=moss` fragment on the URL
overrides it on arrival without disturbing what anyone else picked, which is
handy for projecting — build one by hand when you want it.

**Arcs from Pulitzer Hall** — a great-circle line from Columbia out to every pin,
interpolated along the sphere so the line to Seoul bows the way a flight path
does. They sit in a pane below the dots and the names and are off by default;
they are meant to be a texture, not a subject.

An arc runs out of map at two edges. Sideways it meets the antimeridian — a
course to Tokyo runs west across the Pacific and over it. Upwards it meets the
top of the projection, which arrives sooner than you would expect: the route to
Singapore is very nearly polar and peaks at 87.5°N, past the 85° where Web
Mercator stops.

Rather than stop dead at either, an arc breaks up as it approaches: the stroke
turns from solid to dashed, and the dashes shorten and draw further apart until
there is nothing left. A line trailing off the edge of the sheet, rather than
one flattened against it.

**Save as image** — writes a PNG at 1920×1080, 2560×1440, 4K, or your own screen
size, made to be used as a desktop background. It renders from `@2x` tiles, so a
4K export is sharp rather than an upscaled screenshot.

Two things the export does differently from the screen, both on purpose. It
leaves the basemap's own place names off: at export scale CARTO sets continent
and country lettering enormous, and it ends up reading as the subject of the
image instead of the people. And it doesn't frame to the pins at all: it uses the
map's own furthest zoom out — the level you land on holding the minus button
down — so the image is the view the map itself considers all the way out.

Vertically it centres on the band of inhabited land — the north of Greenland
down to Cape Horn — rather than on the projection. Antarctica is a third of the
Mercator square and nobody lives there; centring on the map's own middle spends
the bottom of the picture on empty ice and pushes everyone into the top half.
If someone lives far enough south that the frame would cut them off, it nudges
down to keep them in. A preference about centring should never cost you a
classmate.

> **How the export works, and the one thing that could break it.** The image is
> redrawn from scratch onto a canvas — tiles, arcs, dots, names, tethers —
> rather than screenshotting the page, and it runs the *same* label solver the
> live map uses, so the picture matches what you were looking at. That is only
> possible because CARTO serves tiles with `access-control-allow-origin: *`; the
> tiles are loaded `crossOrigin="anonymous"` so the canvas stays untainted and
> can be saved. If CARTO ever dropped that header, export would fail with a
> message saying a tile blocked it, and the fix would be to proxy the tiles.

---

## Backups

```sh
./backup.sh
```

Writes `backups/pins-YYYY-MM-DD-HHMM.csv` and `.json`. Needs only curl, reads
the credentials out of `config.js`, and refuses to leave a file behind if the
request fails or returns nothing — a backup that silently saved zero rows is
worse than none. Run it whenever you want a checkpoint, and certainly once the
class has finished adding themselves.

`backups/` is gitignored on purpose. The map is public, but a public *repo* is
permanent in a way the map is not: anything committed stays in git history even
after someone removes their pin. Keep the snapshots local, or put them somewhere
private.

**The two exports are not the same thing.** `backup.sh` uses the public key, so
it gets every column except `secret` — the whole artifact, and what you want for
keeping. It is not restore-ready: reimport it and nobody could delete their own
pin. For a true dump use Supabase → **Table Editor → pins → Export to CSV**,
which runs with privileged access and includes `secret`.

**Keeping the artifact.** The CSV is the real souvenir; the site is just how you
collected it. It outlives the free tier, the paused project, and the repo.

---

## Making it yours

Everything here is in [config.js](config.js):

- **`title`** — shown in the header and used for the exported filename.
  The `<title>` and `og:title` in [index.html](index.html) are separate: link
  previews are read by crawlers that never run the JavaScript, so those have to
  be edited by hand.
- **`theme` / `accent`** — the look the map opens with, before anyone picks
  their own.
- **`arcOrigin`** — where the arcs radiate from. Set it to `null` to remove the
  feature and its toggle entirely.
- **Extra question** — the `note` field is deliberately open-ended. Change its
  placeholder in `index.html` to whatever prompt suits the class: a favourite
  local spot, why they left, what they'd order for breakfast there.

Deeper changes: pin sizing is `dotRadius` in [app.js](app.js), and the label
look is `.pin-label` in [styles.css](styles.css). Theme tokens are the
`html[data-theme="…"]` blocks in the same file.
