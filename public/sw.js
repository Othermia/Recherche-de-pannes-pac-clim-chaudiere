// Cache de l'interface pour un démarrage rapide et l'accès aux calculs hors ligne.
const CACHE = "othermia-v3";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/calc.js", "/brand/logo.png", "/brand/icon-192.png", "/vendor/marked.js", "/vendor/purify.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // API : seules les lectures utiles hors ligne sont mises en cache (codes, docs, parc, PDF).
  const offlineApi = /^\/api\/(codes|docs|equipements|pieces|marques|brand)/.test(url.pathname);
  if (url.pathname.startsWith("/api/") && !offlineApi) return;
  // Réseau d'abord, cache en secours (hors ligne).
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
