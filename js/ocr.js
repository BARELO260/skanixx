/**
 * ocr.js — Text extraction (OCR) and automatic translation.
 * Tesseract.js is loaded on demand (only when the user opens the "Texto"
 * tab for the first time), so it never slows down the initial app load.
 * Once loaded, the service worker's runtime cache picks it up for offline
 * reuse automatically (see sw.js).
 */
const OCR = (() => {
  const TESSERACT_URL = "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.0.4/tesseract.min.js";
  let tesseractLoading = null;
  let worker = null;
  let workerLang = null;

  function loadScriptOnce(url) {
    return new Promise((resolve, reject) => {
      if ([...document.scripts].some((s) => s.src === url)) return resolve();
      const s = document.createElement("script");
      s.src = url;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("No se pudo cargar " + url));
      document.head.appendChild(s);
    });
  }

  async function ensureTesseract() {
    if (window.Tesseract) return;
    if (!tesseractLoading) tesseractLoading = loadScriptOnce(TESSERACT_URL);
    await tesseractLoading;
  }

  // lang: tesseract language code, e.g. "spa", "eng", "spa+eng"
  async function getWorker(lang, onProgress) {
    await ensureTesseract();
    if (worker && workerLang === lang) return worker;
    if (worker) { try { await worker.terminate(); } catch (e) {} worker = null; }
    worker = await window.Tesseract.createWorker(lang, 1, {
      logger: (m) => {
        if (onProgress && m.status === "recognizing text") onProgress(m.progress);
      },
    });
    workerLang = lang;
    return worker;
  }

  /**
   * recognize(canvas, lang, onProgress) -> { text, confidence }
   * lang: "spa" | "eng" | "spa+eng" (default "spa+eng" for mixed docs)
   */
  async function recognize(canvas, lang = "spa+eng", onProgress) {
    const w = await getWorker(lang, onProgress);
    const { data } = await w.recognize(canvas);
    return { text: (data.text || "").trim(), confidence: data.confidence || 0 };
  }

  /**
   * translate(text, targetLang, sourceLang) -> translated string
   * Uses the free MyMemory API (no key required). Best-effort: chunks long
   * text to stay under the API's per-request length limit and joins results.
   * Requires network — throws if offline, caller should surface that.
   */
  async function translate(text, targetLang = "en", sourceLang = "auto") {
    const chunks = chunkText(text, 480);
    const results = [];
    for (const chunk of chunks) {
      const langPair = `${sourceLang}|${targetLang}`;
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=${encodeURIComponent(langPair)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Servicio de traducción no disponible");
      const json = await res.json();
      results.push(json?.responseData?.translatedText || "");
    }
    return results.join(" ");
  }

  function chunkText(text, maxLen) {
    const words = text.split(/\s+/);
    const chunks = [];
    let cur = "";
    for (const w of words) {
      if ((cur + " " + w).trim().length > maxLen) {
        if (cur) chunks.push(cur.trim());
        cur = w;
      } else {
        cur = (cur + " " + w).trim();
      }
    }
    if (cur) chunks.push(cur.trim());
    return chunks.length ? chunks : [""];
  }

  return { recognize, translate };
})();
