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
  function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  async function recognize(canvas, lang = "spa", onProgress) {
    try {
      const w = await withTimeout(getWorker(lang, onProgress), 45000, "El motor de OCR tardó demasiado en cargar. Revisa tu conexión e inténtalo de nuevo.");
      const { data } = await withTimeout(
        w.recognize(canvas),
        60000,
        "El reconocimiento de texto tardó demasiado (puede deberse a la descarga del paquete de idioma). Revisa tu conexión e inténtalo de nuevo."
      );
      const words = (data.words || [])
        .filter((wd) => wd.text && wd.text.trim())
        .map((wd) => ({ text: wd.text, bbox: wd.bbox }));
      return { text: (data.text || "").trim(), confidence: data.confidence || 0, words };
    } catch (err) {
      // Discard the (possibly wedged) worker so the next attempt starts
      // fresh instead of queuing behind a stuck request forever.
      if (worker) { try { worker.terminate(); } catch (e) {} }
      worker = null; workerLang = null;
      throw err;
    }
  }

  /**
   * translate(text, targetLang, sourceLang) -> translated string
   *
   * Tries Google's public translation endpoint first (same one used by
   * countless browser extensions client-side, no key required) and falls
   * back to the MyMemory API if that fails (offline-unfriendly proxy,
   * network error, etc.).
   *
   * Why not just MyMemory alone: MyMemory is a *translation-memory* API —
   * for short or generic input it can return an unrelated sentence pulled
   * from its database that happens to share a phrase with the query,
   * rather than an actual translation of what was sent. That's the most
   * likely explanation for "translated text that has nothing to do with
   * the original". Google's engine translates the given text directly
   * instead of matching it against a memory bank, so it doesn't have this
   * failure mode.
   */
  async function translate(text, targetLang = "en", sourceLang = "auto") {
    try {
      return await translateViaGoogle(text, targetLang, sourceLang);
    } catch (err) {
      return await translateViaMyMemory(text, targetLang, sourceLang);
    }
  }

  async function translateViaGoogle(text, targetLang, sourceLang) {
    // ~1800 chars keeps well under the endpoint's practical GET length
    // limit while still preserving much more surrounding context per
    // request than MyMemory's chunking did (better translations tend to
    // come from more context, not less).
    const chunks = chunkText(text, 1800);
    const results = [];
    for (const chunk of chunks) {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sourceLang)}&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(chunk)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Servicio de traducción no disponible");
      const json = await res.json();
      const segments = Array.isArray(json) && Array.isArray(json[0]) ? json[0] : [];
      results.push(segments.map((seg) => seg[0] || "").join(""));
    }
    return results.join(" ");
  }

  async function translateViaMyMemory(text, targetLang, sourceLang) {
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
