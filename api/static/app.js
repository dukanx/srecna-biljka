/* Srećna biljka — PWA dashboard logika */

const REFRESH_MS = 30000; // ESP32 šalje na 30s

// ── ikonice ──────
const ICON_PATHS = {
  bell: '<path d="M12 2.6a5.6 5.6 0 0 0-5.6 5.6v3.3L4.9 15a.9.9 0 0 0 .8 1.3h12.6a.9.9 0 0 0 .8-1.3l-1.5-3.5V8.2A5.6 5.6 0 0 0 12 2.6Z"/><path d="M9.6 18.1a2.5 2.5 0 0 0 4.8 0Z"/>',
  "bell-off": '<path d="M6.6 11.7V8.4a5.4 5.4 0 0 1 9.5-3.5m.9 3.9v2.9l1.5 3.4H8.1"/><path d="M9.7 18.2a2.4 2.4 0 0 0 4.6 0"/><path d="M3.6 3.4 20.4 20.6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
};

// Zvonce je popunjeno kad je uključeno, a linijsko kad nije.
function icon(name) {
  const filled = name === "bell";
  return `<svg viewBox="0 0 24 24" fill="${filled ? "currentColor" : "none"}" ` +
         `stroke="${filled ? "none" : "currentColor"}" stroke-width="1.7" ` +
         `stroke-linecap="round">${ICON_PATHS[name] || ""}</svg>`;
}

// ── Konfiguracija senzora: ikonica, jedinica, opseg, zone, ideal ──
// zone: [od, do, nivo]  (nivo: good | warn | bad) — pokrivaju ceo domain
const SENSORS = {
  soil_humidity: {
    label: "Vlažnost tla", unit: "%",
    domain: [0, 100],
    zones: [[0, 30, "bad"], [30, 40, "warn"], [40, 70, "good"], [70, 100, "warn"]],
    ideal: "ideal 40–70%",
  },
  temperature_humidity: {
    label: "Temperatura", unit: "°C",
    domain: [0, 40],
    zones: [[0, 10, "bad"], [10, 18, "warn"], [18, 26, "good"], [26, 30, "warn"], [30, 40, "bad"]],
    ideal: "ideal 18–26 °C",
  },
  co2: {
    label: "CO₂", unit: "ppm",
    domain: [400, 1600],
    zones: [[400, 1000, "good"], [1000, 1200, "warn"], [1200, 1600, "bad"]],
    ideal: "ideal 400–1000 ppm",
  },
  // Zalivanje nije merenje nego dogadjaj: nema opseg ni idealnu vrednost,
  // pa mu kartica ide bez trake sa zonama, a grafik se preskace.
  pump: {
    label: "Zalivanje", unit: "s", event: true,
  },
  light: {
    label: "Svetlost", unit: "lux",
    domain: [0, 1500],
    zones: [[0, 200, "bad"], [200, 500, "warn"], [500, 1500, "good"]],
    ideal: "ideal ≥ 500 lux",
  },
};

const STATE_LABEL = { happy: "Srećna", thirsty: "Žedna", sleepy: "Pospana", angry: "Ljuta", night: "Spava" };


// ── Pomoćne ────────────────────────────────────────────────────
function setStatus(msg, level) {
  document.getElementById("status-text").textContent = msg;
  const dot = document.getElementById("status-dot");
  dot.className = "status-dot" + (level ? " " + level : "");
}

function fmtTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("sr-RS", { hour: "2-digit", minute: "2-digit" });
}

