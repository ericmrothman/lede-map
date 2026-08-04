# Where We're From

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
> defined by the policies you just ran: read pins, add a pin, delete only a pin
> whose secret token you hold. It cannot edit entries, cannot read the secret
> column, and cannot touch anything else. Keep the **`service_role`** key out of
> this repo — that one really is a master key.

### 3. Publish

The repo is already initialised and committed locally on `main`. Two steps left.

**a. Push it to GitHub, from VS Code**

1. Open the **Source Control** panel (`⌃⇧G`).
2. Click **Publish Branch**, or Command Palette (`⇧⌘P`) → **Publish to GitHub**.
3. Choose **Publish to a public repository** — Pages will not serve a private
   repo on the free plan.
4. When it asks for a name, type `lede-2026-world-map`. It will suggest the
   folder name (`lede-map`) by default, so this needs changing.

**b. Turn on Pages**

On github.com, in the new repo: **Settings → Pages → Build and deployment →
Source: Deploy from a branch → Branch: `main` / `/ (root)` → Save**.

Give it a minute, then it's live at:

```
https://ericmrothman.github.io/lede-2026-world-map/
```

That's the link you send to the class.

**Pushing changes later** — edit, then in Source Control write a message, click
**Commit**, then **Sync Changes**. Pages redeploys in under a minute.

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

Anyone can also close the search panel and click the map directly, which reverse
geocodes the spot — useful for a village Nominatim has never heard of.

---

## Things worth knowing

**Someone can put in a fake city.** With no authentication, that's the trade.
Realistically nobody in your class will. If someone does, delete the row from the
Supabase SQL Editor — there's a cheat sheet of moderation queries at the bottom
of `supabase-setup.sql`.

**Removing your own pin** works from the panel, and only from the browser you
added it in. The delete token lives in `localStorage`; clear your browser data
and you lose the ability to remove it yourself.

**Nominatim is rate-limited** to roughly one request per second per user. The
debounce handles normal typing. If the whole class submits in the same thirty
seconds it still holds up, because each person's browser is a separate client.

**Keeping the artifact.** When the class is over, export it:
Supabase → **Table Editor → pins → Export to CSV**. That CSV is the real
souvenir; the site is just how you collected it.

---

## Making it yours

- **Title** — `title` in `config.js`.
- **Pin colour** — `--accent` in [styles.css](styles.css).
- **Basemap** — swap `voyager` for `positron` (pale) or `dark_matter` (dark) in
  the two tile URLs in [app.js](app.js). Dark plus a bright accent looks great
  on a projector.
- **Extra question** — the `note` field is deliberately open-ended. Change its
  placeholder to whatever prompt suits the class: a favourite local spot, why
  they left, what they'd order for breakfast there.
