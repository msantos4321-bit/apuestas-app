// Service worker: la app abre sin internet con lo ultimo guardado y se actualiza sola.
const CACHE = "apuestas-v1.2.0";
const SHELL = ["./", "index.html", "config.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
// Red primero (siempre la version mas nueva); si no hay internet, lo guardado.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Nunca guardar llamadas a la base de datos / funciones
  if (url.hostname.endsWith("supabase.co")) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok && (url.origin === location.origin || url.hostname === "cdn.jsdelivr.net")) {
        const copia = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copia));
      }
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match("index.html"))),
  );
});

// Notificaciones (picks nuevos y resultados) enviadas por el motor en la nube.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { titulo: "Apuestas", cuerpo: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.titulo || "Apuestas", {
    body: d.cuerpo || "", tag: d.tag || "apuestas", renotify: true,
    icon: "icon-192.png", badge: "icon-192.png", data: { url: "./" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    for (const c of cs) if ("focus" in c) return c.focus();
    return self.clients.openWindow("./");
  }));
});
