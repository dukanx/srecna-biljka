/* Service worker — Srećna biljka PWA */

const CACHE = "srecna-biljka-v1";

// App shell koji keširamo da dashboard radi i offline
const APP_SHELL = [
  "/dashboard",
  "/manifest.json",
  "/static/style.css",
  "/static/app.js",
  "/static/vendor/chart.umd.min.js",
  "/static/icons/srecna-biljka-192.png",
  "/static/icons/srecna-biljka-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // API pozivi: uvek mreža (svež podatak), bez keširanja
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(request).catch(() => Response.error()));
    return;
  }

  // Statika / app shell: cache-first sa osvežavanjem u pozadini
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return resp;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

// ── Push notifikacije ──────────────────────────────────────────
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "Srećna biljka";
  const options = {
    body: data.body || "Stanje biljke se promenilo.",
    icon: "/static/icons/srecna-biljka-192.png",
    badge: "/static/icons/srecna-biljka-192.png",
    tag: "plant-state",
    renotify: true,
    data: { url: data.url || "/dashboard" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/dashboard";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.includes(target) && "focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});
