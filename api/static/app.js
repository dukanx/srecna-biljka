/* Srećna biljka — PWA dashboard logika */

const REFRESH_MS = 30000; // ESP32 šalje na 30s

// ── ikonice ──────
const ICON_PATHS = {
  leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>',
  droplet: '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/>',
  thermometer: '<path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/>',
  wind: '<path d="M12.8 19.6A2 2 0 1 0 14 16H2"/><path d="M17.5 8a2.5 2.5 0 1 1 2 4H2"/><path d="M9.8 4.4A2 2 0 1 1 11 8H2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  bell: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  "bell-off": '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742"/><path d="m2 2 20 20"/><path d="M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05"/>',
};

function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name] || ""}</svg>`;
}

// ── Konfiguracija senzora: ikonica, jedinica, opseg, zone, ideal ──
// zone: [od, do, nivo]  (nivo: good | warn | bad) — pokrivaju ceo domain
const SENSORS = {
  soil_humidity: {
    label: "Vlažnost tla", icon: "droplet", unit: "%",
    domain: [0, 100],
    zones: [[0, 30, "bad"], [30, 40, "warn"], [40, 70, "good"], [70, 100, "warn"]],
    ideal: "ideal 40–70%",
  },
  temperature_humidity: {
    label: "Temperatura", icon: "thermometer", unit: "°C",
    domain: [0, 40],
    zones: [[0, 10, "bad"], [10, 18, "warn"], [18, 26, "good"], [26, 30, "warn"], [30, 40, "bad"]],
    ideal: "ideal 18–26 °C",
  },
  co2: {
    label: "CO₂", icon: "wind", unit: "ppm",
    domain: [400, 1600],
    zones: [[400, 1000, "good"], [1000, 1200, "warn"], [1200, 1600, "bad"]],
    ideal: "ideal 400–1000 ppm",
  },
  light: {
    label: "Svetlost", icon: "sun", unit: "lux",
    domain: [0, 1500],
    zones: [[0, 200, "bad"], [200, 500, "warn"], [500, 1500, "good"]],
    ideal: "ideal ≥ 500 lux",
  },
};

const STATE_LABEL = { happy: "Srećna", thirsty: "Žedna", sleepy: "Pospana", angry: "Ljuta" };

const charts = {}; // type -> Chart instanca

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
  return SENSORS[type] || { label: type, icon: "leaf", unit: "", domain: [0, 1], zones: [[0, 1, "good"]], ideal: "" };
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function levelFor(cfg, value) {
  for (const [from, to, level] of cfg.zones) {
    if (value >= from && value < to) return level;
  }
  return value < cfg.domain[0] ? cfg.zones[0][2] : cfg.zones[cfg.zones.length - 1][2];
}

function refBarHtml(cfg, value) {
  const [min, max] = cfg.domain;
  const span = max - min || 1;
  const zones = cfg.zones.map(([from, to, level]) =>
    `<div class="refbar-zone ${level}" style="flex:${(to - from) / span}"></div>`
  ).join("");
  const pct = clamp((value - min) / span, 0, 1) * 100;
  return `
    <div class="refbar">
      <div class="refbar-track">
        ${zones}
        <div class="refbar-marker" style="left:${pct}%"></div>
      </div>
      <div class="refbar-ideal">${cfg.ideal}</div>
    </div>`;
}

// ── Stanje + očitavanja ────────────────────────────────────────
async function loadState() {
  const data = await (await fetch("/api/plant/state")).json();

  document.getElementById("state-card").dataset.state = data.state;
  document.getElementById("state-label").textContent = STATE_LABEL[data.state] || data.state;
  document.getElementById("state-reason").textContent = data.reason;

  renderReadings(data.readings);
}

function renderReadings(readings) {
  const grid = document.getElementById("readings-grid");
  const types = Object.keys(readings || {});

  if (types.length === 0) {
    grid.innerHTML = '<p class="empty">Još nema očitavanja.</p>';
    return;
  }

  grid.innerHTML = types.map((type) => {
    const cfg = sensorMeta(type);
    const r = readings[type];
    const val = Math.round(r.value * 10) / 10;
    const level = levelFor(cfg, r.value);
    return `
      <div class="reading-card">
        <div class="reading-top">${icon(cfg.icon)}<span class="reading-name">${cfg.label}</span></div>
        <div class="reading-value" data-level="${level}">${val}<span class="unit">${cfg.unit}</span></div>
        ${refBarHtml(cfg, r.value)}
        <div class="reading-time">${fmtTime(r.recorded_at)}</div>
      </div>`;
  }).join("");
}

// ── Istorija / grafikoni ───────────────────────────────────────
function chartColors() {
  const css = getComputedStyle(document.body);
  return {
    text: css.getPropertyValue("--muted").trim() || "#888",
    grid: css.getPropertyValue("--border").trim() || "#ddd",
  };
}

async function loadHistory() {
  const hours = document.getElementById("hours-select").value;
  const history = await (await fetch(`/api/plant/history?hours=${hours}`)).json();

  const container = document.getElementById("charts");
  const types = Object.keys(history);

  if (types.length === 0) {
    container.innerHTML = '<p class="empty">Nema podataka za izabrani period.</p>';
    return;
  }

  types.forEach((type) => {
    const cfg = sensorMeta(type);
    let canvas = document.getElementById(`chart-${type}`);
    if (!canvas) {
      const card = document.createElement("div");
      card.className = "chart-card";
      card.innerHTML = `<h3>${icon(cfg.icon)} ${cfg.label}</h3><canvas id="chart-${type}"></canvas>`;
      container.appendChild(card);
      canvas = document.getElementById(`chart-${type}`);
    }
    const labels = history[type].map((p) => fmtTime(p.recorded_at));
    const values = history[type].map((p) => p.value);
    drawChart(type, canvas, labels, values);
  });
}

function drawChart(type, canvas, labels, values) {
  const accent = "#16a34a";
  if (charts[type]) {
    charts[type].data.labels = labels;
    charts[type].data.datasets[0].data = values;
    charts[type].update("none");
    return;
  }

  const c = chartColors();
  charts[type] = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: accent,
        backgroundColor: accent + "1f",
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.3,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: c.text, maxRotation: 0, autoSkip: true, maxTicksLimit: 6 }, grid: { color: c.grid } },
        y: { ticks: { color: c.text }, grid: { color: c.grid }, beginAtZero: false },
      },
    },
  });
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
    await Promise.all([loadState(), loadHistory()]);
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
  document.querySelector('[data-icon="leaf"]').innerHTML = icon("leaf");
  document.getElementById("notif-btn").innerHTML = icon("bell-off");
  document.getElementById("notif-btn").addEventListener("click", toggleNotifications);
  document.getElementById("hours-select").addEventListener("change", () => {
    Object.values(charts).forEach((c) => c.destroy());
    Object.keys(charts).forEach((k) => delete charts[k]);
    document.getElementById("charts").innerHTML = "";
    loadHistory();
  });

  registerServiceWorker();

  await refresh();
  setInterval(refresh, REFRESH_MS);
}

init();