function sensorMeta(type) {
  const base = SENSORS[type] || { label: type, unit: "", domain: [0, 1], zones: [[0, 1, "good"]], ideal: "" };
  const fromProfile = zonesFor(type, activeProfile);
  return fromProfile ? Object.assign({}, base, fromProfile) : base;
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function levelFor(cfg, value) {
  for (const [from, to, level] of cfg.zones) {
    if (value >= from && value < to) return level;
  }
  return value < cfg.domain[0] ? cfg.zones[0][2] : cfg.zones[cfg.zones.length - 1][2];
}


// ── Tema ───────────────────────────────────────────────────────
// Tri stanja: bez zapamćenog izbora vlada sistemska tema, a izbor je
// pamti u pregledaču i nadjačava je preko data-theme atributa.
const THEME_BG = { light: "#EDF1E8", dark: "#080B09" };

function savedTheme() {
  try {
    const t = localStorage.getItem("theme");
    return t === "light" || t === "dark" ? t : null;
  } catch (e) {
    return null;
  }
}

function effectiveTheme() {
  return savedTheme() || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}

function applyTheme() {
  const chosen = savedTheme();
  const root = document.documentElement;
  if (chosen) root.setAttribute("data-theme", chosen);
  else root.removeAttribute("data-theme");

  // Boja trake pregledača ne prati media upit kad je tema izabrana ručno.
  const eff = effectiveTheme();
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
  const meta = document.createElement("meta");
  meta.name = "theme-color";
  meta.content = THEME_BG[eff];
  document.head.appendChild(meta);

  const btn = document.getElementById("theme-btn");
  if (btn) {
    btn.innerHTML = icon(eff === "dark" ? "sun" : "moon");
    btn.title = eff === "dark" ? "Svetla tema" : "Tamna tema";
  }
}

function toggleTheme() {
  try {
    localStorage.setItem("theme", effectiveTheme() === "dark" ? "light" : "dark");
  } catch (e) {}
  applyTheme();
}

// ── Lice ───────────────────────────────────────────────────────
// Ista geometrija kao drawFace() u sketch/sketch.ino. Ako se tamo menjaju
// openness ili mouthCurve, prenesi izmene i ovde da se ekrani ne raziđu.
// Gornjih 16 redova panela je fizički žuto, ostatak plav; to se ovde
// reprodukuje da bi slika na telefonu odgovarala staklu na uređaju.

const OLED_W = 128, OLED_H = 64, YELLOW_ROWS = 16;

const FACES = {
  happy:   { openness: 1.0, curve:  3.0, brows: null,   drop: false },
  thirsty: { openness: 0.7, curve: -2.5, brows: "up",   drop: true  },
  sleepy:  { closed: true,  curve:  0.5, brows: null,   drop: false },
  angry:   { openness: 0.6, curve: -2.5, brows: "down", drop: false },
  night:   { closed: true,  curve:  1.5, brows: null,   drop: false, zzz: true },
};

function fbNew() { return new Uint8Array(OLED_W * OLED_H); }

function fbPx(fb, x, y) {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= OLED_W || y >= OLED_H) return;
  fb[y * OLED_W + x] = 1;
}
function fbVLine(fb, x, y, h) { for (let i = 0; i < h; i++) fbPx(fb, x, y + i); }
function fbRect(fb, x, y, w, h) { for (let i = 0; i < w; i++) fbVLine(fb, x + i, y, h); }

function fbLine(fb, x0, y0, x1, y1) {
  x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
  const steep = Math.abs(y1 - y0) > Math.abs(x1 - x0);
  let t;
  if (steep) { t = x0; x0 = y0; y0 = t; t = x1; x1 = y1; y1 = t; }
  if (x0 > x1) { t = x0; x0 = x1; x1 = t; t = y0; y0 = y1; y1 = t; }
  const dx = x1 - x0, dy = Math.abs(y1 - y0), ystep = y0 < y1 ? 1 : -1;
  let err = dx / 2;
  for (; x0 <= x1; x0++) {
    if (steep) fbPx(fb, y0, x0); else fbPx(fb, x0, y0);
    err -= dy;
    if (err < 0) { y0 += ystep; err += dx; }
  }
}

