/**
 * ocr.js — Text extraction (OCR) and automatic translation.
 * Tesseract.js is loaded on demand (only when the user opens the "Texto"
 * tab for the first time), so it never slows down the initial app load.
 * Once loaded, the service worker's runtime cache picks it up for offline
 * reuse automatically (see sw.js).
 */
const OCR = (() => {
  const TESSERACT_URL = "js/vendor/tesseract.min.js";
  const WORKER_PATH = "js/vendor/worker.min.js";
  const CORE_PATH = "js/vendor/tesseract-core/tesseract-core-simd-lstm.wasm.js";
  let tesseractLoading = null;
  let worker = null;
  let workerLang = null;

  function loadScriptOnce(url) {
    return new Promise((resolve, reject) => {
      if ([...document.scripts].some((s) => s.src.endsWith(url))) return resolve();
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
      workerPath: WORKER_PATH,
      corePath: CORE_PATH,
      logger: (m) => {
        if (onProgress && m.status === "recognizing text") onProgress(m.progress);
      },
    });
    workerLang = lang;
    return worker;
  }

  /**
   * recognize(canvas, lang, onProgress) -> { text, confidence }
   * lang: "spa" | "eng" | "spa+eng". Defaults to "spa" — combining two
   * languages makes Tesseract pick between competing dictionaries per
   * word, which is the main cause of odd/garbled substitutions on
   * documents that are really just one language. Pass "spa+eng"
   * explicitly for genuinely bilingual documents.
   */
  async function recognize(canvas, lang = "spa", onProgress) {
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
