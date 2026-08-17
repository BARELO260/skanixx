/**
 * sw.js — Caches the app shell (HTML/CSS/JS/icons + vendor libs) for
 * offline use.
 *
 * IMPORTANT: the app shell (HTML/CSS/JS) uses a NETWORK-FIRST strategy —
 * always try to fetch the latest code first, and only fall back to the
 * cached copy if the network request fails (i.e. actually offline). This
 * is what makes new deployments show up immediately on the next reload
 * instead of getting stuck showing a stale cached version indefinitely.
 * Only the large, rarely-changing vendor libraries (OCR/WASM engine) and
 * icons use cache-first, since freshness barely matters there and instant
 * offline loading does.
 */
// Bumped with the edge-detection runtime so installed/offline clients do
// not retain a previous camera pipeline after an update.
const CACHE_NAME = "skanix-shell-v6";
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/styles.css",
  "./js/app.js",
  "./js/camera.js",
  "./js/db.js",
  "./js/edgeDetector.js",
  "./js/imageProcessing.js",
  "./js/ocr.js",
  "./js/exporters.js",
  "./js/sound.js",
  "./js/vendor/jspdf.umd.min.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
];
// Best-effort precache for heavier on-demand libraries (OCR engine, DOCX
// zipper). These are large, so we never block install/offline-readiness on
// them — Promise.allSettled below just tries opportunistically. If this
// fails (e.g. first install happens offline), the generic fetch handler
// still caches them the first time the user actually triggers OCR/DOCX.
const OPTIONAL_ASSETS = [
  "./js/vendor/jszip.min.js",
  "./js/vendor/tesseract.min.js",
  "./js/vendor/worker.min.js",
  "./js/vendor/tesseract-core/tesseract-core-simd-lstm.wasm.js",
  "./js/vendor/tesseract-core/tesseract-core-simd-lstm.wasm",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(SHELL_ASSETS.map((url) => cache.add(url)))
        .then(() => Promise.allSettled(OPTIONAL_ASSETS.map((url) => cache.add(url))))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Same-origin app-shell files: HTML/CSS/JS that aren't part of the
// (large, static) vendor bundle. Anything matching this is served
// network-first.
function isAppShellRequest(req, url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.includes("/vendor/")) return false;
  if (req.mode === "navigate") return true;
  return /\.(html|js|css|json)$/.test(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (isAppShellRequest(req, url)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Cache-first for everything else (icons, vendor OCR/PDF libraries) —
  // large and effectively static, so prioritize instant offline loading.
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && (res.type === "basic" || res.type === "cors")) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