// Adafruit fillCircleHelper: 1 = desna polovina, 2 = leva
function fbCircleHelper(fb, x0, y0, r, corners, delta) {
  let f = 1 - r, ddF_x = 1, ddF_y = -2 * r, x = 0, y = r, px = x, py = y;
  delta++;
  while (x < y) {
    if (f >= 0) { y--; ddF_y += 2; f += ddF_y; }
    x++; ddF_x += 2; f += ddF_x;
    if (x < y + 1) {
      if (corners & 1) fbVLine(fb, x0 + x, y0 - y, 2 * y + delta);
      if (corners & 2) fbVLine(fb, x0 - x, y0 - y, 2 * y + delta);
    }
    if (y !== py) {
      if (corners & 1) fbVLine(fb, x0 + py, y0 - px, 2 * px + delta);
      if (corners & 2) fbVLine(fb, x0 - py, y0 - px, 2 * px + delta);
      py = y;
    }
    px = x;
  }
}

function fbRoundRect(fb, x, y, w, h, r) {
  const maxR = Math.min(w, h) / 2;
  if (r > maxR) r = maxR;
  fbRect(fb, x + r, y, w - 2 * r, h);
  fbCircleHelper(fb, x + w - r - 1, y + r, r, 1, h - 2 * r - 1);
  fbCircleHelper(fb, x + r, y + r, r, 2, h - 2 * r - 1);
}

function fbCircle(fb, x0, y0, r) {
  fbVLine(fb, x0, y0 - r, 2 * r + 1);
  fbCircleHelper(fb, x0, y0, r, 3, 0);
}

function fbTriangle(fb, x0, y0, x1, y1, x2, y2) {
  const minY = Math.min(y0, y1, y2), maxY = Math.max(y0, y1, y2);
  const minX = Math.min(x0, x1, x2), maxX = Math.max(x0, x1, x2);
  const d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
  if (d === 0) return;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const a = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / d;
      const b = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / d;
      if (a >= -0.02 && b >= -0.02 && 1 - a - b >= -0.02) fbPx(fb, x, y);
    }
  }
}

function drawEye(fb, cx, cy, r, openness) {
  const halfH = Math.max(1, Math.floor(r * openness));
  fbRoundRect(fb, cx - r, cy - halfH, r * 2, halfH * 2, Math.min(r, halfH));
}

function drawEyebrow(fb, cx, cy, width, innerUp, isLeft) {
  const outerY = innerUp ? cy + 4 : cy - 2;
  const innerY = innerUp ? cy - 2 : cy + 4;
  fbLine(fb, cx - width / 2, isLeft ? outerY : innerY,
             cx + width / 2, isLeft ? innerY : outerY);
}

// Parabola, koristi se i za usta i za zatvorene oci.
function drawArc(fb, cx, cy, halfWidth, curve) {
  let prevX = cx - halfWidth;
  let prevY = cy - Math.trunc(curve * 3);
  for (let x = -halfWidth + 1; x <= halfWidth; x++) {
    const t = x / halfWidth;
    const y = cy - Math.trunc(curve * t * t * 3);
    fbLine(fb, prevX, prevY, cx + x, y);
    prevX = cx + x;
    prevY = y;
  }
}

function drawDrop(fb, cx, cy) {
  fbTriangle(fb, cx, cy - 6, cx - 4, cy + 2, cx + 4, cy + 2);
  fbCircle(fb, cx, cy + 3, 4);
}

// Slovo z iz tri poteza, jer platno nema font kao Adafruit GFX.
function drawZ(fb, x, y, size) {
  fbLine(fb, x, y, x + size, y);
  fbLine(fb, x + size, y, x, y + size);
  fbLine(fb, x, y + size, x + size, y + size);
}

function buildFace(state, blink) {
  const f = FACES[state];
  if (!f) return null;

  const fb = fbNew();
  const eyeY = 24, eyeR = 12, leftX = 40, rightX = 88;
  const closed = f.closed && !blink;

  if (closed) {
    drawArc(fb, leftX, eyeY, 11, 2.0);
    drawArc(fb, rightX, eyeY, 11, 2.0);
  } else {
    const openness = blink ? 0.08 : f.openness;
    drawEye(fb, leftX, eyeY, eyeR, openness);
    drawEye(fb, rightX, eyeY, eyeR, openness);
  }

  if (f.brows && !blink) {
    const browY = eyeY - eyeR - 6;
    drawEyebrow(fb, leftX, browY, 16, f.brows === "up", true);
    drawEyebrow(fb, rightX, browY, 16, f.brows === "up", false);
  }

  drawArc(fb, 64, 52, 20, f.curve);
  if (f.drop && !blink) drawDrop(fb, 20, 40);
  if (f.zzz) {
    drawZ(fb, 104, 40, 5);
    drawZ(fb, 111, 31, 5);
    drawZ(fb, 118, 22, 5);
  }

  return fb;
}

