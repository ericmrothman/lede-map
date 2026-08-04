/* ---------------------------------------------------------------------------
   Where We're From — a shared class map.

   Architecture, briefly:
     • Static site (works on GitHub Pages). No build step, no server.
     • Pins live in a Supabase table. The browser talks to it over PostgREST
       with the public anon key; row-level security decides what's allowed
       (read all, insert one, delete only a row whose secret you hold).
     • City lookup uses the free Nominatim geocoder from OpenStreetMap.
     • With no Supabase config, everything still runs against localStorage
       so you can develop and demo offline.
--------------------------------------------------------------------------- */

(function () {
  'use strict';

  const CFG = Object.assign(
    { supabaseUrl: '', supabaseKey: '', title: "Where We're From", refreshMs: 12000 },
    window.MAP_CONFIG || {}
  );

  const REMOTE = Boolean(CFG.supabaseUrl && CFG.supabaseKey);
  const COLUMNS = 'id,name,label,lat,lng,note,created_at';
  const MINE_KEY = 'wwf:mine';
  const DEMO_KEY = 'wwf:demo-pins';

  /* --- Tiny helpers ----------------------------------------------------- */

  const $ = (id) => document.getElementById(id);

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

  const debounce = (fn, ms) => {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };

  const uuid = () =>
    (crypto.randomUUID
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        }));

  let toastTimer;
  function toast(msg, ms = 3000) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  /* --- Storage ---------------------------------------------------------- */
  /* Two interchangeable backends behind one interface. */

  const remoteStore = {
    async list() {
      const url = `${CFG.supabaseUrl}/rest/v1/pins?select=${COLUMNS}&order=created_at.asc&limit=2000`;
      const res = await fetch(url, {
        headers: { apikey: CFG.supabaseKey, Authorization: `Bearer ${CFG.supabaseKey}` },
      });
      if (!res.ok) throw new Error(`Could not load pins (${res.status})`);
      return res.json();
    },

    async add(pin, secret) {
      const res = await fetch(`${CFG.supabaseUrl}/rest/v1/pins`, {
        method: 'POST',
        headers: {
          apikey: CFG.supabaseKey,
          Authorization: `Bearer ${CFG.supabaseKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(Object.assign({ secret }, pin)),
      });
      if (!res.ok) throw new Error(await describeError(res));
      return pin;
    },

    async remove(id, secret) {
      const res = await fetch(
        `${CFG.supabaseUrl}/rest/v1/pins?id=eq.${encodeURIComponent(id)}`,
        {
          method: 'DELETE',
          headers: {
            apikey: CFG.supabaseKey,
            Authorization: `Bearer ${CFG.supabaseKey}`,
            'X-Pin-Secret': secret,
          },
        }
      );
      if (!res.ok) throw new Error(await describeError(res));
    },
  };

  const localStore = {
    async list() {
      try { return JSON.parse(localStorage.getItem(DEMO_KEY) || '[]'); }
      catch { return []; }
    },
    async add(pin) {
      const all = await localStore.list();
      all.push(pin);
      localStorage.setItem(DEMO_KEY, JSON.stringify(all));
      return pin;
    },
    async remove(id) {
      const all = (await localStore.list()).filter((p) => p.id !== id);
      localStorage.setItem(DEMO_KEY, JSON.stringify(all));
    },
  };

  const store = REMOTE ? remoteStore : localStore;

  async function describeError(res) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body.message || body.hint || body.details || '';
    } catch { /* non-JSON error body */ }
    if (res.status === 401 || res.status === 403) {
      return 'The database rejected that. Check the anon key and the security policies.';
    }
    return detail || `Request failed (${res.status})`;
  }

  /* --- "My pin" record (so a person can undo their own entry) ----------- */

  const mine = {
    get() {
      try { return JSON.parse(localStorage.getItem(MINE_KEY) || 'null'); }
      catch { return null; }
    },
    set(v) { localStorage.setItem(MINE_KEY, JSON.stringify(v)); },
    clear() { localStorage.removeItem(MINE_KEY); },
  };

  /* --- Map -------------------------------------------------------------- */

  const map = L.map('map', {
    center: [22, 8],
    zoom: 2,
    minZoom: 2,
    worldCopyJump: true,
    zoomControl: false,
    attributionControl: false,
  });

  L.control.zoom({ position: 'bottomleft' }).addTo(map);

  L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png',
    { subdomains: 'abcd', maxZoom: 18 }
  ).addTo(map);

  /* Place names go in their own pane, above the base tiles but below the pins
     so a busy city label never sits on top of somebody's dot. */
  map.createPane('labels').style.zIndex = 350;
  map.getPane('labels').style.pointerEvents = 'none';

  L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png',
    { subdomains: 'abcd', maxZoom: 18, pane: 'labels' }
  ).addTo(map);

  const renderer = L.svg({ padding: 0.5 });
  const pinLayer = L.layerGroup().addTo(map);
  let pendingMarker = null;
  let pins = [];
  let hasFitOnce = false;

  /* Pins in the same place become one dot that grows with the crowd — the
     point of the artifact is seeing where people cluster. */
  function groupPins(list) {
    const groups = new Map();
    for (const p of list) {
      const key = `${Number(p.lat).toFixed(2)},${Number(p.lng).toFixed(2)}`;
      if (!groups.has(key)) groups.set(key, { lat: +p.lat, lng: +p.lng, entries: [] });
      groups.get(key).entries.push(p);
    }
    return [...groups.values()];
  }

  function popupHtml(group) {
    const place = group.entries[0].label;
    const items = group.entries
      .map((p) => {
        const who = p.name
          ? `<span class="popup-name">${esc(p.name)}</span>`
          : '<span class="popup-anon">someone</span>';
        const note = p.note ? `<span class="popup-note">${esc(p.note)}</span>` : '';
        return `<li>${who}${note}</li>`;
      })
      .join('');
    const count = group.entries.length;
    const heading = count > 1
      ? `${esc(place)} <span style="color:var(--ink-faint);font-weight:400">&middot; ${count}</span>`
      : esc(place);
    return `<p class="popup-place">${heading}</p><ul class="popup-list">${items}</ul>`;
  }

  function render() {
    pinLayer.clearLayers();
    const groups = groupPins(pins);

    for (const g of groups) {
      const n = g.entries.length;
      const radius = 6 + Math.min(11, 3.2 * Math.sqrt(n - 1));
      L.circleMarker([g.lat, g.lng], {
        radius,
        className: 'pin-dot',
        renderer,
        bubblingMouseEvents: false,   // clicking a pin must not also drop a new one
      })
        .bindPopup(popupHtml(g), { closeButton: false, maxWidth: 260 })
        .bindTooltip(
          n > 1 ? `${g.entries[0].label} · ${n}` : g.entries[0].label,
          { direction: 'top', offset: [0, -radius - 2] }
        )
        .addTo(pinLayer);
    }

    updateTally(groups);

    if (!hasFitOnce && pins.length) {
      hasFitOnce = true;
      fitToPins();
    }
  }

  function fitToPins() {
    if (!pins.length) return;
    const bounds = L.latLngBounds(pins.map((p) => [+p.lat, +p.lng]));
    if (pins.length === 1) map.setView(bounds.getCenter(), 5, { animate: false });
    else map.fitBounds(bounds, { padding: [70, 70], maxZoom: 6, animate: false });
  }

  function updateTally(groups) {
    const el = $('tally');
    if (!pins.length) {
      el.textContent = REMOTE
        ? 'No one yet — be the first.'
        : 'Demo mode — pins save to this browser only.';
      return;
    }
    const people = pins.length;
    const places = groups.length;
    el.textContent =
      `${people} ${people === 1 ? 'person' : 'people'} · ` +
      `${places} ${places === 1 ? 'place' : 'places'}`;
  }

  /* --- Geocoding (Nominatim) -------------------------------------------- */
  /* Free, no key. Usage policy asks for light traffic, so: debounced,
     one in-flight request at a time, and results capped. Fine for a class. */

  const NOMINATIM = 'https://nominatim.openstreetmap.org';
  let searchAbort = null;

  function labelFromAddress(item) {
    const a = item.address || {};
    const city =
      a.city || a.town || a.village || a.hamlet || a.municipality ||
      a.suburb || a.county || item.name || '';
    const region = a.state || a.region || a.province || '';
    const country = a.country || '';
    const parts = [city, region, country].filter(Boolean);
    // Drop a region that just repeats the city ("Singapore, Singapore, Singapore").
    const deduped = parts.filter((p, i) => parts.indexOf(p) === i);
    return deduped.join(', ') || item.display_name || 'Unknown place';
  }

  async function searchPlaces(q) {
    if (searchAbort) searchAbort.abort();
    searchAbort = new AbortController();
    const url =
      `${NOMINATIM}/search?format=jsonv2&addressdetails=1&limit=6&accept-language=en` +
      `&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { signal: searchAbort.signal });
    if (!res.ok) throw new Error('Search is unavailable right now.');
    return res.json();
  }

  async function reverseGeocode(lat, lng) {
    const url =
      `${NOMINATIM}/reverse?format=jsonv2&addressdetails=1&zoom=10&accept-language=en` +
      `&lat=${lat}&lon=${lng}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Could not identify that spot.');
    return res.json();
  }

  /* --- Panel & form ----------------------------------------------------- */

  const panel = $('panel');
  const qInput = $('q');
  const resultsEl = $('results');
  const chosenEl = $('chosen');
  const chosenLabel = $('chosen-label');
  const submitBtn = $('submit-btn');
  const errorEl = $('form-error');

  let chosen = null;   // { label, lat, lng }
  let busy = false;

  function openPanel() {
    panel.hidden = false;
    syncMineUi();
    setTimeout(() => qInput.focus(), 50);
  }

  function closePanel() {
    panel.hidden = true;
    hideResults();
    clearPending();
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }
  function clearError() { errorEl.hidden = true; }

  function hideResults() {
    resultsEl.hidden = true;
    resultsEl.innerHTML = '';
    qInput.setAttribute('aria-expanded', 'false');
  }

  function clearPending() {
    if (pendingMarker) { map.removeLayer(pendingMarker); pendingMarker = null; }
  }

  function setChosen(place) {
    chosen = place;
    chosenLabel.textContent = place.label;
    chosenEl.hidden = false;
    qInput.value = '';
    qInput.parentElement.hidden = true;
    hideResults();
    submitBtn.disabled = false;
    clearError();

    clearPending();
    pendingMarker = L.circleMarker([place.lat, place.lng], {
      radius: 9, className: 'pin-pending', renderer, bubblingMouseEvents: false,
    }).addTo(map);

    map.flyTo([place.lat, place.lng], Math.max(map.getZoom(), 5), { duration: 0.9 });
  }

  function unsetChosen() {
    chosen = null;
    chosenEl.hidden = true;
    qInput.parentElement.hidden = false;
    submitBtn.disabled = true;
    clearPending();
    qInput.focus();
  }

  function renderResults(items) {
    resultsEl.innerHTML = '';
    if (!items.length) {
      resultsEl.innerHTML =
        '<li class="empty">No match. Try a bigger nearby city, or close this and click the map.</li>';
      resultsEl.hidden = false;
      return;
    }
    for (const item of items) {
      const label = labelFromAddress(item);
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      const bits = label.split(', ');
      li.innerHTML =
        `<span class="place">${esc(bits[0])}</span>` +
        (bits.length > 1 ? ` <span class="region">${esc(bits.slice(1).join(', '))}</span>` : '');
      li.addEventListener('click', () =>
        setChosen({ label, lat: parseFloat(item.lat), lng: parseFloat(item.lon) })
      );
      resultsEl.appendChild(li);
    }
    resultsEl.hidden = false;
    qInput.setAttribute('aria-expanded', 'true');
  }

  const onType = debounce(async () => {
    const q = qInput.value.trim();
    if (q.length < 3) { hideResults(); return; }
    try {
      renderResults(await searchPlaces(q));
    } catch (err) {
      if (err.name !== 'AbortError') showError(err.message);
    }
  }, 450);

  /* --- Submit / remove -------------------------------------------------- */

  async function submit(e) {
    e.preventDefault();
    if (busy || !chosen) return;

    const name = $('name').value.trim();
    const note = $('note').value.trim();

    busy = true;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Adding…';
    clearError();

    const secret = uuid() + uuid();
    const pin = {
      id: uuid(),
      name: name || null,
      label: chosen.label,
      lat: chosen.lat,
      lng: chosen.lng,
      note: note || null,
      created_at: new Date().toISOString(),
    };

    try {
      await store.add(pin, secret);
      mine.set({ id: pin.id, secret, label: pin.label });

      pins.push(pin);
      clearPending();
      render();

      map.flyTo([pin.lat, pin.lng], Math.max(map.getZoom(), 5), { duration: 0.8 });
      toast('You’re on the map.');

      $('name').value = '';
      $('note').value = '';
      unsetChosen();
      syncMineUi();
    } catch (err) {
      showError(err.message || 'Something went wrong. Try again in a moment.');
      submitBtn.disabled = false;
    } finally {
      busy = false;
      submitBtn.textContent = 'Add my pin';
    }
  }

  async function removeMine() {
    const m = mine.get();
    if (!m) return;
    if (!confirm('Remove your pin from the map?')) return;
    try {
      await store.remove(m.id, m.secret);
      pins = pins.filter((p) => p.id !== m.id);
      mine.clear();
      render();
      syncMineUi();
      toast('Removed.');
    } catch (err) {
      toast(err.message || 'Could not remove that pin.', 4500);
    }
  }

  function syncMineUi() {
    const m = mine.get();
    const on = Boolean(m);
    $('mine').hidden = !on;
    if (on) $('mine-label').textContent = m.label;
    // Already pinned? Lead with that, but don't block a second entry.
    $('pin-form').hidden = false;
  }

  /* --- Map click = manual placement ------------------------------------- */

  map.on('click', async (e) => {
    const { lat, lng } = e.latlng;
    openPanel();
    chosenLabel.textContent = 'Looking up that spot…';
    chosenEl.hidden = false;
    qInput.parentElement.hidden = true;
    try {
      const item = await reverseGeocode(lat, lng);
      setChosen({ label: labelFromAddress(item), lat, lng });
    } catch {
      setChosen({ label: `${lat.toFixed(2)}, ${lng.toFixed(2)}`, lat, lng });
    }
  });

  /* --- Wire it up ------------------------------------------------------- */

  $('add-btn').addEventListener('click', openPanel);
  $('panel-close').addEventListener('click', closePanel);
  $('chosen-clear').addEventListener('click', unsetChosen);
  $('pin-form').addEventListener('submit', submit);
  $('remove-btn').addEventListener('click', removeMine);
  qInput.addEventListener('input', onType);

  qInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.preventDefault();      // don't submit mid-search
    if (e.key === 'Escape') hideResults();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) closePanel();
  });

  $('share-btn').addEventListener('click', async () => {
    const url = location.href.split('#')[0];
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) {
        await navigator.share({ title: CFG.title, url });
      } else {
        await navigator.clipboard.writeText(url);
        toast('Link copied. Send it to the class.');
      }
    } catch { toast(url, 6000); }
  });

  document.querySelector('.setup-dismiss').addEventListener('click', () => {
    $('setup-notice').hidden = true;
  });

  if (CFG.title) {
    document.querySelector('.topbar h1').textContent = CFG.title;
    document.title = CFG.title;
  }

  /* --- Load ------------------------------------------------------------- */

  async function load(quiet) {
    try {
      pins = await store.list();
      render();
    } catch (err) {
      if (!quiet) {
        $('tally').textContent = 'Could not reach the map data.';
        toast(err.message || 'Could not load pins.', 5000);
      }
    }
  }

  if (!REMOTE) $('setup-notice').hidden = false;

  load(false);
  syncMineUi();

  if (REMOTE && CFG.refreshMs > 0) {
    setInterval(() => { if (!document.hidden && !busy) load(true); }, CFG.refreshMs);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) load(true);
    });
  }
})();
