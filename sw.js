/**
 * sw.js — Caches the app shell (HTML/CSS/JS/icons + the jsPDF CDN
 * script) on install so Skanix keeps working with no network
 * connection. Uses a cache-first strategy for shell assets and a
 * stale-while-revalidate style fallback for everything else — which
 * also means heavier on-demand libraries (OCR, DOCX zipping) get
 * cached automatically the first time they're actually used.
 */
const CACHE_NAME = "skanix-shell-v3";
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
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
];
// Best-effort precache for heavier on-demand libraries (OCR engine, DOCX
// zipper). These are large, so we never block install/offline-readiness on
// them — Promise.allSettled below just tries opportunistically. If this
// fails (e.g. first install happens offline), the generic fetch handler
// still caches them the first time the user actually triggers OCR/DOCX.
const OPTIONAL_ASSETS = [
  "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.0.4/tesseract.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
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

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

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
