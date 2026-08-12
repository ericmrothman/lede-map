/* ---------------------------------------------------------------------------
   LEDE 2026 WORLD MAP — export the map as an image.

   The map on screen is a pile of DOM: tiles in one pane, marker divs in
   another, labels and SVG arrows in a third. None of that can be handed to a
   canvas directly, so this redraws the whole picture from the same data and,
   crucially, from the same label solver app.js uses. Duplicating the placement
   maths would guarantee the exported image slowly drifts away from the screen.

   It works at all because CARTO serves tiles with `access-control-allow-origin: *`,
   so they can be drawn into a canvas without tainting it and toBlob() still
   works. No html2canvas, no extra dependency. Every basemap variant also has
   @2x tiles, which is what keeps a 4K export from looking soft.

   app.js calls init() with a context object once the map exists.
--------------------------------------------------------------------------- */

window.LedeMapExport = (function () {
  'use strict';

  /* Composition is laid out at a fixed reference width and then scaled to
     whatever was asked for. Laying out at (output / 2) instead would crowd the
     labels at 1920 and strand them at 4K; pinning the reference means every
     preset is the same picture at a different resolution. */
  const REF_WIDTH = 1600;
  const TILE = 256;
  const MAX_TILES = 600;          // a mis-framed view must not fetch thousands
  const MARGIN = 0.22;            // air around the pins, as a fraction of each axis
  const ARC_ALPHA = 0.26;         // matches the live map
  const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif';
  const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Helvetica, Arial, sans-serif';

  let app = null;

  function init(context) { app = context; }

  /* --- Small helpers ----------------------------------------------------- */

  const token = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function loadImage(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';       // without this the canvas is tainted
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);   // a missing tile is a gap, not a failure
      img.src = url;
    });
  }

  async function pool(jobs, limit) {
    const results = new Array(jobs.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
      while (next < jobs.length) {
        const i = next++;
        results[i] = await jobs[i]();
      }
    });
    await Promise.all(workers);
    return results;
  }

  function roundRect(g, x, y, w, h, r) {
    if (g.roundRect) { g.beginPath(); g.roundRect(x, y, w, h, r); return; }
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  /* Canvas letterSpacing is not universal yet, so space by hand.

     This walks a cursor left to right, which only works under left alignment.
     Callers draw labels with textAlign 'center', and under that every glyph is
     re-centred on its own advance position — the line comes out shuffled, wide
     letters overlapping their neighbours. Force the alignment for the duration
     rather than relying on the caller to have set it. */
  function drawTracked(g, text, cx, cy, spacing) {
    const chars = Array.from(text);
    const widths = chars.map((ch) => g.measureText(ch).width + spacing);
    const previous = g.textAlign;
    g.textAlign = 'left';
    let x = cx - (widths.reduce((a, b) => a + b, 0) - spacing) / 2;
    for (let i = 0; i < chars.length; i++) {
      g.fillText(chars[i], x, cy);
      x += widths[i];
    }
    g.textAlign = previous;
  }

  /* --- Framing ----------------------------------------------------------- */

  /* Pick centre and zoom that fit everything into the reference box. Leaflet's
     getBoundsZoom is tied to the live map's size, so this does it directly and
     keeps the fractional part: flooring to an integer zoom can waste up to half
     the frame. Tiles come from the integer below and get scaled to suit.

     Centred on the middle of the pins' extent, which is what puts equal air
     above and below. Weighting toward the centre of mass was tried and looked
     wrong: most of the class is in the northern hemisphere, so the camera rode
     up and left the picture sitting high in the frame. Symmetry reads better
     than statistics here. */
  function frame(points, refW, refH, padX, padY) {
    const map = app.map;
    const lats = points.map((p) => p[0]);
    const lngs = points.map((p) => p[1]);
    const bounds = L.latLngBounds(
      [Math.min(...lats), Math.min(...lngs)],
      [Math.max(...lats), Math.max(...lngs)]
    );

    const nw = map.project(bounds.getNorthWest(), 0);
    const se = map.project(bounds.getSouthEast(), 0);
    const w0 = Math.max(Math.abs(se.x - nw.x), 1e-6);
    const h0 = Math.max(Math.abs(se.y - nw.y), 1e-6);

    const fit = Math.min((refW - padX * 2) / w0, (refH - padY * 2) / h0);
    const zoom = Math.max(0, Math.min(18, Math.log2(fit)));

    const projected = points.map((p) => map.project(p, zoom));
    const xs = projected.map((p) => p.x);
    const ys = projected.map((p) => p.y);

    return {
      center: map.unproject([
        (Math.min(...xs) + Math.max(...xs)) / 2,
        (Math.min(...ys) + Math.max(...ys)) / 2,
      ], zoom),
      zoom,
    };
  }

  /* --- Tiles ------------------------------------------------------------- */

  async function drawTiles(g, view, refW, refH, variant, onProgress, label) {
    const map = app.map;
    const tileZoom = Math.floor(view.zoom);
    const tileScale = Math.pow(2, view.zoom - tileZoom);
    const drawn = TILE * tileScale;

    // Origin expressed in the integer zoom's pixel space.
    const originRef = map.project(view.center, view.zoom)
      .subtract([refW / 2, refH / 2]);
    const originTZ = { x: originRef.x / tileScale, y: originRef.y / tileScale };

    const x0 = Math.floor(originTZ.x / TILE);
    const x1 = Math.floor((originTZ.x + refW / tileScale) / TILE);
    const y0 = Math.floor(originTZ.y / TILE);
    const y1 = Math.floor((originTZ.y + refH / tileScale) / TILE);

    const span = 1 << tileZoom;
    const jobs = [];
    const spots = [];

    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        if (y < 0 || y >= span) continue;             // no tiles past the poles
        const wrapped = ((x % span) + span) % span;   // but the world does wrap
        const sub = 'abcd'[Math.abs(x + y) % 4];
        const url =
          `https://${sub}.basemaps.cartocdn.com/${variant}/${tileZoom}/${wrapped}/${y}@2x.png`;
        jobs.push(() => loadImage(url));
        spots.push({
          x: (x * TILE - originTZ.x) * tileScale,
          y: (y * TILE - originTZ.y) * tileScale,
        });
      }
    }

    if (jobs.length > MAX_TILES) {
      throw new Error(`That view needs ${jobs.length} tiles — zoom out or pick a smaller size.`);
    }

    let done = 0;
    const wrapped = jobs.map((job) => async () => {
      const img = await job();
      done++;
      if (onProgress && done % 8 === 0) onProgress(`${label} ${done}/${jobs.length}…`);
      return img;
    });

    const images = await pool(wrapped, 8);
    images.forEach((img, i) => {
      if (!img) return;
      // +1 closes the hairline seams that rounding leaves between tiles.
      g.drawImage(img, spots[i].x, spots[i].y, drawn + 1, drawn + 1);
    });
  }

  /* --- The picture ------------------------------------------------------- */

  async function paint(canvas, opts) {
    const map = app.map;
    const flags = app.flags();
    const theme = app.getTheme();
    const pins = app.getPins();
    if (!pins.length) throw new Error('No pins to export yet.');

    const scale = opts.width / REF_WIDTH;
    const refW = REF_WIDTH;
    const refH = Math.round(opts.height / scale);

    canvas.width = opts.width;
    canvas.height = opts.height;
    const g = canvas.getContext('2d');
    g.scale(scale, scale);                 // everything below is in reference units

    const ink = token('--ink');
    const inkFaint = token('--ink-faint');
    const accent = theme.accent;

    g.fillStyle = token('--paper-warm');
    g.fillRect(0, 0, refW, refH);

    const groups = app.groupPins(pins);
    const seeds = groups.map((gr) => [gr.lat, gr.lng]);
    if (flags.arcs && app.cfg.arcOrigin) {
      seeds.push([app.cfg.arcOrigin.lat, app.cfg.arcOrigin.lng]);
    }
    /* Framed loose on purpose. A tight fit crops in to the pins and the result
       reads as a diagram; leaving this much air around them keeps the shape of
       the world in the picture, which is the point of the thing. It also gives
       every name somewhere to sit — a dot inside the frame can still carry a
       label that isn't, and the solver may only choose among spots that fit.

       The margin is a fraction of each axis, not a single number: a width-based
       pad applied to a 16:9 height eats most of the frame, and the pins end up
       a thin band across the middle. */
    const margin = typeof app.cfg.exportMargin === 'number' ? app.cfg.exportMargin : MARGIN;
    const view = frame(seeds, refW, refH, refW * margin, refH * margin);

    const originRef = map.project(view.center, view.zoom).subtract([refW / 2, refH / 2]);
    const toPoint = (lat, lng) => {
      const p = map.project([lat, lng], view.zoom);
      return { x: p.x - originRef.x, y: p.y - originRef.y };
    };

    opts.onProgress && opts.onProgress('Fetching tiles…');
    await drawTiles(g, view, refW, refH, theme.spec.base, opts.onProgress, 'Tiles');

    /* Deliberately no place-name tiles. At export scale CARTO's continent and
       country lettering is set enormous — it reads as the subject of the image
       rather than as orientation, and it fights the people's names, which are
       the actual subject. The land keeps its shape; only the shouting goes. */

    opts.onProgress && opts.onProgress('Drawing…');

    /* Arcs, under everything else, exactly as the pane order does on screen. */
    if (flags.arcs) {
      g.save();
      g.strokeStyle = accent;
      g.lineWidth = 1;
      g.lineCap = 'round';
      // Each run carries its own opacity: full strength away from the seam,
      // falling to nothing as it approaches the edge of the sheet.
      for (const run of app.arcPaths()) {
        g.globalAlpha = ARC_ALPHA * run.alpha;
        g.beginPath();
        run.points.forEach(([lat, lng], i) => {
          const p = toPoint(lat, lng);
          if (i === 0) g.moveTo(p.x, p.y); else g.lineTo(p.x, p.y);
        });
        g.stroke();
      }
      g.restore();
    }

    /* Dots. */
    for (const gr of groups) {
      const p = toPoint(gr.lat, gr.lng);
      const r = app.dotRadius(gr.entries.length);
      g.beginPath();
      g.arc(p.x, p.y, r, 0, Math.PI * 2);
      g.fillStyle = accent;
      g.globalAlpha = 0.82;
      g.fill();
      g.globalAlpha = 1;
      g.lineWidth = 2;
      g.strokeStyle = theme.dark ? token('--paper-warm') : '#ffffff';
      g.stroke();
    }

    /* Labels, through the very same solver the live map runs. */
    {
      app.measureLabels();
      const placements = app.solveLabels({
        items: app.getLabelItems(),
        toPoint: (lat, lng) => toPoint(lat, lng),
        width: refW,
        height: refH,
        margin: 40,
        bounds: 10,        // nothing may bleed off the edge of an image
      });

      // Arrows first: a tether belongs behind the name it points at.
      g.save();
      g.strokeStyle = accent;
      g.globalAlpha = 0.62;
      g.lineWidth = 1.3;
      g.lineCap = 'round';
      for (const pl of placements) {
        if (pl.hidden || !pl.arrow) continue;
        const a = pl.arrow;
        g.beginPath();
        g.moveTo(a.sx, a.sy);
        g.quadraticCurveTo(a.cx, a.cy, a.ex, a.ey);
        g.stroke();
        arrowHead(g, a);
      }
      g.restore();

      for (const pl of placements) {
        if (!pl.hidden) drawLabel(g, pl, { ink, inkFaint, dark: theme.dark });
      }
    }

    drawCredit(g, refW, refH, inkFaint);

    return canvas;
  }

  function arrowHead(g, a) {
    // Tangent at the end of a quadratic is the control-to-end direction.
    const ang = Math.atan2(a.ey - a.cy, a.ex - a.cx);
    const len = 5, spread = 0.42;
    g.beginPath();
    g.moveTo(a.ex - len * Math.cos(ang - spread), a.ey - len * Math.sin(ang - spread));
    g.lineTo(a.ex, a.ey);
    g.lineTo(a.ex - len * Math.cos(ang + spread), a.ey - len * Math.sin(ang + spread));
    g.stroke();
  }

  function drawLabel(g, pl, colors) {
    const { who, city } = pl.item;
    const w = pl.w, h = pl.h;

    g.save();
    g.translate(pl.x + w / 2, pl.y + h / 2);
    g.rotate((pl.tilt * Math.PI) / 180);

    /* Shadow the card, then clear it before any text: a shadow left switched on
       would be applied to every glyph as well and turn the lettering muddy. */
    g.save();
    g.shadowColor = colors.dark ? 'rgba(0,0,0,.45)' : 'rgba(16,18,22,.22)';
    g.shadowBlur = 4;
    g.shadowOffsetY = 1.5;
    g.fillStyle = colors.dark ? 'rgba(24,28,34,.88)' : 'rgba(255,255,255,.84)';
    roundRect(g, -w / 2, -h / 2, w, h, 7);
    g.fill();
    g.restore();

    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const top = -h / 2 + 2;

    if (who) {
      g.fillStyle = colors.ink;
      g.font = `600 12.5px ${SERIF}`;
      g.fillText(who, 0, top + 7.5);
      if (city) {
        g.fillStyle = colors.inkFaint;
        g.font = `500 9.5px ${SANS}`;
        drawTracked(g, city.toUpperCase(), 0, top + 15 + 5.7, 0.38);
      }
    } else if (city) {
      // A place with nobody named shouldn't shout — matches :only-child in CSS.
      g.fillStyle = colors.dark ? colors.ink : '#5b6169';
      g.font = `600 12px ${SERIF}`;
      g.fillText(city, 0, 0);
    }

    g.restore();
  }

  function drawCredit(g, refW, refH, faint) {
    g.save();
    g.textAlign = 'right';
    g.textBaseline = 'alphabetic';
    g.fillStyle = faint;
    g.font = `400 10px ${SANS}`;
    g.fillText('© OpenStreetMap contributors · Basemap CARTO', refW - 14, refH - 12);
    g.restore();
  }

  /* --- Public API -------------------------------------------------------- */

  async function download(opts) {
    if (!app) throw new Error('Exporter was never initialised.');
    const canvas = document.createElement('canvas');
    await paint(canvas, opts);

    opts.onProgress && opts.onProgress('Encoding…');
    const blob = await new Promise((resolve, reject) => {
      try {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image.'))), 'image/png');
      } catch (err) {
        // Only reachable if a tile ever stops sending CORS headers.
        reject(new Error('The image could not be saved because a map tile blocked it.'));
      }
    });

    const slug = (app.cfg.title || 'world-map').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${slug}-${opts.width}x${opts.height}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return blob;
  }

  return { init, download, paint, _refWidth: REF_WIDTH };
})();
