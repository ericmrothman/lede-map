/* ---------------------------------------------------------------------------
   LEDE 2026 WORLD MAP — a shared class map.

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
    { supabaseUrl: '', supabaseKey: '', title: 'LEDE 2026 WORLD MAP', refreshMs: 12000 },
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

    async update(id, patch, secret) {
      const res = await fetch(
        `${CFG.supabaseUrl}/rest/v1/pins?id=eq.${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          headers: {
            apikey: CFG.supabaseKey,
            Authorization: `Bearer ${CFG.supabaseKey}`,
            'Content-Type': 'application/json',
            'X-Pin-Secret': secret,
            Prefer: 'return=minimal',
          },
          body: JSON.stringify(patch),
        }
      );
      if (!res.ok) throw new Error(await describeError(res, 'edit'));
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
    async update(id, patch) {
      const all = (await localStore.list()).map((p) => (p.id === id ? Object.assign({}, p, patch) : p));
      localStorage.setItem(DEMO_KEY, JSON.stringify(all));
    },
    async remove(id) {
      const all = (await localStore.list()).filter((p) => p.id !== id);
      localStorage.setItem(DEMO_KEY, JSON.stringify(all));
    },
  };

  const store = REMOTE ? remoteStore : localStore;

  async function describeError(res, op) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body.message || body.hint || body.details || '';
    } catch { /* non-JSON error body */ }
    if (res.status === 401 || res.status === 403) {
      return op === 'edit'
        ? 'The database will not accept edits yet — run supabase-migration-edit.sql in the Supabase SQL Editor.'
        : 'The database rejected that. Check the anon key and the security policies.';
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
  // Held well back: the basemap's country and city names are orientation, not
  // content. The people are the content, and they compete for the same pixels.
  map.getPane('labels').style.opacity = '0.42';

  L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png',
    { subdomains: 'abcd', maxZoom: 18, pane: 'labels' }
  ).addTo(map);

  const renderer = L.svg({ padding: 0.5 });
  const pinLayer = L.layerGroup().addTo(map);
  let pendingMarker = null;
  let pins = [];
  let hasFitOnce = false;
  let showNames = localStorage.getItem('wwf:names') !== 'off';

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
    const m = mine.get();
    const items = group.entries
      .map((p) => {
        const who = p.name
          ? `<span class="popup-name">${esc(p.name)}</span>`
          : '<span class="popup-anon">someone</span>';
        const note = p.note ? `<span class="popup-note">${esc(p.note)}</span>` : '';
        // Only your own row, and only in the browser holding its secret —
        // the database enforces the same rule regardless of what's rendered.
        const edit = m && m.id === p.id
          ? `<button type="button" class="popup-edit" data-pin="${esc(p.id)}">Edit</button>`
          : '';
        return `<li><span class="popup-row">${who}${edit}</span>${note}</li>`;
      })
      .join('');
    const count = group.entries.length;
    const heading = count > 1
      ? `${esc(place)} <span style="color:var(--ink-faint);font-weight:400">&middot; ${count}</span>`
      : esc(place);
    return `<p class="popup-place">${heading}</p><ul class="popup-list">${items}</ul>`;
  }

  /* --- Name labels ------------------------------------------------------ */
  /* Leaflet's permanent tooltips sit wherever they're told and happily stack
     on top of each other, which is useless once two classmates live near one
     another. So labels are their own overlay: measured once, resolved against
     each other in screen space every time the view moves, and tethered back
     to their dot with a curved arrow whenever they had to travel to find room.

     Everything here is deterministic — the tilt and the bow of each arrow come
     from a hash of the label text, so a given person's label looks the same on
     every reload rather than reshuffling under them. */

  const SVGNS = 'http://www.w3.org/2000/svg';
  const ARROW_DEFS =
    '<defs><marker id="lbl-arrow" viewBox="0 0 8 8" refX="6.5" refY="4" ' +
    'markerWidth="5" markerHeight="5" orient="auto">' +
    '<path d="M0.6 0.9 L6.6 4 L0.6 7.1" fill="none" stroke="currentColor" ' +
    'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</marker></defs>';

  const labelLayer = document.createElement('div');
  labelLayer.className = 'label-layer';
  map.getContainer().appendChild(labelLayer);

  const arrowSvg = document.createElementNS(SVGNS, 'svg');
  arrowSvg.setAttribute('class', 'label-arrows');
  arrowSvg.innerHTML = ARROW_DEFS;
  labelLayer.appendChild(arrowSvg);

  let labelItems = [];

  const dotRadius = (n) => 6 + Math.min(11, 3.2 * Math.sqrt(n - 1));

  /* Stable value in [-1, 1] from a string — same label, same tilt, every load. */
  function seedOf(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return (Math.abs(h % 2000) / 1000) - 1;
  }

  function labelParts(group) {
    const named = group.entries.map((e) => e.name).filter(Boolean);
    const anon = group.entries.length - named.length;
    const city = String(group.entries[0].label || '').split(',')[0].trim();
    if (!named.length) return { who: '', city };
    const shown = named.slice(0, 2);
    const extra = (named.length - shown.length) + anon;
    return { who: shown.join(' & ') + (extra > 0 ? ` +${extra}` : ''), city };
  }

  function buildLabels(groups) {
    for (const it of labelItems) it.el.remove();
    labelItems = [];
    if (!showNames) return;

    for (const g of groups) {
      const { who, city } = labelParts(g);
      if (!who && !city) continue;
      const el = document.createElement('div');
      el.className = 'pin-label';
      el.innerHTML =
        (who ? `<span class="pin-label-who">${esc(who)}</span>` : '') +
        (city ? `<span class="pin-label-city">${esc(city)}</span>` : '');
      labelLayer.appendChild(el);
      labelItems.push({
        el,
        lat: g.lat,
        lng: g.lng,
        radius: dotRadius(g.entries.length),
        seed: seedOf(who + city),
        w: el.offsetWidth,
        h: el.offsetHeight,
      });
    }
  }

  const GAP = 4;
  const TILT_NEAR = 2.5;   // degrees, for a label sitting right next to its dot
  const TILT_FAR = 9;      // a displaced label leans harder — reads as deliberate

  const hits = (a, b) =>
    !(a.x + a.w + GAP < b.x || b.x + b.w + GAP < a.x ||
      a.y + a.h + GAP < b.y || b.y + b.h + GAP < a.y);

  /* Footprint of a w×h label tilted by `deg`, centred on (cx, cy). Testing the
     flat rectangle is what let tilted neighbours clip each other. */
  function tiltedBox(cx, cy, w, h, deg) {
    const rad = Math.abs(deg) * Math.PI / 180;
    const c = Math.cos(rad), sn = Math.sin(rad);
    const bw = w * c + h * sn;
    const bh = w * sn + h * c;
    return { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh };
  }

  /* Where a ray leaving a box's centre crosses its edge. */
  function edgeOfBox(cx, cy, w, h, ux, uy, pad) {
    const hw = w / 2 + pad, hh = h / 2 + pad;
    const t = Math.min(
      ux === 0 ? Infinity : hw / Math.abs(ux),
      uy === 0 ? Infinity : hh / Math.abs(uy)
    );
    return [cx + ux * t, cy + uy * t];
  }

  function layoutLabels() {
    if (!labelItems.length) return;

    const size = map.getSize();
    arrowSvg.setAttribute('viewBox', `0 0 ${size.x} ${size.y}`);
    for (const old of arrowSvg.querySelectorAll('path.label-arrow')) old.remove();

    const items = labelItems.map((it) => {
      const pt = map.latLngToContainerPoint([it.lat, it.lng]);
      if (!it.w) { it.w = it.el.offsetWidth; it.h = it.el.offsetHeight; }
      return Object.assign({}, it, { pt });
    });

    /* Reserve the dots first so a label never covers somebody's pin, then work
       top-down so the resolved layout is stable instead of order-of-arrival. */
    const taken = items.map((it) => ({
      x: it.pt.x - it.radius, y: it.pt.y - it.radius,
      w: it.radius * 2, h: it.radius * 2,
    }));
    items.sort((a, b) => a.pt.y - b.pt.y);

    for (const it of items) {
      const { pt, w, h, radius: r } = it;

      // Off-screen labels cost nothing to skip and would clutter the edges.
      if (pt.x < -200 || pt.y < -200 || pt.x > size.x + 200 || pt.y > size.y + 200) {
        it.el.style.display = 'none';
        continue;
      }
      it.el.style.display = '';

      const spots = [
        { x: pt.x + r + 9,         y: pt.y - h / 2,     far: false },
        { x: pt.x - r - 9 - w,     y: pt.y - h / 2,     far: false },
        { x: pt.x - w / 2,         y: pt.y - r - 7 - h, far: false },
        { x: pt.x - w / 2,         y: pt.y + r + 7,     far: false },
      ];
      // Nothing adjacent worked — spiral outward, and accept a tether. Small
      // steps keep a bumped label near its dot instead of stranding it at sea.
      for (let ring = 1; ring <= 9; ring++) {
        const dist = r + 24 + ring * 17;
        for (let k = 0; k < 16; k++) {
          const ang = (k / 16) * Math.PI * 2 + it.seed * 0.6;
          spots.push({
            x: pt.x + Math.cos(ang) * dist - w / 2,
            y: pt.y + Math.sin(ang) * dist - h / 2,
            far: true,
          });
        }
      }

      let spot = spots[0];
      let box = tiltedBox(spot.x + w / 2, spot.y + h / 2, w, h, it.seed * TILT_FAR);
      for (const c of spots) {
        const t = it.seed * (c.far ? TILT_FAR : TILT_NEAR);
        const b = tiltedBox(c.x + w / 2, c.y + h / 2, w, h, t);
        if (taken.every((o) => !hits(b, o))) { spot = c; box = b; break; }
      }
      taken.push(box);

      const tilt = it.seed * (spot.far ? TILT_FAR : TILT_NEAR);
      it.el.style.transform =
        `translate(${Math.round(spot.x)}px, ${Math.round(spot.y)}px) rotate(${tilt.toFixed(2)}deg)`;

      if (!spot.far) continue;

      const lx = spot.x + w / 2, ly = spot.y + h / 2;
      const dx = pt.x - lx, dy = pt.y - ly;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const [sx, sy] = edgeOfBox(lx, ly, w, h, ux, uy, 4);
      const ex = pt.x - ux * (r + 5);
      const ey = pt.y - uy * (r + 5);
      const bow = Math.min(len * 0.22, 26) * (it.seed >= 0 ? 1 : -1);
      const cx = (sx + ex) / 2 - uy * bow;
      const cy = (sy + ey) / 2 + ux * bow;

      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('class', 'label-arrow');
      path.setAttribute('d', `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`);
      path.setAttribute('marker-end', 'url(#lbl-arrow)');
      arrowSvg.appendChild(path);
    }
  }

  map.on('move zoom viewreset resize', layoutLabels);

  function render() {
    pinLayer.clearLayers();
    const groups = groupPins(pins);

    for (const g of groups) {
      const n = g.entries.length;
      const marker = L.circleMarker([g.lat, g.lng], {
        radius: dotRadius(n),
        className: 'pin-dot',
        renderer,
        bubblingMouseEvents: false,   // clicking a pin must not also drop a new one
      }).bindPopup(popupHtml(g), { closeButton: false, maxWidth: 260 });

      // With labels on, a hover tooltip would only repeat what's already there.
      if (!showNames) {
        marker.bindTooltip(
          n > 1 ? `${g.entries[0].label} · ${n}` : g.entries[0].label,
          { direction: 'top', offset: [0, -dotRadius(n) - 2] }
        );
      }

      marker.addTo(pinLayer);
    }

    buildLabels(groups);
    layoutLabels();
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

  let chosen = null;      // { label, lat, lng }
  let busy = false;
  let editingId = null;   // set while amending an existing entry

  function openPanel() {
    panel.hidden = false;
    syncMineUi();
    setTimeout(() => qInput.focus(), 50);
  }

  function closePanel() {
    panel.hidden = true;
    hideResults();
    clearPending();
    if (editingId) stopEdit();
  }

  /* One panel does both jobs; this keeps its wording honest about which. */
  function syncMode() {
    const editing = Boolean(editingId);
    $('panel-title').textContent = editing ? 'Edit your entry' : 'Put yourself on the map';
    submitBtn.textContent = editing ? 'Save changes' : 'Add my pin';
    $('cancel-edit').hidden = !editing;
    $('mine').hidden = editing || !mine.get();
  }

  function startEdit(pinId) {
    const m = mine.get();
    const pin = pins.find((p) => p.id === pinId);
    if (!pin || !m || m.id !== pin.id) return;

    editingId = pin.id;
    map.closePopup();
    panel.hidden = false;
    clearError();
    $('name').value = pin.name || '';
    $('note').value = pin.note || '';
    setChosen({ label: pin.label, lat: +pin.lat, lng: +pin.lng });
    syncMode();
  }

  function stopEdit() {
    editingId = null;
    $('name').value = '';
    $('note').value = '';
    unsetChosen();
    clearError();
    syncMode();
    syncMineUi();
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
        '<li class="empty">No match. Try a bigger nearby city, or click your spot on the map.</li>';
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
    submitBtn.textContent = editingId ? 'Saving…' : 'Adding…';
    clearError();

    const fields = {
      name: name || null,
      label: chosen.label,
      lat: chosen.lat,
      lng: chosen.lng,
      note: note || null,
    };

    try {
      if (editingId) {
        const m = mine.get();
        await store.update(editingId, fields, m && m.secret);
        mine.set({ id: editingId, secret: m.secret, label: fields.label });

        const i = pins.findIndex((p) => p.id === editingId);
        if (i >= 0) pins[i] = Object.assign({}, pins[i], fields);
        clearPending();
        stopEdit();
        render();
        map.flyTo([fields.lat, fields.lng], Math.max(map.getZoom(), 5), { duration: 0.8 });
        toast('Updated.');
      } else {
        const secret = uuid() + uuid();
        const pin = Object.assign({ id: uuid(), created_at: new Date().toISOString() }, fields);
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
      }
    } catch (err) {
      showError(err.message || 'Something went wrong. Try again in a moment.');
      submitBtn.disabled = false;
    } finally {
      busy = false;
      submitBtn.textContent = editingId ? 'Save changes' : 'Add my pin';
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
  /* Placing by click is a mode, not the map's default response. It is armed
     only while the panel is open and no city has been chosen yet. Before,
     any stray click dropped a pin — so dismissing a popup started an entry,
     which is both surprising and tedious to back out of. */

  let popupIsOpen = false;
  let popupWasOpen = false;
  map.on('popupopen', () => { popupIsOpen = true; });
  map.on('popupclose', () => { popupIsOpen = false; });
  // Leaflet closes the popup on 'preclick', before 'click' — so record the
  // state here, while it is still true.
  map.on('preclick', () => { popupWasOpen = popupIsOpen; });

  map.on('click', async (e) => {
    if (popupWasOpen) { popupWasOpen = false; return; }  // that click only dismissed a popup
    if (panel.hidden || chosen) return;                  // not in "pick a spot" mode

    const { lat, lng } = e.latlng;
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

  function syncNamesBtn() {
    $('names-btn').textContent = showNames ? 'Hide names' : 'Show names';
    $('names-btn').setAttribute('aria-pressed', String(showNames));
  }

  $('names-btn').addEventListener('click', () => {
    showNames = !showNames;
    localStorage.setItem('wwf:names', showNames ? 'on' : 'off');
    syncNamesBtn();
    render();
  });
  syncNamesBtn();

  map.getContainer().addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('.popup-edit');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    startEdit(btn.dataset.pin);
  });

  $('cancel-edit').addEventListener('click', () => { stopEdit(); closePanel(); });

  $('add-btn').addEventListener('click', () => { if (editingId) stopEdit(); openPanel(); });
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
  syncMode();

  if (REMOTE && CFG.refreshMs > 0) {
    setInterval(() => { if (!document.hidden && !busy) load(true); }, CFG.refreshMs);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) load(true);
    });
  }
})();
