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

  /* Canvas letterSpacing is not universal yet, so space by hand. */
  function drawTracked(g, text, cx, cy, spacing) {
    const chars = Array.from(text);
    const widths = chars.map((ch) => g.measureText(ch).width + spacing);
    let x = cx - (widths.reduce((a, b) => a + b, 0) - spacing) / 2;
    for (let i = 0; i < chars.length; i++) {
      g.fillText(chars[i], x, cy);
      x += widths[i];
    }
  }

  const bezierAt = (c, t) => {
    const u = 1 - t;
    return [
      u * u * u * c[0] + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6],
      u * u * u * c[1] + 3 * u * u * t * c[3] + 3 * u * t * t * c[5] + t * t * t * c[7],
    ];
  };

  /* --- Framing ----------------------------------------------------------- */

  /* Pick centre and zoom that fit everything into the reference box. Leaflet's
     getBoundsZoom is tied to the live map's size, so this does it directly and
     keeps the fractional part: flooring to an integer zoom can waste up to half
     the frame. Tiles come from the integer below and get scaled to suit. */
  function frame(points, refW, refH, padding) {
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

    const fit = Math.min((refW - padding * 2) / w0, (refH - padding * 2) / h0);
    const zoom = Math.max(0, Math.min(18, Math.log2(fit)));
    return { center: bounds.getCenter(), zoom };
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

    const poster = opts.style === 'poster';
    const scale = opts.width / REF_WIDTH;
    const refW = REF_WIDTH;
    const refH = Math.round(opts.height / scale);

    canvas.width = opts.width;
    canvas.height = opts.height;
    const g = canvas.getContext('2d');
    g.scale(scale, scale);                 // everything below is in reference units

    const ink = token('--ink');
    const inkSoft = token('--ink-soft');
    const inkFaint = token('--ink-faint');
    const paper = token('--paper');
    const accent = theme.accent;

    g.fillStyle = token('--paper-warm');
    g.fillRect(0, 0, refW, refH);

    // Leave room for the poster's title band so pins never sit under it.
    const padTop = poster ? 132 : 70;
    const groups = app.groupPins(pins);
    const seeds = groups.map((gr) => [gr.lat, gr.lng]);
    if (flags.arcs && app.cfg.arcOrigin) {
      seeds.push([app.cfg.arcOrigin.lat, app.cfg.arcOrigin.lng]);
    }
    // Generous padding: a dot inside the frame can still carry a name that
    // isn't, and the solver's frame test can only choose among spots that fit.
    const view = frame(seeds, refW, refH - (padTop - 70), 132);

    const originRef = map.project(view.center, view.zoom).subtract([refW / 2, refH / 2]);
    const toPoint = (lat, lng) => {
      const p = map.project([lat, lng], view.zoom);
      return { x: p.x - originRef.x, y: p.y - originRef.y + (padTop - 70) / 2 };
    };

    opts.onProgress && opts.onProgress('Fetching tiles…');
    await drawTiles(g, view, refW, refH, theme.spec.base, opts.onProgress, 'Tiles');

    if (theme.spec.names) {
      g.save();
      g.globalAlpha = 0.42;                // matches the live map's labels pane
      await drawTiles(g, view, refW, refH, theme.spec.names, opts.onProgress, 'Place names');
      g.restore();
    }

    opts.onProgress && opts.onProgress('Drawing…');

    /* Arcs, under everything else, exactly as the pane order does on screen. */
    if (flags.arcs) {
      g.save();
      g.strokeStyle = accent;
      g.globalAlpha = 0.22;
      g.lineWidth = 1;
      for (const line of app.arcPaths()) {
        g.beginPath();
        line.forEach(([lat, lng], i) => {
          const p = toPoint(lat, lng);
          if (i === 0) g.moveTo(p.x, p.y); else g.lineTo(p.x, p.y);
        });
        g.stroke();
      }
      g.restore();
    }

    /* The ribbon reads as part of the composition, so it belongs on both
       styles — but only the poster is busy enough to carry it by default. */
    const ribbonOn = flags.ribbon || poster;
    const curve = app.ribbonCurve(refW, refH);

    if (ribbonOn) {
      g.save();
      g.strokeStyle = paper;
      g.globalAlpha = 0.62;
      g.lineWidth = 26;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(curve[0], curve[1]);
      g.bezierCurveTo(curve[2], curve[3], curve[4], curve[5], curve[6], curve[7]);
      g.stroke();
      g.restore();

      g.save();
      g.fillStyle = inkSoft;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      fitTextOnCurve(g, app.ribbonText(), curve);
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
    if (flags.names) {
      app.measureLabels();
      const reserved = ribbonOn ? ribbonBoxes(curve, refW) : [];
      const placements = app.solveLabels({
        items: app.getLabelItems(),
        toPoint: (lat, lng) => toPoint(lat, lng),
        width: refW,
        height: refH,
        margin: 40,
        bounds: 10,        // nothing may bleed off the edge of an image
        reserved,
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
        if (!pl.hidden) drawLabel(g, pl, { ink, inkFaint, paper, dark: theme.dark });
      }
    }

    if (poster) drawPosterChrome(g, refW, refH, groups, pins, { ink, inkSoft, inkFaint });
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

    g.fillStyle = colors.dark ? 'rgba(24,28,34,.88)' : 'rgba(255,255,255,.84)';
    roundRect(g, -w / 2, -h / 2, w, h, 7);
    g.fill();

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

  /* Walk the curve by arc length, setting each character on the local tangent. */
  function curveTable(curve, steps) {
    const table = [];
    let prev = bezierAt(curve, 0);
    let len = 0;
    table.push({ len: 0, p: prev });
    for (let i = 1; i <= steps; i++) {
      const p = bezierAt(curve, i / steps);
      len += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
      table.push({ len, p });
      prev = p;
    }
    return table;
  }

  function atLength(table, target) {
    let lo = 0, hi = table.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (table[mid].len < target) lo = mid; else hi = mid;
    }
    const a = table[lo], b = table[hi];
    const f = b.len === a.len ? 0 : (target - a.len) / (b.len - a.len);
    return {
      x: a.p[0] + (b.p[0] - a.p[0]) * f,
      y: a.p[1] + (b.p[1] - a.p[1]) * f,
      angle: Math.atan2(b.p[1] - a.p[1], b.p[0] - a.p[0]),
    };
  }

  /* Same rule as the live ribbon: start at 15px, shrink until the lettering
     fits the curve, so the tail never runs off the end of the band. */
  function fitTextOnCurve(g, text, curve) {
    const table = curveTable(curve, 500);
    const room = table[table.length - 1].len * 0.94;

    let size = 15;
    const spacingFor = (px) => px * 0.16;   // matches the .16em in the stylesheet
    const widthAt = (px) => {
      g.font = `italic ${px}px ${SERIF}`;
      return Array.from(text)
        .reduce((sum, ch) => sum + g.measureText(ch).width + spacingFor(px), 0);
    };

    const natural = widthAt(size);
    if (natural > room && room > 0) size = Math.max(7, size * (room / natural));
    g.font = `italic ${size}px ${SERIF}`;
    textOnCurve(g, text, table, spacingFor(size));
  }

  function textOnCurve(g, text, table, spacing) {
    const total = table[table.length - 1].len;
    const chars = Array.from(text);
    const widths = chars.map((ch) => g.measureText(ch).width + spacing);
    const textW = widths.reduce((a, b) => a + b, 0);

    let d = (total - textW) / 2;
    if (d < 0) d = 0;

    for (let i = 0; i < chars.length; i++) {
      const at = d + widths[i] / 2;
      if (at > total) break;
      const s = atLength(table, at);
      g.save();
      g.translate(s.x, s.y);
      g.rotate(s.angle);
      g.fillText(chars[i], 0, 0);
      g.restore();
      d += widths[i];
    }
  }

  function ribbonBoxes(curve, refW) {
    const boxes = [];
    const half = 20;
    for (let i = 0; i <= 14; i++) {
      const [x, y] = bezierAt(curve, i / 14);
      boxes.push({ x: x - refW / 28, y: y - half, w: refW / 14, h: half * 2 });
    }
    return boxes;
  }

  function drawPosterChrome(g, refW, refH, groups, pins, colors) {
    const places = groups.length;
    const people = pins.length;
    const when = new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

    g.save();
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';

    g.fillStyle = colors.ink;
    g.font = `600 44px ${SERIF}`;
    g.fillText(app.cfg.title || 'World Map', 56, 84);

    g.fillStyle = colors.inkSoft;
    g.font = `400 15px ${SANS}`;
    g.fillText(
      `${people} ${people === 1 ? 'person' : 'people'} · ` +
      `${places} ${places === 1 ? 'place' : 'places'} · ${when}`,
      58, 108
    );
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