let faceState = null;
let faceBlinking = false;
let faceTimer = null;

function hexToRgb(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

function paintFace() {
  const canvas = document.getElementById("face");
  const ctx = canvas.getContext("2d");
  const css = getComputedStyle(document.documentElement);
  const bg = hexToRgb((css.getPropertyValue("--oled-bg") || "#05070A").trim());
  const blue = hexToRgb((css.getPropertyValue("--oled-blue") || "#57D3EE").trim());
  const yellow = hexToRgb((css.getPropertyValue("--oled-yellow") || "#F5CE55").trim());

  const fb = buildFace(faceState, faceBlinking);
  const img = ctx.createImageData(OLED_W, OLED_H);

  for (let y = 0; y < OLED_H; y++) {
    const on = y < YELLOW_ROWS ? yellow : blue;
    for (let x = 0; x < OLED_W; x++) {
      const i = y * OLED_W + x;
      const c = fb && fb[i] ? on : bg;
      img.data[i * 4] = c[0];
      img.data[i * 4 + 1] = c[1];
      img.data[i * 4 + 2] = c[2];
      img.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function renderFace(state) {
  faceState = state;
  paintFace();

  if (faceTimer) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  // Trepće istim ritmom kao uređaj: 150 ms na svake 4 sekunde.
  faceTimer = setInterval(() => {
    const f = FACES[faceState];
    if (!f || f.closed) return;
    faceBlinking = true;
    paintFace();
    setTimeout(() => { faceBlinking = false; paintFace(); }, 150);
  }, 4000);
}

// ── Stanje + očitavanja ────────────────────────────────────────
async function loadState() {
  const data = await (await fetch("/api/plant/state")).json();

  document.getElementById("state-card").dataset.state = data.state;
  document.getElementById("state-label").textContent = STATE_LABEL[data.state] || data.state;
  document.getElementById("state-reason").textContent = data.reason;

  activeProfile = data.profile || activeProfile;
  lastReadings = data.readings || null;
  renderFace(data.state);
  renderReadings(data.readings);
}

function renderReadings(readings) {
  const list = document.getElementById("readings-grid");
  const types = Object.keys(readings || {}).filter((t) => SENSORS[t] && !SENSORS[t].event);

  if (types.length === 0) {
    list.innerHTML = '<p class="empty">Još nema očitavanja.</p>';
    return;
  }

  list.innerHTML = types.map((type) => {
    const cfg = sensorMeta(type);
    const r = readings[type];
    const val = Math.round(r.value * 10) / 10;
    const level = levelFor(cfg, r.value);
    const [min, max] = cfg.domain;
    const span = max - min || 1;

    // Traka pokazuje samo idealni pojas i marker, kako je u dizajnu.
    const good = (cfg.zones || []).find((z) => z[2] === "good") || [min, max];
    const bandLeft = clamp((good[0] - min) / span, 0, 1) * 100;
    const bandWidth = clamp((good[1] - good[0]) / span, 0, 1) * 100;
    const mark = clamp((r.value - min) / span, 0, 1) * 100;

    return `
      <div class="reading" data-level="${level}">
        <div class="reading-top">
          <span class="reading-name"><span class="dot"></span>${cfg.label}</span>
          <span class="reading-value">${val}<span class="unit">${cfg.unit}</span></span>
        </div>
        <div class="gauge">
          <div class="gauge-track"></div>
          <div class="gauge-band" style="left:${bandLeft}%;width:${bandWidth}%"></div>
          <div class="gauge-mark" style="left:${mark}%"></div>
        </div>
        <div class="reading-foot">
          <span>${cfg.ideal}</span>
          <span>${fmtAgo(r.recorded_at)}</span>
        </div>
      </div>`;
  }).join("");
}

// ── Istorija / grafikoni ───────────────────────────────────────
// Crta se ručno u SVG-u, bez biblioteke: viewBox je 0 0 100 40 uz
// preserveAspectRatio=none, pa se sve računa u procentima i rasteže na širinu.

function niceNum(v) {
  const a = Math.abs(v);
  if (a >= 100) return String(Math.round(v));
  if (a >= 10) return String(Math.round(v * 10) / 10);
  return String(Math.round(v * 10) / 10);
}

function buildChart(type, points) {
  const cfg = sensorMeta(type);
  const values = points.map((p) => p.value);
  const n = values.length;
  if (n === 0) return "";

  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const avg = values.reduce((x, y) => x + y, 0) / n;
  const now = values[n - 1];

  const good = (cfg.zones || []).find((z) => z[2] === "good") || [dataMin, dataMax];
  let lo = Math.min(dataMin, good[0]);
  let hi = Math.max(dataMax, good[1]);
  const pad = (hi - lo) * 0.06 || 1;
  lo -= pad;
  hi += pad;

  const y = (v) => 40 - ((v - lo) / (hi - lo)) * 40;
  const x = (i) => (n === 1 ? 0 : (i / (n - 1)) * 100);

  const bandTop = clamp(y(good[1]), 0, 40);
  const bandBottom = clamp(y(good[0]), 0, 40);

  const pts = values.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`);
  const d = "M" + pts.join(" L");
  const area = d + ` L${x(n - 1).toFixed(2)},40 L${x(0).toFixed(2)},40 Z`;

  const tickAt = [0, 100 / 3, 200 / 3, 100];
  const ticks = tickAt.map((t) =>
    `<line x1="${t.toFixed(2)}" y1="0" x2="${t.toFixed(2)}" y2="40" stroke="var(--grid)" stroke-width="1" vector-effect="non-scaling-stroke"></line>`
  ).join("");

  const labels = tickAt.map((t) => {
    const i = Math.min(n - 1, Math.round((t / 100) * (n - 1)));
    return `<span>${fmtTime(points[i].recorded_at)}</span>`;
  }).join("");

  return `
    <div class="chart" data-level="${levelFor(cfg, now)}">
      <div class="chart-top">
        <span class="chart-name"><span class="dot"></span>${cfg.label}</span>
        <span class="chart-now">${niceNum(now)}<span class="unit">${cfg.unit}</span></span>
      </div>
      <div class="chart-stats">
        <span>${cfg.ideal}</span>
        <span>min ${niceNum(dataMin)} · max ${niceNum(dataMax)} · ⌀ ${niceNum(avg)}</span>
      </div>
      <div class="chart-body">
        <div class="chart-axis">
          <span>${niceNum(hi)}</span><span>${niceNum((hi + lo) / 2)}</span><span>${niceNum(lo)}</span>
        </div>
        <svg class="chart-plot" viewBox="0 0 100 40" preserveAspectRatio="none">
          <rect x="0" y="${bandTop.toFixed(2)}" width="100" height="${(bandBottom - bandTop).toFixed(2)}" fill="var(--tone)" opacity="0.1"></rect>
          <line x1="0" y1="${bandTop.toFixed(2)}" x2="100" y2="${bandTop.toFixed(2)}" stroke="var(--tone)" stroke-width="1" stroke-dasharray="3 3" opacity=".45" vector-effect="non-scaling-stroke"></line>
          <line x1="0" y1="${bandBottom.toFixed(2)}" x2="100" y2="${bandBottom.toFixed(2)}" stroke="var(--tone)" stroke-width="1" stroke-dasharray="3 3" opacity=".45" vector-effect="non-scaling-stroke"></line>
          ${ticks}
          <path d="${area}" fill="var(--tone)" opacity=".13"></path>
          <path d="${d}" fill="none" stroke="var(--tone)" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"></path>
        </svg>
      </div>
      <div class="chart-xlabels">${labels}</div>
    </div>`;
}

async function loadHistory() {
  const hours = document.getElementById("hours-select").value;
  const history = await (await fetch(`/api/plant/history?hours=${hours}`)).json();
  const container = document.getElementById("charts");

  const types = Object.keys(history).filter((t) => SENSORS[t] && !SENSORS[t].event);
  if (types.length === 0) {
    container.innerHTML = '<p class="empty">Nema podataka za izabrani period.</p>';
    return;
  }

  container.innerHTML = types.map((t) => buildChart(t, history[t])).join("");
}

// ── Profil biljke ──────────────────────────────────────────────
// Pragovi dolaze sa servera, pa referentne zone na karticama uvek pokazuju
// ono po čemu se stvarno procenjuje stanje.
let activeProfile = null;
let lastReadings = null;

function zonesFor(type, p) {
  if (!p) return null;
  if (type === "soil_humidity") {
    return {
      domain: [0, 100],
      zones: [[0, p.soil_thirsty, "bad"], [p.soil_thirsty, p.soil_ideal_lo, "warn"],
              [p.soil_ideal_lo, p.soil_ideal_hi, "good"], [p.soil_ideal_hi, 100, "warn"]],
      ideal: `ideal ${p.soil_ideal_lo}–${p.soil_ideal_hi}%`,
    };
  }
  if (type === "light") {
    const top = Math.round(p.light_ideal * 1.5);
    return {
      domain: [0, top],
      zones: [[0, p.light_min, "bad"], [p.light_min, p.light_ideal, "warn"],
              [p.light_ideal, top, "good"]],
      ideal: `ideal ≥ ${p.light_ideal} lux`,
    };
  }
  if (type === "temperature_humidity") {
    return {
      domain: [0, 40],
      zones: [[0, p.temp_min - 3, "bad"], [p.temp_min - 3, p.temp_min, "warn"],
              [p.temp_min, p.temp_max, "good"], [p.temp_max, p.temp_max + 3, "warn"],
              [p.temp_max + 3, 40, "bad"]],
      ideal: `ideal ${p.temp_min}–${p.temp_max} °C`,
    };
  }
  return null;
}

async function loadProfiles() {
  const select = document.getElementById("profile-select");
  try {
    const row = document.getElementById("profile-row");
    const { profiles } = await (await fetch("/api/profiles")).json();
    if (!profiles || !profiles.length) { row.hidden = true; return; }
    row.hidden = false;
    select.innerHTML = profiles.map((p) =>
      `<option value="${p.id}"${p.is_active ? " selected" : ""}>${p.name}</option>`
    ).join("");
  } catch (e) {
    document.getElementById("profile-row").hidden = true;
  }
}

// Upis profila menja pragove po kojima pumpa zaliva, pa server traži ključ.
// Čuva se lokalno u pregledaču, nikad se ne šalje nigde osim ovom API-ju.
function apiKey() {
  const saved = localStorage.getItem("apiKey");
  if (saved) return saved;
  return (window.prompt("API ključ (isti kao na serveru):") || "").trim();
}

async function changeProfile(id) {
  const key = apiKey();
  if (!key) { await loadProfiles(); return; }

  const res = await fetch("/api/profiles/active", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-API-Key": key },
    body: JSON.stringify({ id: Number(id) }),
  });

  if (res.status === 401) {
    localStorage.removeItem("apiKey");
    setStatus("Pogrešan API ključ, profil nije promenjen.", "err");
    await loadProfiles();
    return;
  }
  if (!res.ok) {
    setStatus("Profil nije promenjen.", "err");
    await loadProfiles();
    return;
  }

  localStorage.setItem("apiKey", key);
  setStatus("Profil promenjen.", "ok");
  await refresh();
}

// ── Novi profil ────────────────────────────────────────────────
const PROFILE_FIELDS = {
  name:          "f-name",
  soil_thirsty:  "f-soil-thirsty",
  soil_ideal_lo: "f-soil-lo",
  soil_ideal_hi: "f-soil-hi",
  light_min:     "f-light-min",
  light_ideal:   "f-light-ideal",
  temp_min:      "f-temp-min",
  temp_max:      "f-temp-max",
};

function profileError(msg) {
  const el = document.getElementById("profile-error");
  el.textContent = msg;
  el.hidden = !msg;
}

function measuredHint(elementId, type, unit) {
  const r = lastReadings && lastReadings[type];
  document.getElementById(elementId).textContent =
    r ? `Sada izmereno: ${Math.round(r.value * 10) / 10} ${unit}` : "";
}

function openProfileDialog() {
  const p = activeProfile || {};

  // Polja kreću od aktivnog profila, pa se menja samo ono što se razlikuje.
  document.getElementById("f-name").value = "";
  for (const [field, id] of Object.entries(PROFILE_FIELDS)) {
    if (field !== "name") document.getElementById(id).value = p[field] ?? "";
  }
  document.getElementById("f-activate").checked = true;
  profileError("");

  // Izmereno stoji uz polja jer se prag postavlja upravo prema njemu.
  measuredHint("hint-soil", "soil_humidity", "%");
  measuredHint("hint-light", "light", "lux");
  measuredHint("hint-temp", "temperature_humidity", "°C");

  document.getElementById("profile-dialog").showModal();
  document.getElementById("f-name").focus();
}

// Ista pravila kao na serveru, samo da se greška vidi bez odlaska na mrežu.
function validateProfile(p) {
  if (!p.name) return "Naziv profila je obavezan.";
  for (const field of Object.keys(PROFILE_FIELDS)) {
    if (field !== "name" && !Number.isFinite(p[field])) {
      return "Sva polja moraju biti popunjena brojevima.";
    }
  }
  for (const field of ["soil_thirsty", "soil_ideal_lo", "soil_ideal_hi"]) {
    if (p[field] < 0 || p[field] > 100) return "Vlažnost tla ide od 0 do 100%.";
  }
  if (p.soil_ideal_lo >= p.soil_ideal_hi) return "Donja granica vlažnosti mora biti manja od gornje.";
  if (p.soil_thirsty > p.soil_ideal_lo) return "Prag žeđi ne može biti iznad idealnog opsega.";
  if (p.light_min < 0) return "Minimalna svetlost ne može biti negativna.";
  if (p.light_ideal <= p.light_min) return "Idealna svetlost mora biti veća od minimalne.";
  if (p.temp_min >= p.temp_max) return "Minimalna temperatura mora biti manja od maksimalne.";
  return null;
}

async function submitProfile(event) {
  event.preventDefault();

  const body = { activate: document.getElementById("f-activate").checked };
  for (const [field, id] of Object.entries(PROFILE_FIELDS)) {
    const raw = document.getElementById(id).value.trim();
    body[field] = field === "name" ? raw : (raw === "" ? null : Number(raw));
  }

  const problem = validateProfile(body);
  if (problem) { profileError(problem); return; }

  const key = apiKey();
  if (!key) { profileError("Bez API ključa profil ne može da se sačuva."); return; }

  const button = document.getElementById("profile-save");
  button.disabled = true;
  try {
    const res = await fetch("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": key },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));

    if (res.status === 401) {
      localStorage.removeItem("apiKey");
      profileError("Pogrešan API ključ.");
      return;
    }
    if (!res.ok) { profileError(data.error || "Profil nije sačuvan."); return; }

    localStorage.setItem("apiKey", key);
    document.getElementById("profile-dialog").close();
    setStatus(body.activate ? "Profil napravljen i primenjen." : "Profil napravljen.", "ok");
    await loadProfiles();
    await refresh();
  } catch (e) {
    profileError("Server nije dostupan.");
  } finally {
    button.disabled = false;
  }
}

// ── Zalivanje ──────────────────────────────────────────────────
let pumpDeviceId = null;

function fmtAgo(iso) {
  const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 90) return "upravo";
  const min = Math.round(sec / 60);
  if (min < 60) return `pre ${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  if (h < 24) return rest ? `pre ${h} h ${rest} min` : `pre ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? "juče" : `pre ${d} dana`;
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("sr-RS", { day: "2-digit", month: "2-digit" }) +
         " " + d.toLocaleTimeString("sr-RS", { hour: "2-digit", minute: "2-digit" });
}

async function loadPumpDevice() {
  try {
    const { devices } = await (await fetch("/api/devices")).json();
    const pump = (devices || []).find((d) => d.type === "pump");
    pumpDeviceId = pump ? pump.id : null;
  } catch (e) {
    pumpDeviceId = null;
  }
}

async function loadPump() {
  const section = document.getElementById("pump-section");
  if (pumpDeviceId === null) { section.hidden = true; return; }

  const { readings } = await (await fetch(`/api/readings?device_id=${pumpDeviceId}`)).json();
  if (!readings || readings.length === 0) { section.hidden = true; return; }

  section.hidden = false;
  const last = readings[0];

  document.getElementById("pump-last").innerHTML =
    `<span class="big">${fmtAgo(last.recorded_at)}</span>` +
    `<span class="note">poslednje zalivanje, ${last.value} ${last.unit}</span>`;

  document.getElementById("pump-log").innerHTML = readings.slice(0, 8).map((r) =>
    `<li><span class="when">${fmtDateTime(r.recorded_at)}</span>` +
    `<span class="dur">${r.value} ${r.unit}</span></li>`
  ).join("");
}

// ── Push notifikacije ──────────────────────────────────────────
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function updateNotifButton() {
  const btn = document.getElementById("notif-btn");
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    btn.style.display = "none";
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  btn.classList.toggle("enabled", !!sub);
  btn.innerHTML = icon(sub ? "bell" : "bell-off");
  btn.title = sub ? "Isključi notifikacije" : "Uključi notifikacije";
}

async function toggleNotifications() {
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();

  if (existing) {
    await fetch("/api/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: existing.endpoint }),
    });
    await existing.unsubscribe();
    setStatus("Notifikacije isključene.");
    return updateNotifButton();
  }

  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    setStatus("Dozvola za notifikacije odbijena.", "err");
    return;
  }

  const { publicKey } = await (await fetch("/api/vapid-public-key")).json();
  if (!publicKey) {
    setStatus("Server nema podešene VAPID ključeve.", "err");
    return;
  }

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });

  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sub),
  });

  setStatus("Notifikacije uključene.", "ok");
  updateNotifButton();
}

// ── Inicijalizacija ────────────────────────────────────────────
async function refresh() {
  try {
    await Promise.all([loadState(), loadHistory(), loadPump()]);
    setStatus(`Ažurirano u ${new Date().toLocaleTimeString("sr-RS")}`, "ok");
  } catch (e) {
    setStatus("Greška pri učitavanju — pokušavam ponovo…", "err");
    console.error(e);
  }
}

function registerServiceWorker() {
  // Namerno bez await-a — registracija SW-a ne sme da blokira učitavanje podataka.
  if (!("serviceWorker" in navigator)) {
    document.getElementById("notif-btn").style.display = "none";
    return;
  }
  navigator.serviceWorker.register("/sw.js", { scope: "/" })
    .then(() => updateNotifButton())
    .catch((e) => console.error("SW registracija nije uspela:", e));
}

async function init() {
  applyTheme();
  document.getElementById("theme-btn").addEventListener("click", toggleTheme);
  // Kad izbor nije napravljen, prati promenu sistemske teme uživo.
  window.matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => { if (!savedTheme()) applyTheme(); });

  document.getElementById("notif-btn").innerHTML = icon("bell-off");
  document.getElementById("notif-btn").addEventListener("click", toggleNotifications);
  document.getElementById("hours-select").addEventListener("change", loadHistory);

  document.getElementById("profile-select")
    .addEventListener("change", (e) => changeProfile(e.target.value));
  document.getElementById("profile-add").addEventListener("click", openProfileDialog);
  document.getElementById("profile-cancel")
    .addEventListener("click", () => document.getElementById("profile-dialog").close());
  document.getElementById("profile-form").addEventListener("submit", submitProfile);

  registerServiceWorker();

  await loadPumpDevice();
  await loadProfiles();
  await refresh();
  setInterval(refresh, REFRESH_MS);
}

init();
