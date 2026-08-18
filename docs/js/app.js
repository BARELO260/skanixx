/**
 * app.js — Wires together camera, cropping, editing, export and the
 * on-device history into a small view-router style single-page app.
 * No framework: views are plain <section> elements toggled by class,
 * state lives in a few module-level objects below.
 */
(() => {
  "use strict";

  /* ---------------------------------------------------------------
   * Small DOM helpers
   * --------------------------------------------------------------- */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function toast(msg, type = "") {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "toast show" + (type ? ` toast-${type}` : "");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2400);
  }

  function confirmDialog(message) {
    return new Promise((resolve) => {
      const backdrop = $("#confirmDialog");
      $("#confirmMessage").textContent = message;
      backdrop.classList.remove("hidden");
      const cleanup = (result) => {
        backdrop.classList.add("hidden");
        okBtn.removeEventListener("click", onOk);
        cancelBtn.removeEventListener("click", onCancel);
        resolve(result);
      };
      const okBtn = $("#confirmOk");
      const cancelBtn = $("#confirmCancel");
      const onOk = () => cleanup(true);
      const onCancel = () => cleanup(false);
      okBtn.addEventListener("click", onOk);
      cancelBtn.addEventListener("click", onCancel);
    });
  }

  // Replaces native prompt() with the app's own styled modal — resolves to
  // the trimmed text, or null if cancelled/left empty.
  function textInputDialog(title, defaultValue = "") {
    return new Promise((resolve) => {
      const backdrop = $("#textAnnotateModal");
      const input = $("#textAnnotateInput");
      $("#textAnnotateTitle").textContent = title;
      input.value = defaultValue;
      backdrop.classList.remove("hidden");
      requestAnimationFrame(() => { input.focus(); input.select(); });
      const cleanup = (result) => {
        backdrop.classList.add("hidden");
        confirmBtn.removeEventListener("click", onConfirm);
        cancelBtn.removeEventListener("click", onCancel);
        input.removeEventListener("keydown", onKeydown);
        resolve(result);
      };
      const confirmBtn = $("#textAnnotateConfirmBtn");
      const cancelBtn = $("#textAnnotateCancelBtn");
      const onConfirm = () => cleanup(input.value.trim() || null);
      const onCancel = () => cleanup(null);
      const onKeydown = (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onConfirm(); }
        if (e.key === "Escape") onCancel();
      };
      confirmBtn.addEventListener("click", onConfirm);
      cancelBtn.addEventListener("click", onCancel);
      input.addEventListener("keydown", onKeydown);
    });
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  // Some WebViews (notably the Android system WebView Capacitor wraps this
  // app in) can fail to decode very large base64 `data:` URLs — neither
  // onload nor onerror ever fires, so an <img> loaded from
  // canvas.toDataURL() can hang forever. A full-resolution photo easily
  // produces a multi-megabyte data URL (more so since capture now uses the
  // sensor's real resolution instead of a 2560x1920 cap), so this isn't a
  // rare corner case here — it was very likely the cause of "no matter how
  // many times I press the shutter, it won't take the photo": once this
  // hung, captureInFlight below stayed stuck `true` for the rest of the
  // session, silently swallowing every further tap.
  //
  // toBlob() + an object URL sidesteps the giant base64 string entirely
  // (this is also how the file-upload path already loads images), and a
  // hard timeout guarantees this promise always settles even if a WebView
  // still misbehaves in some other way.
  function loadImageFromCanvas(canvas, { mime = "image/jpeg", quality = 0.96, timeoutMs = 8000 } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
      const timer = setTimeout(
        () => finish(reject, new Error("Tiempo de espera agotado al procesar la foto")),
        timeoutMs
      );
      canvas.toBlob((blob) => {
        if (!blob) {
          clearTimeout(timer);
          finish(reject, new Error("No se pudo generar la imagen capturada"));
          return;
        }
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => { clearTimeout(timer); URL.revokeObjectURL(url); finish(resolve, img); };
        img.onerror = (err) => { clearTimeout(timer); URL.revokeObjectURL(url); finish(reject, err); };
        img.src = url;
      }, mime, quality);
    });
  }

  function canvasFromImage(img) {
    const c = document.createElement("canvas");
    c.width = img.naturalWidth || img.width;
    c.height = img.naturalHeight || img.height;
    c.getContext("2d").drawImage(img, 0, 0);
    return c;
  }

  function cloneCanvas(src) {
    const c = document.createElement("canvas");
    c.width = src.width; c.height = src.height;
    c.getContext("2d").drawImage(src, 0, 0);
    return c;
  }

  /* ---------------------------------------------------------------
   * View router
   * --------------------------------------------------------------- */
  const Router = {
    current: "view-home",
    show(viewId, opts) {
      const fromHistory = opts && opts.fromHistory;
      $$(".view").forEach((v) => v.classList.remove("view-active"));
      $(`#${viewId}`).classList.add("view-active");
      $$(".nav-btn[data-nav]").forEach((b) =>
        b.classList.toggle("nav-active", b.dataset.nav === viewId)
      );
      window.scrollTo(0, 0);
      if (viewId !== "view-camera") { CameraController.stop(); EdgeLoop.stop(); }
      if (!fromHistory && viewId !== Router.current) {
        history.pushState({ view: viewId }, "", "#" + viewId);
      }
      Router.current = viewId;
    },
  };

  // Baseline history entry for the initial view — without this, the very
  // first back press has no app-internal history to consume and the
  // browser/OS just exits the page immediately. With it, that first press
  // is correctly the LAST thing that gets consumed (after all real view
  // transitions have been popped), at which point falling through to the
  // normal "leave the app" behavior is actually correct.
  history.replaceState({ view: "view-home" }, "", location.pathname + location.search);

  window.addEventListener("popstate", (e) => {
    // A back press while a dialog/modal is open closes the dialog instead
    // of navigating the view underneath it — and pushes a fresh entry to
    // cancel out the navigation the browser just performed, so that one
    // physical back press = one logical "undo" step, matching what the
    // user actually sees on screen.
    const openDialog = $$(".dialog-backdrop").find((d) => !d.classList.contains("hidden"));
    if (openDialog) {
      const cancelBtn = openDialog.querySelector("#signatureCancelBtn, #textAnnotateCancelBtn, #confirmCancel");
      (cancelBtn || openDialog.querySelector(".btn-secondary"))?.click();
      history.pushState({ view: Router.current }, "", "#" + Router.current);
      return;
    }
    const targetView = (e.state && e.state.view) || "view-home";
    Router.show(targetView, { fromHistory: true });
  });

  /* ---------------------------------------------------------------
   * LIVE EDGE DETECTION — real-time document outline over the camera
   * preview (Sobel + connected components, see js/edgeDetector.js),
   * temporally smoothed so the overlay glides instead of jittering.
   * --------------------------------------------------------------- */
  const EdgeLoop = (() => {
    const SMOOTH_ALPHA = 0.32;
    const MAX_MISS = 6;
    const STABLE_NEEDED = 5;
    const AUTO_HOLD_EXTRA = 7; // roughly 1.1 s after visual lock
    const DETECT_INTERVAL = 130; // responsive without monopolising the main thread
    const MAX_LOCK_MOVEMENT = 0.026; // fraction of the preview diagonal

    let raf = null, timer = null, running = false, detectionEnabled = false;
    let smoothed = null;   // {corners, score} in video-native pixel space
    let missStreak = 0, stableStreak = 0, slowFallbackTick = 0;
    let firedForThisLock = false;
    let onAutoCapture = null;
    let overlayCanvas = null, overlayCtx = null, videoEl = null;

    function start(video, autoCaptureCallback, enabled = true) {
      stop();
      videoEl = video;
      onAutoCapture = autoCaptureCallback || null;
      overlayCanvas = $("#edgeOverlay");
      overlayCtx = overlayCanvas.getContext("2d");
      smoothed = null; missStreak = 0; stableStreak = 0; slowFallbackTick = 0; firedForThisLock = false;
      running = true; detectionEnabled = enabled;
      window.addEventListener("resize", onResize);
      if (detectionEnabled) startDetection();
      else setState("manual");
    }

    function startDetection() {
      if (!running || !detectionEnabled) return;
      setState("searching");
      tick();
      raf = requestAnimationFrame(renderLoop);
    }

    function onResize() {
      // The stage's box (and possibly the stream's own reported dimensions
      // on some devices) can change on rotation/reflow — drop the smoothed
      // quad rather than risk drawing old geometry against a new layout.
      smoothed = null;
      stableStreak = 0;
      firedForThisLock = false;
    }

    function stop() {
      running = false;
      window.removeEventListener("resize", onResize);
      if (raf) cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      raf = null; timer = null;
      if (overlayCtx && overlayCanvas) overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      const stage = document.querySelector(".camera-stage");
      if (stage) stage.classList.remove("edge-locked", "edge-searching");
      const shutter = $("#shutterBtn");
      if (shutter) shutter.classList.remove("ready");
      smoothed = null;
      detectionEnabled = false;
    }

    function tick() {
      if (!running || !detectionEnabled) return;
      try {
        if (videoEl.readyState >= 2) {
          const stage = videoEl.closest(".camera-stage");
          const rect = stage && CameraController.getPreviewSourceRect(stage.clientWidth / stage.clientHeight);
          // The line-based fallback is intentionally sampled less often:
          // it helps pale/broken borders without making a miss freeze video.
          const candidate = rect && EdgeDetector.detectFromVideoFrame(videoEl, rect, { allowLineFallback: (++slowFallbackTick % 4) === 0 });
          const result = candidate && candidate.score >= 0.10 ? candidate : null;
          if (result) {
            missStreak = 0;
            // A result existing is not enough to call it stable: noisy
            // detections used to become "locked" merely by flickering in
            // different positions for a few frames, which triggered bad
            // automatic captures. Require geometric agreement too.
            const motion = smoothed ? quadMotion(smoothed.corners, result.corners, videoEl.videoWidth, videoEl.videoHeight) : 0;
            stableStreak = (!smoothed || motion <= MAX_LOCK_MOVEMENT)
              ? Math.min(stableStreak + 1, 99)
              : 0;
            smoothed = !smoothed ? result : {
              corners: smoothed.corners.map((c, i) => ({
                x: c.x + (result.corners[i].x - c.x) * SMOOTH_ALPHA,
                y: c.y + (result.corners[i].y - c.y) * SMOOTH_ALPHA,
              })),
              score: result.score,
            };
            const locked = stableStreak >= STABLE_NEEDED;
            setState(locked ? "locked" : "searching");
            if (locked && !firedForThisLock && State.autoCaptureEnabled &&
                stableStreak >= STABLE_NEEDED + AUTO_HOLD_EXTRA) {
              firedForThisLock = true;
              if (onAutoCapture) onAutoCapture();
            }
          } else {
            missStreak++;
            stableStreak = 0;
            firedForThisLock = false;
            if (missStreak > MAX_MISS) { smoothed = null; setState("searching"); }
          }
        }
      } catch (err) {
        // detection must never break the capture flow
      }
      if (running && detectionEnabled) timer = setTimeout(tick, DETECT_INTERVAL);
    }

    function renderLoop() {
      if (!running || !detectionEnabled) return;
      drawOverlay();
      raf = requestAnimationFrame(renderLoop);
    }

    function drawOverlay() {
      const stage = videoEl.closest(".camera-stage");
      if (!stage) return;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const cw = stage.clientWidth, ch = stage.clientHeight;
      const needW = Math.round(cw * dpr), needH = Math.round(ch * dpr);
      if (overlayCanvas.width !== needW || overlayCanvas.height !== needH) {
        overlayCanvas.width = needW;
        overlayCanvas.height = needH;
        overlayCanvas.style.width = cw + "px";
        overlayCanvas.style.height = ch + "px";
      }
      overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      overlayCtx.clearRect(0, 0, cw, ch);
      if (!smoothed || !videoEl.videoWidth) return;

      const rect = CameraController.getPreviewSourceRect(cw / ch);
      if (!rect) return;
      const toDisplay = (p) => ({
        x: Math.max(0, Math.min(cw, (p.x - rect.sx) * cw / rect.sw)),
        y: Math.max(0, Math.min(ch, (p.y - rect.sy) * ch / rect.sh)),
      });
      const pts = smoothed.corners.map(toDisplay);

      const locked = stableStreak >= STABLE_NEEDED;
      const color = locked ? "#4ADE80" : "#22D3EE";
      overlayCtx.lineJoin = "round";
      overlayCtx.lineWidth = 3;
      overlayCtx.strokeStyle = color;
      overlayCtx.fillStyle = locked ? "rgba(74,222,128,0.14)" : "rgba(34,211,238,0.10)";
      overlayCtx.shadowColor = color;
      overlayCtx.shadowBlur = 10;
      overlayCtx.beginPath();
      overlayCtx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < 4; i++) overlayCtx.lineTo(pts[i].x, pts[i].y);
      overlayCtx.closePath();
      overlayCtx.fill();
      overlayCtx.stroke();
      overlayCtx.shadowBlur = 0;
      pts.forEach((p) => {
        overlayCtx.beginPath();
        overlayCtx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        overlayCtx.fillStyle = color;
        overlayCtx.fill();
      });
    }

    function setState(state) {
      const stage = document.querySelector(".camera-stage");
      const hint = $("#cameraHint");
      const badgeText = $("#detectBadgeText");
      const shutter = $("#shutterBtn");
      if (!stage) return;
      stage.classList.toggle("edge-locked", state === "locked");
      stage.classList.toggle("edge-searching", state === "searching");
      if (shutter) shutter.classList.toggle("ready", state === "locked");
      if (hint) hint.textContent = state === "manual" ? "Modo manual · toca para capturar" : state === "locked" ? "Documento detectado · toca para capturar" : "Buscando el documento…";
      if (badgeText) badgeText.textContent = state === "locked" ? "Listo" : "Buscando…";
    }

    function currentQuad() {
      return detectionEnabled && smoothed ? smoothed.corners : null;
    }

    function setEnabled(enabled) {
      if (!running || detectionEnabled === enabled) return;
      detectionEnabled = enabled;
      smoothed = null; missStreak = 0; stableStreak = 0; slowFallbackTick = 0; firedForThisLock = false;
      if (timer) clearTimeout(timer);
      if (raf) cancelAnimationFrame(raf);
      timer = null; raf = null;
      if (overlayCtx && overlayCanvas) overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      if (enabled) startDetection(); else setState("manual");
    }

    function quadMotion(previous, next, w, h) {
      const diagonal = Math.max(1, Math.hypot(w, h));
      return previous.reduce((sum, p, i) => sum + Math.hypot(p.x - next[i].x, p.y - next[i].y), 0) / (previous.length * diagonal);
    }

    return { start, stop, currentQuad, setEnabled };
  })();

  /* ---------------------------------------------------------------
   * App-wide state
   * --------------------------------------------------------------- */
  const State = {
    uploadQueue: [],      // pending source images (HTMLImageElement) awaiting crop
    currentPages: [],     // pages of the document being built
    activePage: null,     // page currently in the crop/edit pipeline
    editingExistingIndex: null, // index into currentPages when re-editing
    pendingDetectedCorners: null, // live-detected quad from the last shutter press
    editingDocId: null,   // id of the saved document being edited, or null for a new one
    autoCaptureEnabled: localStorage.getItem("skanix-autocapture") === "on",
  };

  function newPage(baseCanvas) {
    return {
      id: uid(),
      base: baseCanvas,      // perspective-corrected canvas, rotation 0, no filter
      rotation: 0,
      filter: "document",
      brightness: 0,
      contrast: 0,
      saturation: 0,
      annotations: [],       // {id,type:'text'|'signature', xFrac,yFrac,wFrac,hFrac, text,color,size,dataUrl}
      strokes: [],           // {id, color, width(frac of image width), points:[{x,y} frac]}
      watermark: null,       // {text, opacity(0-1), angle(deg)}
    };
  }

  // Signature/annotation images referenced by dataUrl are decoded once and
  // cached here so renderPage() (called very frequently: live edit preview,
  // thumbnails, export) can stay fully synchronous.
  const annotationImageCache = new Map();
  function preloadAnnotationImage(dataUrl) {
    if (annotationImageCache.has(dataUrl)) return Promise.resolve(annotationImageCache.get(dataUrl));
    return loadImage(dataUrl).then((img) => {
      annotationImageCache.set(dataUrl, img);
      return img;
    });
  }
  // Preload every signature image used anywhere in a page, resolving once
  // all are decoded and available to renderPage() synchronously.
  function preloadPageAssets(page) {
    const jobs = (page.annotations || [])
      .filter((a) => a.type === "signature" && a.dataUrl)
      .map((a) => preloadAnnotationImage(a.dataUrl));
    return Promise.all(jobs);
  }

  // Renders a page's base canvas through rotation + filter + adjustments,
  // then composites brush strokes, watermark and text/signature annotations
  // on top (in that order) at the output canvas's resolution.
  // Some mobile browsers (iOS Safari in particular) fail or silently
  // produce a blank/corrupt canvas above roughly 16.7M total pixels,
  // regardless of aspect ratio — a dimension-only cap can still exceed
  // that for a wide/landscape scan even when each side looks reasonable
  // on its own. Clamping by area too is what lets the per-call maxDim be
  // pushed high for real detail on typical portrait documents while still
  // staying safe for any aspect ratio.
  const SAFE_CANVAS_AREA = 15000000;

  function renderPage(page, maxDim = 1600) {
    let src = page.base;
    // rotation
    if (page.rotation % 360 !== 0) {
      const rad = (page.rotation * Math.PI) / 180;
      const swap = page.rotation % 180 !== 0;
      const w = swap ? src.height : src.width;
      const h = swap ? src.width : src.height;
      const rc = document.createElement("canvas");
      rc.width = w; rc.height = h;
      const rctx = rc.getContext("2d");
      rctx.translate(w / 2, h / 2);
      rctx.rotate(rad);
      rctx.drawImage(src, -src.width / 2, -src.height / 2);
      src = rc;
    }
    // downscale for performance/safety if huge
    let scale = 1;
    if (Math.max(src.width, src.height) > maxDim) {
      scale = maxDim / Math.max(src.width, src.height);
    }
    const projectedArea = src.width * scale * (src.height * scale);
    if (projectedArea > SAFE_CANVAS_AREA) {
      scale *= Math.sqrt(SAFE_CANVAS_AREA / projectedArea);
    }
    const out = document.createElement("canvas");
    out.width = Math.round(src.width * scale);
    out.height = Math.round(src.height * scale);
    const octx = out.getContext("2d");
    octx.drawImage(src, 0, 0, out.width, out.height);

    const imgData = octx.getImageData(0, 0, out.width, out.height);
    ImageProcessing.applyFilter(imgData, page.filter);
    ImageProcessing.applyAdjustments(imgData, {
      brightness: page.brightness,
      contrast: page.contrast,
      saturation: page.saturation,
    });
    octx.putImageData(imgData, 0, 0);

    const W = out.width, H = out.height;
    drawStrokes(octx, W, H, page.strokes);
    drawWatermark(octx, W, H, page.watermark);
    drawAnnotations(octx, W, H, page.annotations);
    return out;
  }

  function renderPageForOcr(page, maxDim = 2400) {
    let src = page.base;
    if (page.rotation % 360 !== 0) {
      const rad = (page.rotation * Math.PI) / 180;
      const swap = page.rotation % 180 !== 0;
      const w = swap ? src.height : src.width;
      const h = swap ? src.width : src.height;
      const rc = document.createElement("canvas");
      rc.width = w; rc.height = h;
      const rctx = rc.getContext("2d");
      rctx.translate(w / 2, h / 2);
      rctx.rotate(rad);
      rctx.drawImage(src, -src.width / 2, -src.height / 2);
      src = rc;
    }
    let scale = 1;
    if (Math.max(src.width, src.height) > maxDim) {
      scale = maxDim / Math.max(src.width, src.height);
    }
    const out = document.createElement("canvas");
    out.width = Math.round(src.width * scale);
    out.height = Math.round(src.height * scale);
    const octx = out.getContext("2d");
    octx.drawImage(src, 0, 0, out.width, out.height);

    const imgData = octx.getImageData(0, 0, out.width, out.height);
    ImageProcessing.prepareForOcr(imgData);
    octx.putImageData(imgData, 0, 0);
    return out;
  }

  function drawStrokes(ctx, W, H, strokes) {
    if (!strokes || !strokes.length) return;
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const s of strokes) {
      if (!s.points || s.points.length < 2) continue;
      ctx.strokeStyle = s.color || "#EF4444";
      ctx.lineWidth = Math.max(1, (s.width || 0.006) * W);
      ctx.beginPath();
      ctx.moveTo(s.points[0].x * W, s.points[0].y * H);
      for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x * W, s.points[i].y * H);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawWatermark(ctx, W, H, wm) {
    if (!wm || !wm.text) return;
    ctx.save();
    ctx.globalAlpha = Math.max(0.03, Math.min(1, wm.opacity ?? 0.18));
    ctx.fillStyle = "#111827";
    const fontSize = Math.round(W * 0.075);
    ctx.font = `700 ${fontSize}px 'Space Grotesk', sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const angle = ((wm.angle ?? -30) * Math.PI) / 180;
    const stepX = fontSize * (wm.text.length * 0.62 + 3);
    const stepY = fontSize * 3.2;
    ctx.translate(W / 2, H / 2);
    ctx.rotate(angle);
    const span = Math.ceil((Math.hypot(W, H)) / Math.min(stepX, stepY)) + 2;
    for (let row = -span; row <= span; row++) {
      for (let col = -span; col <= span; col++) {
        ctx.fillText(wm.text, col * stepX, row * stepY);
      }
    }
    ctx.restore();
  }

  function drawAnnotations(ctx, W, H, annotations) {
    if (!annotations || !annotations.length) return;
    for (const a of annotations) {
      if (a.type === "text") {
        ctx.save();
        const fontPx = Math.max(8, (a.size || 0.045) * H);
        ctx.font = `600 ${fontPx}px 'Inter', sans-serif`;
        ctx.fillStyle = a.color || "#111827";
        ctx.textBaseline = "top";
        ctx.fillText(a.text || "", a.xFrac * W, a.yFrac * H);
        ctx.restore();
      } else if (a.type === "signature" && a.dataUrl) {
        const img = annotationImageCache.get(a.dataUrl);
        if (!img) continue; // not decoded yet; will appear on next render pass
        ctx.drawImage(img, a.xFrac * W, a.yFrac * H, a.wFrac * W, a.hFrac * H);
      }
    }
  }

  // Cheap fingerprint of everything that affects a page's rendered pixels —
  // used to skip re-rendering a thumbnail when nothing actually changed.
  function pageThumbSignature(page) {
    return [
      page.rotation, page.filter, page.brightness, page.contrast, page.saturation,
      page.watermark ? `${page.watermark.text}|${page.watermark.opacity}|${page.watermark.angle}` : "",
      page.annotations.map((a) => `${a.id}:${a.xFrac.toFixed(3)}:${a.yFrac.toFixed(3)}:${a.text || ""}:${a.color || ""}:${a.size || ""}`).join(","),
      page.strokes.map((s) => `${s.id}:${s.points.length}`).join(","),
    ].join("|");
  }

  function pageThumb(page, maxDim = 500) {
    const sig = pageThumbSignature(page);
    if (!page._thumbCache) page._thumbCache = {};
    const cache = page._thumbCache[maxDim];
    if (cache && cache.base === page.base && cache.sig === sig) {
      return cache.url;
    }
    const url = renderPage(page, maxDim).toDataURL("image/jpeg", 0.82);
    page._thumbCache[maxDim] = { base: page.base, sig, url };
    return url;
  }

  /* ---------------------------------------------------------------
   * HOME VIEW — capture entry points + history
   * --------------------------------------------------------------- */
  function updatePendingBar() {
    const bar = $("#pendingBar");
    if (State.currentPages.length > 0) {
      bar.classList.remove("hidden");
      $("#pendingCount").textContent = State.currentPages.length;
    } else {
      bar.classList.add("hidden");
    }
  }

  let historyCache = [];
  async function renderHistory(query) {
    const grid = $("#historyGrid");
    historyCache = await DocuDB.getAll();
    const q = (query ?? $("#historySearchInput")?.value ?? "").trim().toLowerCase();
    const docs = q
      ? historyCache.filter((d) =>
          d.name.toLowerCase().includes(q) || (d.ocrText || "").toLowerCase().includes(q))
      : historyCache;

    if (historyCache.length === 0) {
      grid.innerHTML = `<p class="empty-hint">Aún no has escaneado ningún documento. Tus escaneos aparecerán aquí, guardados en este dispositivo.</p>`;
      return;
    }
    if (docs.length === 0) {
      grid.innerHTML = `<p class="empty-hint">Sin resultados para «${escapeHtml(q)}».</p>`;
      return;
    }
    grid.innerHTML = "";
    for (const doc of docs) {
      const card = document.createElement("div");
      card.className = "history-card";
      const date = new Date(doc.updatedAt || doc.createdAt);
      card.innerHTML = `
        <span class="hc-pages">${doc.pages.length} pág.</span>
        <img src="${doc.thumb || (typeof doc.pages[0] === "string" ? doc.pages[0] : "")}" alt="${escapeHtml(doc.name)}" loading="lazy" />
        <div class="hc-meta">
          <div class="hc-name">${escapeHtml(doc.name)}</div>
          <div class="hc-sub">${date.toLocaleDateString()}</div>
        </div>`;
      card.addEventListener("click", () => openDocumentForEdit(doc.id));
      grid.appendChild(card);
    }
  }

  let historySearchDebounce;
  $("#historySearchInput").addEventListener("input", (e) => {
    clearTimeout(historySearchDebounce);
    const val = e.target.value;
    historySearchDebounce = setTimeout(() => renderHistory(val), 180);
  });

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  $("#openCameraBtn").addEventListener("click", startCameraFlow);
  $("#openUploadBtn").addEventListener("click", () => $("#fileInput").click());
  $("#fileInput").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    for (const file of files) {
      const url = URL.createObjectURL(file);
      try {
        const img = await loadImage(url);
        State.uploadQueue.push(img);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    processNextInQueue();
  });
  $("#pendingReviewBtn").addEventListener("click", () => openReview());
  $("#clearHistoryBtn").addEventListener("click", async () => {
    if (!(await confirmDialog("¿Vaciar todo el historial de documentos guardados? Esta acción no se puede deshacer."))) return;
    await DocuDB.clear();
    renderHistory();
    toast("Historial eliminado");
  });

  /* ---------------------------------------------------------------
   * CAMERA VIEW
   * --------------------------------------------------------------- */
  async function startCameraFlow() {
    Router.show("view-camera");
    $("#cameraErrorState")?.classList.add("hidden");
    $("#cameraVideo")?.classList.remove("hidden");
    // The stream takes a moment (permission prompt, sensor warm-up) to
    // actually deliver frames. Disabling the shutter until then turns what
    // used to be a silent no-op tap into an obviously-disabled button, and
    // stops taps queued during that window from being dropped unseen.
    setShutterReady(false);
    try {
      await CameraController.start($("#cameraVideo"));
      setShutterReady(true);
      EdgeLoop.start($("#cameraVideo"), capturePhoto, State.autoCaptureEnabled);
    } catch (err) {
      showCameraError(err);
    }
  }

  function setShutterReady(ready) {
    const shutter = $("#shutterBtn");
    if (!shutter) return;
    shutter.disabled = !ready;
    shutter.classList.toggle("is-warming-up", !ready);
  }

  function showCameraError(err) {
    const name = err && err.name;
    let message = "No se pudo acceder a la cámara.";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      message = "Permiso de cámara denegado. Actívalo en los ajustes de tu navegador o del sistema para poder escanear.";
    } else if (name === "NotFoundError" || name === "OverconstrainedError") {
      message = "No se encontró ninguna cámara disponible en este dispositivo.";
    } else if (name === "NotReadableError") {
      message = "La cámara está siendo usada por otra aplicación. Ciérrala e inténtalo de nuevo.";
    }
    $("#cameraVideo")?.classList.add("hidden");
    const state = $("#cameraErrorState");
    if (state) {
      $("#cameraErrorText").textContent = message;
      state.classList.remove("hidden");
    } else {
      toast(message, "error");
      Router.show("view-home");
    }
  }
  $("#cameraRetryBtn")?.addEventListener("click", () => startCameraFlow());
  $("#cameraErrorBackBtn")?.addEventListener("click", () => {
    CameraController.stop();
    EdgeLoop.stop();
    Router.show("view-home");
  });

  $("#cameraBackBtn").addEventListener("click", () => {
    CameraController.stop();
    EdgeLoop.stop();
    Router.show("view-home");
  });
  $("#cameraSwitchBtn").addEventListener("click", async () => {
    setShutterReady(false);
    try {
      await CameraController.switchCamera();
      setShutterReady(true);
      EdgeLoop.start($("#cameraVideo"), capturePhoto, State.autoCaptureEnabled); // fresh stream -> restart detection cleanly
    } catch (err) {
      showCameraError(err);
    }
  });

  let captureInFlight = false;
  let captureWatchdog = null;
  async function capturePhoto() {
    if (captureInFlight) return; // one capture at a time; not an error, just a debounce
    if (!CameraController.isActive()) {
      // Previously a silent no-op — a tap here (typically right after
      // opening the camera or switching lenses, before the stream is live)
      // just did nothing with no feedback at all. Now the shutter is
      // disabled during that window (see setShutterReady), but keep this
      // as a safety net in case a tap lands in the gap anyway.
      toast("La cámara todavía se está preparando, un momento…", "error");
      return;
    }
    captureInFlight = true;
    // Belt-and-suspenders: no matter what unexpected thing goes wrong below
    // (a frozen video track, a stalled encode, a WebView quirk we haven't
    // hit yet), the shutter must never stay permanently unresponsive for
    // the rest of the session. If a capture hasn't finished within 10s,
    // force the flag back open so the very next tap can try again instead
    // of silently doing nothing forever.
    captureWatchdog = setTimeout(() => {
      if (captureInFlight) {
        console.warn("capturePhoto: watchdog fired, forcing capture state to reset");
        captureInFlight = false;
        toast("La captura tardó demasiado. Inténtalo de nuevo.", "error");
      }
    }, 10000);
    try {
    SoundFX.shutter();
    const flash = $("#flashOverlay");
    flash.classList.remove("flashing"); void flash.offsetWidth; flash.classList.add("flashing");

    // The controller crops the *same stream* with the exact object-fit:cover
    // geometry used by this stage. This eliminates the still-photo FOV swap.
    const stage = document.querySelector(".camera-stage");
    const stageAspect = stage ? stage.clientWidth / stage.clientHeight : null;

    const liveQuad = EdgeLoop.currentQuad(); // fallback only, live-preview pixel space

    const canvas = $("#captureCanvas");
    await CameraController.captureFrame(canvas, stageAspect);
    // Re-detect on the captured pixels, but retain the live result as a
    // direct geometry-preserving fallback if the still analysis is unsure.
    const freshQuad = EdgeDetector.detectFromCanvas(canvas);
    // A weak candidate is worse than no candidate: it can send the
    // perspective warp outside the image and look like a black/empty scan.
    if (freshQuad && freshQuad.score >= 0.10) {
      State.pendingDetectedCorners = freshQuad.corners;
    } else if (liveQuad) {
      State.pendingDetectedCorners = liveQuad.map((p) => CameraController.mapVideoPointToCapture(p)).filter(Boolean);
    } else {
      State.pendingDetectedCorners = null;
    }
    const img = await loadImageFromCanvas(canvas, { mime: "image/jpeg", quality: 0.96 });
    State.uploadQueue.push(img);
    // keep camera open for rapid multi-page capture; queue processes in background
    processNextInQueue();
    } catch (err) {
      console.error("capture failed", err);
      toast("No se pudo capturar la imagen. Inténtalo de nuevo.", "error");
    } finally {
      clearTimeout(captureWatchdog);
      captureWatchdog = null;
      captureInFlight = false;
    }
  }
  $("#shutterBtn").addEventListener("click", capturePhoto);

  $("#autoCaptureToggle").addEventListener("click", () => {
    State.autoCaptureEnabled = !State.autoCaptureEnabled;
    localStorage.setItem("skanix-autocapture", State.autoCaptureEnabled ? "on" : "off");
    syncAutoCaptureToggle();
    EdgeLoop.setEnabled(State.autoCaptureEnabled);
  });
  function syncAutoCaptureToggle() {
    const btn = $("#autoCaptureToggle");
    btn.classList.toggle("is-off", !State.autoCaptureEnabled);
    btn.setAttribute("aria-pressed", String(State.autoCaptureEnabled));
  }
  syncAutoCaptureToggle();

  /* ---------------------------------------------------------------
   * QUEUE -> CROP VIEW
   * --------------------------------------------------------------- */
  let queueBusy = false;
  async function processNextInQueue() {
    if (queueBusy) return;
    const img = State.uploadQueue.shift();
    if (!img) return;
    queueBusy = true;
    CameraController.stop();
    EdgeLoop.stop();
    // if this page came straight from a live camera capture, reuse the
    // exact quad that was locked on screen instead of re-analyzing a still
    // frame — it's already smoothed and the user saw it before shooting.
    const liveCorners = State.pendingDetectedCorners;
    State.pendingDetectedCorners = null;
    await openCropView(canvasFromImage(img), liveCorners);
  }

  /* ----- Crop editor ----- */
  const Crop = {
    canvas: null, ctx: null,
    sourceCanvas: null,
    corners: null,        // image-space {x,y} x4 (TL,TR,BR,BL)
    scale: 1,
    dragIndex: -1,
    dpr: Math.max(1, window.devicePixelRatio || 1),
  };

  async function openCropView(sourceCanvas, initialCorners) {
    Crop.sourceCanvas = sourceCanvas;
    Router.show("view-crop");
    Crop.canvas = $("#cropCanvas");
    Crop.ctx = Crop.canvas.getContext("2d");

    const stage = document.querySelector(".crop-stage");
    const cssW = stage.clientWidth;
    const cssH = Math.min(window.innerHeight * 0.55, cssW * (sourceCanvas.height / sourceCanvas.width));
    const scale = cssW / sourceCanvas.width;
    Crop.scale = scale;
    Crop.canvas.style.width = cssW + "px";
    Crop.canvas.style.height = Math.round(sourceCanvas.height * scale) + "px";
    Crop.canvas.width = Math.round(cssW * Crop.dpr);
    Crop.canvas.height = Math.round(sourceCanvas.height * scale * Crop.dpr);

    Crop.corners = initialCorners || ImageProcessing.detectDocumentCorners(sourceCanvas);
    drawCrop();
  }

  function drawCrop() {
    const { ctx, canvas, sourceCanvas, corners, scale, dpr } = Crop;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    ctx.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
    ctx.drawImage(sourceCanvas, 0, 0);

    // dim outside the quad
    ctx.save();
    ctx.fillStyle = "rgba(5,7,14,0.45)";
    ctx.beginPath();
    ctx.rect(0, 0, sourceCanvas.width, sourceCanvas.height);
    ctx.moveTo(corners[0].x, corners[0].y);
    ctx.lineTo(corners[1].x, corners[1].y);
    ctx.lineTo(corners[2].x, corners[2].y);
    ctx.lineTo(corners[3].x, corners[3].y);
    ctx.closePath();
    ctx.fill("evenodd");
    ctx.restore();

    // quad outline
    ctx.lineWidth = 2.5 / scale;
    ctx.strokeStyle = "#22D3EE";
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.stroke();

    // handles
    const r = 9 / scale;
    corners.forEach((c) => {
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(168,85,247,0.9)";
      ctx.fill();
      ctx.lineWidth = 2 / scale;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
    });
  }

  function canvasPointFromEvent(e) {
    const rect = Crop.canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const xCss = clientX - rect.left;
    const yCss = clientY - rect.top;
    return { x: xCss / Crop.scale, y: yCss / Crop.scale };
  }

  const LOUPE_SIZE = 116, LOUPE_ZOOM = 2.8;
  function clientPointFromEvent(e) {
    const t = e.touches ? (e.touches[0] || e.changedTouches[0]) : e;
    return { clientX: t.clientX, clientY: t.clientY };
  }
  function updateLoupe(clientPoint, imgPoint) {
    const loupe = $("#cropLoupe");
    const section = document.getElementById("view-crop");
    const sectionRect = section.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    if (Number(loupe.dataset.dpr) !== dpr) {
      loupe.width = LOUPE_SIZE * dpr;
      loupe.height = LOUPE_SIZE * dpr;
      loupe.style.width = LOUPE_SIZE + "px";
      loupe.style.height = LOUPE_SIZE + "px";
      loupe.dataset.dpr = dpr;
    }
    // Float above the touch point so the finger never covers the corner
    // it's actually about to place.
    let left = clientPoint.clientX - sectionRect.left - LOUPE_SIZE / 2;
    let top = clientPoint.clientY - sectionRect.top - LOUPE_SIZE - 48;
    left = Math.max(4, Math.min(sectionRect.width - LOUPE_SIZE - 4, left));
    top = Math.max(4, top);
    loupe.style.left = left + "px";
    loupe.style.top = top + "px";
    loupe.classList.remove("hidden");

    const lctx = loupe.getContext("2d");
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lctx.clearRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
    lctx.save();
    lctx.beginPath();
    lctx.arc(LOUPE_SIZE / 2, LOUPE_SIZE / 2, LOUPE_SIZE / 2 - 1, 0, Math.PI * 2);
    lctx.clip();
    const srcSize = LOUPE_SIZE / LOUPE_ZOOM;
    lctx.drawImage(
      Crop.sourceCanvas,
      imgPoint.x - srcSize / 2, imgPoint.y - srcSize / 2, srcSize, srcSize,
      0, 0, LOUPE_SIZE, LOUPE_SIZE
    );
    lctx.strokeStyle = "rgba(168,85,247,.95)";
    lctx.lineWidth = 1.5;
    lctx.beginPath();
    lctx.moveTo(LOUPE_SIZE / 2 - 9, LOUPE_SIZE / 2); lctx.lineTo(LOUPE_SIZE / 2 + 9, LOUPE_SIZE / 2);
    lctx.moveTo(LOUPE_SIZE / 2, LOUPE_SIZE / 2 - 9); lctx.lineTo(LOUPE_SIZE / 2, LOUPE_SIZE / 2 + 9);
    lctx.stroke();
    lctx.restore();
  }
  function hideLoupe() { $("#cropLoupe").classList.add("hidden"); }

  function setupCropInteraction() {
    const canvas = $("#cropCanvas");
    const HIT_R = 26;

    function down(e) {
      if (!Crop.corners) return;
      const p = canvasPointFromEvent(e);
      let best = -1, bestD = Infinity;
      Crop.corners.forEach((c, i) => {
        const d = Math.hypot((c.x - p.x) * Crop.scale, (c.y - p.y) * Crop.scale);
        if (d < bestD) { bestD = d; best = i; }
      });
      if (bestD <= HIT_R) {
        Crop.dragIndex = best;
        e.preventDefault();
        updateLoupe(clientPointFromEvent(e), Crop.corners[best]);
      }
    }
    function move(e) {
      if (Crop.dragIndex === -1) return;
      e.preventDefault();
      const p = canvasPointFromEvent(e);
      const sc = Crop.sourceCanvas;
      p.x = Math.max(0, Math.min(sc.width, p.x));
      p.y = Math.max(0, Math.min(sc.height, p.y));
      Crop.corners[Crop.dragIndex] = p;
      drawCrop();
      updateLoupe(clientPointFromEvent(e), p);
    }
    function up() { Crop.dragIndex = -1; hideLoupe(); }

    canvas.addEventListener("mousedown", down);
    canvas.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    canvas.addEventListener("touchstart", down, { passive: false });
    canvas.addEventListener("touchmove", move, { passive: false });
    canvas.addEventListener("touchend", up);
  }
  setupCropInteraction();

  // dir: 1 = clockwise, -1 = counter-clockwise. Rotates the actual source
  // image (not a CSS transform) and remaps the corner points to match,
  // including cycling their array order so index 0 keeps meaning
  // "top-left" — warpPerspective() below reads corners by position, so a
  // rotation that only transforms coordinates without re-cycling the
  // array would crop correctly but come out rotated 90° in the final page.
  function rotateCropSource(dir) {
    const src = Crop.sourceCanvas;
    const oldW = src.width, oldH = src.height;
    const rotated = document.createElement("canvas");
    rotated.width = oldH; rotated.height = oldW;
    const rctx = rotated.getContext("2d");
    rctx.translate(rotated.width / 2, rotated.height / 2);
    rctx.rotate((dir * Math.PI) / 2);
    rctx.drawImage(src, -oldW / 2, -oldH / 2);

    if (Crop.corners) {
      const mapPoint = dir === 1
        ? (p) => ({ x: oldH - p.y, y: p.x })
        : (p) => ({ x: p.y, y: oldW - p.x });
      const order = [0, 1, 2, 3].map((i) => (dir === 1 ? (i - 1 + 4) % 4 : (i + 1) % 4));
      Crop.corners = order.map((i) => mapPoint(Crop.corners[i]));
    }

    Crop.sourceCanvas = rotated;
    const stage = document.querySelector(".crop-stage");
    const cssW = stage.clientWidth;
    const scale = cssW / rotated.width;
    Crop.scale = scale;
    Crop.canvas.style.width = cssW + "px";
    Crop.canvas.style.height = Math.round(rotated.height * scale) + "px";
    Crop.canvas.width = Math.round(cssW * Crop.dpr);
    Crop.canvas.height = Math.round(rotated.height * scale * Crop.dpr);
    drawCrop();
  }
  $("#cropRotateLeftBtn").addEventListener("click", () => rotateCropSource(-1));
  $("#cropRotateRightBtn").addEventListener("click", () => rotateCropSource(1));

  $("#cropAutoBtn").addEventListener("click", () => {
    Crop.corners = ImageProcessing.detectDocumentCorners(Crop.sourceCanvas);
    drawCrop();
    toast("Bordes detectados automáticamente");
  });
  $("#cropResetBtn").addEventListener("click", () => {
    const sc = Crop.sourceCanvas;
    const mx = sc.width * 0.04, my = sc.height * 0.04;
    Crop.corners = [
      { x: mx, y: my }, { x: sc.width - mx, y: my },
      { x: sc.width - mx, y: sc.height - my }, { x: mx, y: sc.height - my },
    ];
    drawCrop();
  });
  $("#cropBackBtn").addEventListener("click", () => {
    queueBusy = false;
    if (State.currentPages.length > 0) openReview();
    else Router.show("view-home");
  });
  $("#cropConfirmBtn").addEventListener("click", async () => {
    const warped = ImageProcessing.warpPerspective(Crop.sourceCanvas, Crop.corners);
    if (State.editingExistingIndex !== null) {
      const p = State.currentPages[State.editingExistingIndex];
      p.base = warped; p.rotation = 0;
      State.activePage = p;
    } else {
      State.activePage = newPage(warped);
    }
    // The image is now handed off to the edit step (tracked separately via
    // State.activePage/editingExistingIndex) — it's no longer "checked out
    // of the upload queue" from processNextInQueue's point of view. This
    // was previously never reset here (only on cropBackBtn/addPageBtn), so
    // if the user cropped+confirmed one photo and then tried to upload or
    // capture a *second* one before finishing the edit of the first,
    // processNextInQueue's `if (queueBusy) return;` silently swallowed it —
    // no error, no crop view, nothing. Same root cause for camera and file
    // upload, since both funnel through processNextInQueue().
    queueBusy = false;
    openEditView();
  });

  /* ---------------------------------------------------------------
   * EDIT VIEW (filters / adjustments / transform)
   * --------------------------------------------------------------- */
  // Keeps edits reversible without copying the original photo for each step.
  // The base canvas is immutable during normal editing; snapshots therefore
  // contain only lightweight page metadata and remain safe on mobile.
  const EditHistory = (() => {
    const LIMIT = 40;
    let past = [], future = [], current = null;
    const snapshot = (page) => JSON.stringify({
      rotation: page.rotation, filter: page.filter, brightness: page.brightness,
      contrast: page.contrast, saturation: page.saturation,
      annotations: page.annotations || [], strokes: page.strokes || [], watermark: page.watermark || null,
    });
    function refreshButtons() {
      $("#editUndoBtn").disabled = past.length === 0;
      $("#editRedoBtn").disabled = future.length === 0;
    }
    function reset(page) { past = []; future = []; current = page ? snapshot(page) : null; refreshButtons(); }
    function record(page) {
      if (!page) return;
      const next = snapshot(page);
      if (current === null) { current = next; refreshButtons(); return; }
      if (next === current) return;
      past.push(current); if (past.length > LIMIT) past.shift();
      current = next; future = []; refreshButtons();
    }
    function restore(page, value) {
      const data = JSON.parse(value);
      Object.assign(page, data);
      current = value;
      syncEditControls(page);
      renderEditCanvas();
      scheduleAutosave();
      refreshButtons();
    }
    function undo(page) {
      if (!page || !past.length) return;
      future.push(current); restore(page, past.pop());
    }
    function redo(page) {
      if (!page || !future.length) return;
      past.push(current); restore(page, future.pop());
    }
    return { reset, record, undo, redo };
  })();

  function syncEditControls(p) {
    $$(".filter-chip").forEach((b) => b.classList.toggle("active", b.dataset.filter === p.filter));
    $("#rangeBrightness").value = p.brightness; $("#outBrightness").textContent = p.brightness;
    $("#rangeContrast").value = p.contrast; $("#outContrast").textContent = p.contrast;
    $("#rangeSaturation").value = p.saturation; $("#outSaturation").textContent = p.saturation;
  }

  let editRenderToken = 0;
  function openEditView() {
    Router.show("view-edit");
    const p = State.activePage;
    syncEditControls(p);
    EditHistory.reset(p);
    // reset to the Filtros tab each time a page is opened
    $$(".edit-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === "filters"));
    $$(".edit-panel").forEach((panel) => panel.classList.toggle("hidden", panel.id !== "panel-filters"));
    Annotate.setActive(false);
    Annotate.bindPage(p);
    resetOcrPanel();
    if (p.watermark) {
      $("#watermarkText").value = p.watermark.text || "";
      $("#watermarkOpacity").value = Math.round((p.watermark.opacity ?? 0.18) * 100);
      $("#watermarkAngle").value = p.watermark.angle ?? -30;
    } else {
      $("#watermarkText").value = "";
      $("#watermarkOpacity").value = 18;
      $("#watermarkAngle").value = -30;
    }
    renderEditCanvas();
  }

  const FILTER_THUMB_SIZE = 84;
  function renderFilterThumbnails(page) {
    let src = page.base;
    if (page.rotation % 360 !== 0) {
      const rad = (page.rotation * Math.PI) / 180;
      const swap = page.rotation % 180 !== 0;
      const w = swap ? src.height : src.width;
      const h = swap ? src.width : src.height;
      const rc = document.createElement("canvas");
      rc.width = w; rc.height = h;
      const rctx = rc.getContext("2d");
      rctx.translate(w / 2, h / 2);
      rctx.rotate(rad);
      rctx.drawImage(src, -src.width / 2, -src.height / 2);
      src = rc;
    }
    // Center-crop a square so the preview shows real document content
    // (text/texture), not letterboxed empty margins.
    const side = Math.min(src.width, src.height);
    const sx = (src.width - side) / 2, sy = (src.height - side) / 2;
    const S = FILTER_THUMB_SIZE;
    const base = document.createElement("canvas");
    base.width = S; base.height = S;
    const bctx = base.getContext("2d");
    bctx.drawImage(src, sx, sy, side, side, 0, 0, S, S);
    const baseData = bctx.getImageData(0, 0, S, S);

    $$(".filter-chip").forEach((chip) => {
      const filter = chip.dataset.filter;
      const tmp = document.createElement("canvas");
      tmp.width = S; tmp.height = S;
      const tctx = tmp.getContext("2d");
      const imgData = tctx.createImageData(S, S);
      imgData.data.set(baseData.data);
      ImageProcessing.applyFilter(imgData, filter);
      ImageProcessing.applyAdjustments(imgData, {
        brightness: page.brightness, contrast: page.contrast, saturation: page.saturation,
      });
      tctx.putImageData(imgData, 0, 0);
      const swatch = chip.querySelector(".fchip-swatch");
      if (swatch) {
        swatch.style.backgroundImage = `url(${tmp.toDataURL("image/jpeg", 0.85)})`;
      }
    });
  }

  async function renderEditCanvas() {
    const token = ++editRenderToken;
    $("#editLoader").classList.remove("hidden");
    await new Promise((r) => requestAnimationFrame(r)); // let loader paint
    const p = State.activePage;
    const out = renderPage(p, 1400);
    if (token !== editRenderToken) return; // superseded by a newer render
    const canvas = $("#editCanvas");
    canvas.width = out.width; canvas.height = out.height;
    canvas.getContext("2d").drawImage(out, 0, 0);
    $("#editLoader").classList.add("hidden");
    Annotate.syncOverlaySize();
    renderFilterThumbnails(p);
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }
  const debouncedRender = debounce(renderEditCanvas, 120);

  $$(".edit-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".edit-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      $$(".edit-panel").forEach((p) => p.classList.add("hidden"));
      $(`#panel-${tab.dataset.tab}`).classList.remove("hidden");
      Annotate.setActive(tab.dataset.tab === "annotate");
    });
  });

  $("#filterStrip").addEventListener("click", (e) => {
    const btn = e.target.closest(".filter-chip");
    if (!btn) return;
    $$(".filter-chip").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    State.activePage.filter = btn.dataset.filter;
    debouncedRender();
    scheduleAutosave();
  });

  function clampRange(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // Solves for the (brightness, contrast) slider pair that reproduces a
  // target linear levels-stretch output=(input-black)*k through the app's
  // existing contrast formula: cFactor*(input+brightness-128)+128.
  // Matching slopes gives cFactor=k; matching the constant term gives
  // brightness; contrast is then cFactor's inverse under the app's own
  // (259*(c+255))/(255*(259-c)) curve.
  function autoEnhanceValues(black, white) {
    const k = clampRange(255 / Math.max(1, white - black), 0.5, 2.2);
    const brightness = clampRange(Math.round(128 * (1 - 1 / k) - black), -100, 100);
    const contrastRaw = (255 * 259 * (k - 1)) / (259 + 255 * k);
    const contrast = clampRange(Math.round(contrastRaw), -100, 100);
    return { brightness, contrast };
  }

  function computeAutoEnhance(page) {
    const SIZE = 150;
    const src = page.base;
    const scale = SIZE / Math.max(src.width, src.height);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(src.width * scale));
    c.height = Math.max(1, Math.round(src.height * scale));
    const ctx = c.getContext("2d");
    ctx.drawImage(src, 0, 0, c.width, c.height);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const hist = new Uint32Array(256);
    const n = c.width * c.height;
    for (let i = 0; i < data.length; i += 4) {
      const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      hist[l | 0]++;
    }
    const lo = n * 0.01, hi = n * 0.99;
    let cum = 0, black = 0, white = 255;
    for (let v = 0; v < 256; v++) { cum += hist[v]; if (cum >= lo) { black = v; break; } }
    cum = 0;
    for (let v = 255; v >= 0; v--) { cum += hist[v]; if (cum >= n - hi) { white = v; break; } }
    if (white - black < 40) { black = Math.max(0, black - 20); white = Math.min(255, white + 20); }
    const { brightness, contrast } = autoEnhanceValues(black, white);
    return { brightness, contrast, saturation: 8 };
  }

  $("#autoEnhanceBtn").addEventListener("click", () => {
    const p = State.activePage;
    const { brightness, contrast, saturation } = computeAutoEnhance(p);
    p.brightness = brightness; p.contrast = contrast; p.saturation = saturation;
    $("#rangeBrightness").value = brightness; $("#outBrightness").textContent = brightness;
    $("#rangeContrast").value = contrast; $("#outContrast").textContent = contrast;
    $("#rangeSaturation").value = saturation; $("#outSaturation").textContent = saturation;
    renderEditCanvas();
    scheduleAutosave();
    toast("Mejora automática aplicada ✓", "success");
  });

  function bindSlider(rangeId, outId, prop) {
    const range = $(rangeId), out = $(outId);
    range.addEventListener("input", () => {
      out.textContent = range.value;
      State.activePage[prop] = Number(range.value);
      debouncedRender();
    });
    range.addEventListener("change", scheduleAutosave);
  }
  bindSlider("#rangeBrightness", "#outBrightness", "brightness");
  bindSlider("#rangeContrast", "#outContrast", "contrast");
  bindSlider("#rangeSaturation", "#outSaturation", "saturation");
  $("#resetAdjustBtn").addEventListener("click", () => {
    State.activePage.brightness = 0; State.activePage.contrast = 0; State.activePage.saturation = 0;
    $("#rangeBrightness").value = 0; $("#outBrightness").textContent = "0";
    $("#rangeContrast").value = 0; $("#outContrast").textContent = "0";
    $("#rangeSaturation").value = 0; $("#outSaturation").textContent = "0";
    renderEditCanvas();
    scheduleAutosave();
  });

  $("#rotateLeftBtn").addEventListener("click", () => {
    State.activePage.rotation = (State.activePage.rotation + 270) % 360;
    renderEditCanvas();
    scheduleAutosave();
  });
  $("#rotateRightBtn").addEventListener("click", () => {
    State.activePage.rotation = (State.activePage.rotation + 90) % 360;
    renderEditCanvas();
    scheduleAutosave();
  });
  $("#editUndoBtn").addEventListener("click", () => EditHistory.undo(State.activePage));
  $("#editRedoBtn").addEventListener("click", () => EditHistory.redo(State.activePage));
  window.addEventListener("keydown", (event) => {
    const target = event.target;
    if (!(event.ctrlKey || event.metaKey) || event.altKey || target.matches("input, textarea, [contenteditable=true]")) return;
    if (event.key.toLowerCase() === "z") {
      event.preventDefault();
      event.shiftKey ? EditHistory.redo(State.activePage) : EditHistory.undo(State.activePage);
    } else if (event.key.toLowerCase() === "y") {
      event.preventDefault(); EditHistory.redo(State.activePage);
    }
  });
  $("#backToCropBtn").addEventListener("click", async () => {
    await openCropView(State.activePage.base);
  });
  $("#retakePhotoBtn").addEventListener("click", () => {
    // editingExistingIndex stays set so the new shot replaces this exact page
    startCameraFlow();
  });

  $("#editBackBtn").addEventListener("click", async () => {
    await openCropView(Crop.sourceCanvas || State.activePage.base);
  });

  $("#addPageBtn").addEventListener("click", () => {
    if (State.editingExistingIndex !== null) {
      State.currentPages[State.editingExistingIndex] = State.activePage;
      State.editingExistingIndex = null;
    } else {
      State.currentPages.push(State.activePage);
    }
    State.activePage = null;
    queueBusy = false;
    updatePendingBar();
    scheduleAutosave();
    if (State.uploadQueue.length > 0) {
      processNextInQueue();
    } else {
      openReview();
    }
    toast("Página añadida ✓", "success");
  });

  /* ---------------------------------------------------------------
   * ANNOTATE — text, signature, brush and watermark tools layered on
   * top of the edit canvas via a transparent interaction overlay.
   * Coordinates are stored as fractions (0..1) of the image size so
   * they stay correct at any render resolution (preview vs export).
   * --------------------------------------------------------------- */
  const Annotate = (() => {
    let page = null, active = false, tool = null;
    let overlay = null, octx = null;
    let overlayOffset = { left: 0, top: 0 };
    let selectedId = null;
    let dragging = false, dragStart = null, dragOrigFrac = null;
    let brushDrawing = false, brushPoints = [];
    let brushColor = "#EF4444", brushWidth = 3;

    function bindPage(p) {
      page = p;
      if (!page.annotations) page.annotations = [];
      if (!page.strokes) page.strokes = [];
      selectedId = null; tool = null;
      $$(".ann-tool").forEach((b) => b.classList.remove("active"));
      $("#annSubpanelBrush").classList.add("hidden");
      $("#annSubpanelWatermark").classList.add("hidden");
      $("#annHint").textContent = "Elige una herramienta para empezar a anotar sobre el documento.";
      hideFloatingBar();
    }

    function setActive(isActive) {
      active = isActive;
      overlay = $("#annotateOverlay");
      overlay.classList.toggle("hidden", !isActive);
      if (!isActive) { hideFloatingBar(); return; }
      octx = overlay.getContext("2d");
      syncOverlaySize();
    }

    function syncOverlaySize() {
      if (!active || !overlay) return;
      const canvas = $("#editCanvas");
      const stage = canvas.closest(".edit-stage");
      const canvasRect = canvas.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      overlayOffset = { left: canvasRect.left - stageRect.left, top: canvasRect.top - stageRect.top };
      overlay.style.left = overlayOffset.left + "px";
      overlay.style.top = overlayOffset.top + "px";
      overlay.style.width = canvasRect.width + "px";
      overlay.style.height = canvasRect.height + "px";
      overlay.width = Math.round(canvasRect.width * dpr);
      overlay.height = Math.round(canvasRect.height * dpr);
      octx = overlay.getContext("2d");
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawSelection();
    }

    function cssSize() {
      const rect = overlay.getBoundingClientRect();
      return { w: rect.width, h: rect.height };
    }
    function pointFromEvent(e) {
      const rect = overlay.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function textBounds(a, cw, ch) {
      octx.font = `600 ${a.size * ch}px 'Inter', sans-serif`;
      const w = Math.max(20, octx.measureText(a.text || "").width);
      const h = a.size * ch * 1.15;
      return { x: a.xFrac * cw, y: a.yFrac * ch, w, h };
    }
    function sigBounds(a, cw, ch) {
      return { x: a.xFrac * cw, y: a.yFrac * ch, w: a.wFrac * cw, h: a.hFrac * ch };
    }
    function boundsOf(a, cw, ch) { return a.type === "text" ? textBounds(a, cw, ch) : sigBounds(a, cw, ch); }
    function currentSelected() { return (page?.annotations || []).find((x) => x.id === selectedId) || null; }

    function hitTest(pt) {
      const { w: cw, h: ch } = cssSize();
      const list = page.annotations || [];
      for (let i = list.length - 1; i >= 0; i--) {
        const b = boundsOf(list[i], cw, ch);
        if (pt.x >= b.x - 8 && pt.x <= b.x + b.w + 8 && pt.y >= b.y - 8 && pt.y <= b.y + b.h + 8) return list[i];
      }
      return null;
    }

    function drawSelection() {
      if (!octx) return;
      const { w: cw, h: ch } = cssSize();
      octx.clearRect(0, 0, cw, ch);
      if (tool === "brush" && brushDrawing && brushPoints.length > 1) {
        octx.strokeStyle = brushColor; octx.lineWidth = brushWidth; octx.lineJoin = "round"; octx.lineCap = "round";
        octx.beginPath();
        octx.moveTo(brushPoints[0].x, brushPoints[0].y);
        for (let i = 1; i < brushPoints.length; i++) octx.lineTo(brushPoints[i].x, brushPoints[i].y);
        octx.stroke();
      }
      if (!selectedId) { hideFloatingBar(); return; }
      const a = currentSelected();
      if (!a) { hideFloatingBar(); return; }
      const b = boundsOf(a, cw, ch);
      octx.save();
      octx.strokeStyle = "#8B5CF6"; octx.lineWidth = 1.5; octx.setLineDash([5, 4]);
      octx.strokeRect(b.x - 6, b.y - 6, b.w + 12, b.h + 12);
      octx.restore();
      positionFloatingBar(b, a.type === "text");
    }

    function positionFloatingBar(b, isText) {
      const bar = $("#annotateFloatingBar");
      bar.classList.remove("hidden");
      bar.style.left = (overlayOffset.left + b.x + b.w / 2) + "px";
      bar.style.top = Math.max(0, overlayOffset.top + b.y - 42) + "px";
      $("#annEditTextBtn").style.display = isText ? "" : "none";
    }
    function hideFloatingBar() { $("#annotateFloatingBar")?.classList.add("hidden"); }

    $$(".ann-tool").forEach((btn) => {
      btn.addEventListener("click", () => {
        const t = btn.dataset.tool;
        if (t === "text") { addText(); return; }
        if (t === "signature") { openSignatureModal(); return; }
        tool = tool === t ? null : t;
        $$(".ann-tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
        $("#annSubpanelBrush").classList.toggle("hidden", tool !== "brush");
        $("#annSubpanelWatermark").classList.toggle("hidden", tool !== "watermark");
        selectedId = null;
        $("#annHint").textContent =
          tool === "brush" ? "Dibuja directamente sobre el documento con el dedo o el mouse." :
          tool === "watermark" ? "Configura tu marca de agua y presiona Aplicar." :
          "Elige una herramienta para empezar a anotar sobre el documento.";
        drawSelection();
      });
    });

    async function addText() {
      const text = await textInputDialog("Añadir texto", "");
      if (!text) return;
      const a = { id: uid(), type: "text", xFrac: 0.28, yFrac: 0.42, size: 0.045, color: "#111827", text: text.slice(0, 200) };
      page.annotations.push(a);
      selectedId = a.id; tool = null;
      $$(".ann-tool").forEach((b) => b.classList.remove("active"));
      renderEditCanvas().then(drawSelection);
      scheduleAutosave();
    }

    $("#annEditTextBtn").addEventListener("click", async () => {
      const a = currentSelected();
      if (!a || a.type !== "text") return;
      const text = await textInputDialog("Editar texto", a.text);
      if (text === null) return;
      a.text = text.slice(0, 200);
      renderEditCanvas().then(drawSelection);
      scheduleAutosave();
    });
    $("#annDeleteBtn").addEventListener("click", () => {
      if (!selectedId || !page) return;
      page.annotations = page.annotations.filter((a) => a.id !== selectedId);
      selectedId = null; hideFloatingBar();
      renderEditCanvas();
      scheduleAutosave();
    });

    $("#brushColorRow").addEventListener("click", (e) => {
      const sw = e.target.closest(".swatch"); if (!sw) return;
      $("#brushColorRow").querySelectorAll(".swatch").forEach((s) => s.classList.remove("active"));
      sw.classList.add("active");
      brushColor = sw.dataset.color;
    });
    $("#brushWidthRange").addEventListener("input", (e) => { brushWidth = Number(e.target.value); });
    $("#brushUndoBtn").addEventListener("click", () => {
      if (!page || !page.strokes.length) return;
      page.strokes.pop();
      renderEditCanvas(); scheduleAutosave();
    });
    $("#brushClearBtn").addEventListener("click", () => {
      if (!page) return;
      page.strokes = [];
      renderEditCanvas(); scheduleAutosave();
    });

    $("#watermarkApplyBtn").addEventListener("click", () => {
      if (!page) return;
      const text = $("#watermarkText").value.trim();
      if (!text) { toast("Escribe el texto de la marca de agua", "error"); return; }
      page.watermark = { text, opacity: Number($("#watermarkOpacity").value) / 100, angle: Number($("#watermarkAngle").value) };
      renderEditCanvas(); scheduleAutosave();
      toast("Marca de agua aplicada", "success");
    });
    $("#watermarkRemoveBtn").addEventListener("click", () => {
      if (!page) return;
      page.watermark = null;
      $("#watermarkText").value = "";
      renderEditCanvas(); scheduleAutosave();
    });

    function onPointerDown(e) {
      if (!active || !page) return;
      const pt = pointFromEvent(e);
      if (tool === "brush") {
        brushDrawing = true; brushPoints = [pt];
        overlay.setPointerCapture(e.pointerId);
        return;
      }
      const hit = hitTest(pt);
      if (hit) {
        selectedId = hit.id; dragging = true; dragStart = pt;
        dragOrigFrac = { x: hit.xFrac, y: hit.yFrac };
        overlay.setPointerCapture(e.pointerId);
      } else {
        selectedId = null;
      }
      drawSelection();
    }
    function onPointerMove(e) {
      if (!active) return;
      const pt = pointFromEvent(e);
      if (tool === "brush" && brushDrawing) { brushPoints.push(pt); drawSelection(); return; }
      if (dragging && selectedId) {
        const { w: cw, h: ch } = cssSize();
        const a = currentSelected();
        if (!a) return;
        const dx = (pt.x - dragStart.x) / cw, dy = (pt.y - dragStart.y) / ch;
        const maxX = 1 - (a.wFrac || 0.06), maxY = 1 - (a.hFrac || 0.06);
        a.xFrac = Math.max(0, Math.min(maxX, dragOrigFrac.x + dx));
        a.yFrac = Math.max(0, Math.min(maxY, dragOrigFrac.y + dy));
        drawSelection();
      }
    }
    function onPointerUp() {
      if (tool === "brush" && brushDrawing) {
        brushDrawing = false;
        if (brushPoints.length > 1) {
          const { w: cw, h: ch } = cssSize();
          page.strokes.push({
            id: uid(), color: brushColor, width: brushWidth / cw,
            points: brushPoints.map((p) => ({ x: p.x / cw, y: p.y / ch })),
          });
          renderEditCanvas();
          scheduleAutosave();
        }
        brushPoints = [];
        drawSelection();
        return;
      }
      if (dragging) { dragging = false; renderEditCanvas().then(drawSelection); scheduleAutosave(); }
    }

    (function initOverlayEvents() {
      const el = $("#annotateOverlay");
      el.addEventListener("pointerdown", onPointerDown);
      el.addEventListener("pointermove", onPointerMove);
      el.addEventListener("pointerup", onPointerUp);
      el.addEventListener("pointercancel", onPointerUp);
    })();

    /* ----- signature modal ----- */
    const Sig = { canvas: null, ctx: null, drawing: false };
    function openSignatureModal() {
      $("#signatureModal").classList.remove("hidden");
      $("#signatureUseSavedBtn").classList.toggle("hidden", !localStorage.getItem("skanix-saved-signature"));
      $("#signatureRemember").checked = false;
      Sig.canvas = $("#signatureCanvas");
      Sig.ctx = Sig.canvas.getContext("2d");
      const rect = Sig.canvas.getBoundingClientRect();
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      Sig.canvas.width = Math.round(rect.width * dpr);
      Sig.canvas.height = Math.round(rect.height * dpr);
      Sig.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      Sig.ctx.clearRect(0, 0, rect.width, rect.height);
      Sig.ctx.lineJoin = "round"; Sig.ctx.lineCap = "round";
      Sig.ctx.strokeStyle = "#111827"; Sig.ctx.lineWidth = 2.6;
    }
    function sigPoint(e) {
      const rect = Sig.canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }
    $("#signatureCanvas").addEventListener("pointerdown", (e) => {
      Sig.drawing = true;
      const p = sigPoint(e);
      Sig.ctx.beginPath(); Sig.ctx.moveTo(p.x, p.y);
      e.target.setPointerCapture(e.pointerId);
    });
    $("#signatureCanvas").addEventListener("pointermove", (e) => {
      if (!Sig.drawing) return;
      const p = sigPoint(e);
      Sig.ctx.lineTo(p.x, p.y); Sig.ctx.stroke();
    });
    $("#signatureCanvas").addEventListener("pointerup", () => { Sig.drawing = false; });
    $("#signatureClearBtn").addEventListener("click", () => {
      const rect = Sig.canvas.getBoundingClientRect();
      Sig.ctx.clearRect(0, 0, rect.width, rect.height);
    });
    $("#signatureCancelBtn").addEventListener("click", () => $("#signatureModal").classList.add("hidden"));
    async function insertSignature(dataUrl) {
      await preloadAnnotationImage(dataUrl);
      const a = {
        id: uid(), type: "signature", xFrac: 0.28, yFrac: 0.58, wFrac: 0.36,
        hFrac: 0.36 * (Sig.canvas.height / Sig.canvas.width), dataUrl,
      };
      page.annotations.push(a);
      selectedId = a.id;
      $("#signatureModal").classList.add("hidden");
      renderEditCanvas().then(drawSelection);
      scheduleAutosave();
    }
    $("#signatureInsertBtn").addEventListener("click", async () => {
      const blank = await isCanvasBlank(Sig.canvas);
      if (blank) { toast("Dibuja tu firma antes de insertarla", "error"); return; }
      const dataUrl = Sig.canvas.toDataURL("image/png");
      if ($("#signatureRemember").checked) {
        try { localStorage.setItem("skanix-saved-signature", dataUrl); }
        catch (err) { toast("La firma se insertó, pero no se pudo guardar para reutilizarla", "error"); }
      }
      await insertSignature(dataUrl);
    });
    $("#signatureUseSavedBtn").addEventListener("click", async () => {
      const dataUrl = localStorage.getItem("skanix-saved-signature");
      if (dataUrl) await insertSignature(dataUrl);
    });
    function isCanvasBlank(canvas) {
      const ctx = canvas.getContext("2d");
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return Promise.resolve(false);
      return Promise.resolve(true);
    }

    return { bindPage, setActive, syncOverlaySize };
  })();

  /* ---------------------------------------------------------------
   * OCR + TRANSLATION PANEL
   * --------------------------------------------------------------- */
  function resetOcrPanel() {
    $("#ocrProgress").classList.add("hidden");
    $("#ocrResultWrap").classList.add("hidden");
    $("#ocrResultText").value = "";
    $("#ocrTranslatedText").value = "";
    $("#ocrTranslatedText").classList.add("hidden");
  }

  $("#ocrRunBtn").addEventListener("click", async () => {
    if (!State.activePage) return;
    const btn = $("#ocrRunBtn");
    btn.disabled = true;
    $("#ocrProgress").classList.remove("hidden");
    $("#ocrResultWrap").classList.add("hidden");
    $("#ocrProgressFill").style.width = "0%";
    $("#ocrProgressLabel").textContent = "Preparando reconocimiento…";
    try {
      const canvas = renderPageForOcr(State.activePage, 2400);
      const { text } = await OCR.recognize(canvas, "spa", (progress) => {
        const pct = Math.round(progress * 100);
        $("#ocrProgressFill").style.width = pct + "%";
        $("#ocrProgressLabel").textContent = `Reconociendo texto… ${pct}%`;
      });
      $("#ocrResultText").value = text || "No se detectó texto en esta página.";
      $("#ocrResultWrap").classList.remove("hidden");
      if (State.editingDocId) {
        const doc = await DocuDB.getById(State.editingDocId);
        if (doc) {
          doc.ocrText = ((doc.ocrText || "") + " " + text).slice(0, 20000);
          await DocuDB.saveDocument(doc);
        }
      }
    } catch (err) {
      console.error(err);
      toast("No se pudo extraer el texto (se necesita conexión la primera vez)", "error");
    } finally {
      btn.disabled = false;
      $("#ocrProgress").classList.add("hidden");
    }
  });

  $("#ocrCopyBtn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("#ocrResultText").value);
      toast("Texto copiado ✓", "success");
    } catch (err) {
      toast("No se pudo copiar el texto", "error");
    }
  });
  $("#ocrTxtBtn").addEventListener("click", () => {
    const blob = new Blob([$("#ocrResultText").value], { type: "text/plain" });
    downloadBlob(blob, `${($("#fileNameInput").value || "Documento").trim()}.txt`);
  });
  $("#ocrDocxBtn").addEventListener("click", async () => {
    const btn = $("#ocrDocxBtn");
    btn.disabled = true;
    try {
      const blob = await Exporters.buildTextDocx($("#ocrResultText").value, $("#fileNameInput").value || "Documento");
      downloadBlob(blob, `${($("#fileNameInput").value || "Documento").trim()}.docx`);
    } catch (err) {
      console.error(err);
      toast("No se pudo generar el .docx", "error");
    } finally {
      btn.disabled = false;
    }
  });
  $("#ocrTranslateBtn").addEventListener("click", async () => {
    const text = $("#ocrResultText").value.trim();
    if (!text) { toast("Primero extrae el texto de la página", "error"); return; }
    const btn = $("#ocrTranslateBtn");
    btn.disabled = true; const original = btn.textContent; btn.textContent = "Traduciendo…";
    try {
      const translated = await OCR.translate(text, $("#ocrTranslateLang").value);
      $("#ocrTranslatedText").value = translated;
      $("#ocrTranslatedText").classList.remove("hidden");
    } catch (err) {
      console.error(err);
      toast("No se pudo traducir (revisa tu conexión)", "error");
    } finally {
      btn.disabled = false; btn.textContent = original;
    }
  });

  /* ---------------------------------------------------------------
   * REVIEW / EXPORT VIEW
   * --------------------------------------------------------------- */
  function openReview() {
    Router.show("view-review");
    $("#reviewTitle").textContent = State.editingDocId ? ($("#fileNameInput").value || "Documento") : "Tu documento";
    $("#reviewEditActions").classList.toggle("hidden", !State.editingDocId);
    renderReviewGrid();
  }

  let reviewSelectMode = false;
  let reviewSelectedIds = new Set();

  function renderReviewGrid() {
    const grid = $("#reviewGrid");
    grid.innerHTML = "";
    $("#reviewCount").textContent = `${State.currentPages.length} página${State.currentPages.length === 1 ? "" : "s"}`;
    State.currentPages.forEach((page, i) => {
      const card = document.createElement("div");
      card.className = "review-card" + (reviewSelectMode ? " select-mode" : "") + (reviewSelectedIds.has(page.id) ? " selected" : "");
      card.draggable = !reviewSelectMode;
      card.dataset.index = i;
      card.dataset.pageId = page.id;
      card.innerHTML = `
        <span class="rc-num">${i + 1}</span>
        <img src="${pageThumb(page, 360)}" alt="Página ${i + 1}" />
        <span class="rc-check" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="13" height="13"><path d="M5 13l4 4L19 7" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </span>
        <span class="rc-handle" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="13" height="13"><circle cx="8" cy="6" r="1.4" fill="currentColor"/><circle cx="16" cy="6" r="1.4" fill="currentColor"/><circle cx="8" cy="12" r="1.4" fill="currentColor"/><circle cx="16" cy="12" r="1.4" fill="currentColor"/><circle cx="8" cy="18" r="1.4" fill="currentColor"/><circle cx="16" cy="18" r="1.4" fill="currentColor"/></svg>
        </span>
        <button class="rc-remove" aria-label="Eliminar página">
          <svg viewBox="0 0 24 24" width="12" height="12"><path d="M18 6 6 18M6 6l12 12" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>
        </button>
        <span class="rc-reorder">
          <button class="rc-move" data-dir="-1" aria-label="Mover a la izquierda" ${i === 0 ? "disabled" : ""}>‹</button>
          <button class="rc-move" data-dir="1" aria-label="Mover a la derecha" ${i === State.currentPages.length - 1 ? "disabled" : ""}>›</button>
        </span>`;
      card.querySelector(".rc-remove").addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = State.currentPages.findIndex((p) => p.id === page.id);
        if (idx > -1) State.currentPages.splice(idx, 1);
        renderReviewGrid();
        updatePendingBar();
        scheduleAutosave();
      });
      card.querySelectorAll(".rc-move").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const idx = State.currentPages.findIndex((p) => p.id === page.id);
          const dir = Number(btn.dataset.dir);
          const to = idx + dir;
          if (to < 0 || to >= State.currentPages.length) return;
          const [moved] = State.currentPages.splice(idx, 1);
          State.currentPages.splice(to, 0, moved);
          renderReviewGrid();
          scheduleAutosave();
        });
      });
      card.addEventListener("click", (e) => {
        if (e.target.closest(".rc-remove") || e.target.closest(".rc-move")) return;
        if (reviewSelectMode) {
          if (reviewSelectedIds.has(page.id)) reviewSelectedIds.delete(page.id);
          else reviewSelectedIds.add(page.id);
          renderReviewGrid();
          return;
        }
        const idx = State.currentPages.findIndex((p) => p.id === page.id);
        State.editingExistingIndex = idx;
        State.activePage = State.currentPages[idx];
        Crop.sourceCanvas = State.activePage.base;
        openEditView();
      });
      // drag-and-drop reorder (mouse / trackpad / touch-capable browsers)
      card.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", page.id);
        e.dataTransfer.effectAllowed = "move";
        requestAnimationFrame(() => card.classList.add("dragging"));
      });
      card.addEventListener("dragend", () => card.classList.remove("dragging"));
      card.addEventListener("dragover", (e) => {
        e.preventDefault();
        card.classList.add("drag-over");
      });
      card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
      card.addEventListener("drop", (e) => {
        e.preventDefault();
        card.classList.remove("drag-over");
        const fromId = e.dataTransfer.getData("text/plain");
        const from = State.currentPages.findIndex((p) => p.id === fromId);
        const to = State.currentPages.findIndex((p) => p.id === page.id);
        if (from === -1 || to === -1 || from === to) return;
        const [moved] = State.currentPages.splice(from, 1);
        State.currentPages.splice(to, 0, moved);
        renderReviewGrid();
        scheduleAutosave();
      });
      grid.appendChild(card);
    });
    updateReviewSelectBar();
  }

  function updateReviewSelectBar() {
    const validIds = new Set(State.currentPages.map((p) => p.id));
    for (const id of [...reviewSelectedIds]) if (!validIds.has(id)) reviewSelectedIds.delete(id);
    $("#reviewSelectBar").classList.toggle("hidden", !reviewSelectMode);
    $("#reviewSelectModeBtn").textContent = reviewSelectMode ? "Listo" : "Seleccionar";
    $("#reviewSelectCount").textContent = `${reviewSelectedIds.size} seleccionada${reviewSelectedIds.size === 1 ? "" : "s"}`;
    $("#reviewSelectDeleteBtn").disabled = reviewSelectedIds.size === 0;
  }

  $("#reviewSelectModeBtn").addEventListener("click", () => {
    reviewSelectMode = !reviewSelectMode;
    if (!reviewSelectMode) reviewSelectedIds.clear();
    renderReviewGrid();
  });
  $("#reviewSelectCancelBtn").addEventListener("click", () => {
    reviewSelectMode = false;
    reviewSelectedIds.clear();
    renderReviewGrid();
  });
  $("#reviewSelectAllBtn").addEventListener("click", () => {
    const allSelected = reviewSelectedIds.size === State.currentPages.length;
    reviewSelectedIds = allSelected ? new Set() : new Set(State.currentPages.map((p) => p.id));
    renderReviewGrid();
  });
  $("#reviewSelectDeleteBtn").addEventListener("click", async () => {
    if (reviewSelectedIds.size === 0) return;
    const n = reviewSelectedIds.size;
    const ok = await confirmDialog(`¿Eliminar ${n} página${n === 1 ? "" : "s"} seleccionada${n === 1 ? "" : "s"}?`);
    if (!ok) return;
    State.currentPages = State.currentPages.filter((p) => !reviewSelectedIds.has(p.id));
    reviewSelectedIds.clear();
    reviewSelectMode = false;
    renderReviewGrid();
    updatePendingBar();
    scheduleAutosave();
    toast(`${n} página${n === 1 ? "" : "s"} eliminada${n === 1 ? "" : "s"}`, "success");
  });

  $("#addMorePagesCameraBtn").addEventListener("click", () => {
    State.editingExistingIndex = null;
    startCameraFlow();
  });
  $("#addMorePagesUploadBtn").addEventListener("click", () => {
    State.editingExistingIndex = null;
    $("#fileInput").click();
  });

  $("#rangeQuality").addEventListener("input", (e) => {
    $("#outQuality").textContent = `${e.target.value}%`;
  });

  function updateSearchablePdfVisibility() {
    const format = document.querySelector('input[name="format"]:checked').value;
    $("#searchablePdfRow").classList.toggle("hidden", format !== "pdf");
  }
  $$('input[name="format"]').forEach((r) => r.addEventListener("change", updateSearchablePdfVisibility));
  updateSearchablePdfVisibility();

  async function addSearchableTextLayer(pdf, pageIndex, page, pdfPageCanvas) {
    const ocrCanvas = renderPageForOcr(page, 2400);
    const { words } = await OCR.recognize(ocrCanvas, "spa");
    if (!words || !words.length) return;
    const scaleX = pdfPageCanvas.width / ocrCanvas.width;
    const scaleY = pdfPageCanvas.height / ocrCanvas.height;
    pdf.setPage(pageIndex + 1);
    for (const word of words) {
      const b = word.bbox;
      if (!b) continue;
      const x0 = b.x0 * scaleX, y0 = b.y0 * scaleY, x1 = b.x1 * scaleX, y1 = b.y1 * scaleY;
      const boxW = x1 - x0, boxH = y1 - y0;
      if (boxW <= 0 || boxH <= 0) continue;
      // Font size approximates the word's real height; the text is
      // invisible so exact glyph-width matching doesn't matter visually —
      // anchoring each word at its real start position (x0,y1) is what
      // keeps click-to-select regions lined up with the image underneath.
      pdf.setFontSize(Math.max(4, boxH * 0.82));
      pdf.text(word.text, x0, y1, { renderingMode: "invisible" });
    }
  }

  async function buildExportBlobs(onProgress) {
    const format = document.querySelector('input[name="format"]:checked').value;
    const quality = Number($("#rangeQuality").value) / 100;
    const name = ($("#fileNameInput").value || "Documento").trim() || "Documento";
    // Render pages one at a time with a yield in between instead of one
    // blocking .map() over the whole document — keeps the UI (progress
    // label, spinner) responsive instead of freezing for the entire
    // multi-page render before any feedback can paint.
    const pages = [];
    for (let i = 0; i < State.currentPages.length; i++) {
      pages.push(renderPage(State.currentPages[i], 4800));
      if (onProgress) onProgress(i + 1, State.currentPages.length);
      await new Promise((r) => requestAnimationFrame(r));
    }

    if (format === "pdf") {
      const { jsPDF } = window.jspdf;
      let pdf;
      pages.forEach((canvas, i) => {
        const w = canvas.width, h = canvas.height;
        const orientation = w > h ? "l" : "p";
        if (i === 0) {
          pdf = new jsPDF({ orientation, unit: "pt", format: [w, h] });
        } else {
          pdf.addPage([w, h], orientation);
        }
        const dataUrl = canvas.toDataURL("image/jpeg", Math.max(0.35, quality));
        pdf.addImage(dataUrl, "JPEG", 0, 0, w, h);
      });

      if ($("#searchablePdfCheck").checked) {
        for (let i = 0; i < State.currentPages.length; i++) {
          if (onProgress) onProgress(i + 1, State.currentPages.length, "ocr");
          try {
            await addSearchableTextLayer(pdf, i, State.currentPages[i], pages[i]);
          } catch (err) {
            // OCR failing on one page shouldn't block the export — the PDF
            // still has that page's image, just without a text layer.
            console.warn("OCR text layer failed for page", i, err);
          }
        }
      }

      const blob = pdf.output("blob");
      return [{ blob, filename: `${name}.pdf`, mime: "application/pdf" }];
    }

    if (format === "docx") {
      const blob = await Exporters.buildImagesDocx(pages);
      return [{ blob, filename: `${name}.docx`, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }];
    }

    // image formats: one file per page
    const mime = format === "png" ? "image/png" : "image/jpeg";
    const ext = format === "png" ? "png" : "jpg";
    const files = [];
    for (let i = 0; i < pages.length; i++) {
      const blob = await new Promise((resolve) => pages[i].toBlob(resolve, mime, quality));
      const suffix = pages.length > 1 ? `_${i + 1}` : "";
      files.push({ blob, filename: `${name}${suffix}.${ext}`, mime });
    }
    return files;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /* ---------------------------------------------------------------
   * PERSISTENCE — save the document being built/edited to IndexedDB,
   * preserving every page's editable state (not just a flat export),
   * so it can be reopened and fully edited again later. Also drives
   * silent autosave whenever an already-saved document changes.
   * --------------------------------------------------------------- */
  // page.base only ever changes identity on crop/retake (a fresh canvas is
  // created); every other edit (filter, adjustments, annotations, rotation,
  // watermark) leaves it untouched. Caching its JPEG encode by canvas
  // identity means autosave — which fires after *every* edit — stops
  // paying to re-encode every page's full original photo each time.
  const baseDataUrlCache = new WeakMap();
  function getBaseDataUrl(canvas) {
    let url = baseDataUrlCache.get(canvas);
    if (!url) {
      url = canvas.toDataURL("image/jpeg", 0.92);
      baseDataUrlCache.set(canvas, url);
    }
    return url;
  }

  async function persistCurrentDocument() {
    const name = ($("#fileNameInput").value || "Documento").trim() || "Documento";
    const pagesData = State.currentPages.map((p) => ({
      id: p.id,
      base: getBaseDataUrl(p.base),
      rotation: p.rotation,
      filter: p.filter,
      brightness: p.brightness,
      contrast: p.contrast,
      saturation: p.saturation,
      annotations: p.annotations || [],
      strokes: p.strokes || [],
      watermark: p.watermark || null,
    }));
    const thumb = State.currentPages.length ? pageThumb(State.currentPages[0], 500) : null;
    const existing = State.editingDocId ? await DocuDB.getById(State.editingDocId) : null;
    const doc = {
      id: State.editingDocId || uid(),
      name,
      createdAt: existing ? existing.createdAt : Date.now(),
      updatedAt: Date.now(),
      thumb,
      ocrText: existing ? existing.ocrText : undefined,
      pages: pagesData,
    };
    await DocuDB.saveDocument(doc);
    State.editingDocId = doc.id;
    return doc;
  }

  let autosaveTimer = null;
  let autosaveErrorShown = false;
  function scheduleAutosave() {
    // Record before checking persisted-document state: history must work
    // while composing a brand-new scan as well as after reopening one.
    EditHistory.record(State.activePage);
    if (!State.editingDocId) return; // only autosave documents already in history
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(async () => {
      try {
        await persistCurrentDocument();
        autosaveErrorShown = false;
        const hint = $("#reviewSavedHint");
        if (hint) {
          hint.textContent = "Guardado ✓";
          hint.classList.remove("hidden");
          hint.classList.add("pulse");
          setTimeout(() => hint.classList.remove("pulse"), 900);
        }
        // Note: the home history grid is refreshed when the user actually
        // navigates there (see the bottom-nav click handler) — no need to
        // rebuild it here too on every autosave tick while it's off-screen.
      } catch (err) {
        console.error("autosave failed", err);
        if (!autosaveErrorShown) {
          autosaveErrorShown = true;
          const quota = err?.name === "QuotaExceededError" || /quota|space|storage/i.test(err?.message || "");
          toast(quota ? "No hay espacio suficiente para guardar el documento. Libera espacio e inténtalo de nuevo." : "No se pudo guardar el cambio. Tus ediciones siguen abiertas.", "error");
        }
      }
    }, 1200);
  }

  $("#saveExportBtn").addEventListener("click", async () => {
    if (State.currentPages.length === 0) { toast("Añade al menos una página primero", "error"); return; }
    const btn = $("#saveExportBtn");
    btn.disabled = true; const original = btn.textContent; btn.textContent = "Exportando…";
    try {
      const files = await buildExportBlobs((done, total, phase) => {
        if (phase === "ocr") {
          btn.textContent = `Reconociendo texto ${done}/${total}…`;
        } else {
          btn.textContent = total > 1 ? `Exportando ${done}/${total}…` : "Exportando…";
        }
      });
      files.forEach((f) => downloadBlob(f.blob, f.filename));
      await persistCurrentDocument();

      State.currentPages = [];
      State.editingDocId = null;
      updatePendingBar();
      renderHistory();
      Router.show("view-home");
      toast("Documento exportado y guardado ✓", "success");
    } catch (err) {
      console.error(err);
      toast("No se pudo exportar el documento", "error");
    } finally {
      btn.disabled = false; btn.textContent = original;
    }
  });

  $("#shareBtn").addEventListener("click", async () => {
    if (State.currentPages.length === 0) { toast("Añade al menos una página primero", "error"); return; }
    try {
      const files = await buildExportBlobs();
      const shareFiles = files.map((f) => new File([f.blob], f.filename, { type: f.mime }));
      if (navigator.canShare && navigator.canShare({ files: shareFiles })) {
        await navigator.share({ files: shareFiles, title: $("#fileNameInput").value || "Documento" });
      } else {
        files.forEach((f) => downloadBlob(f.blob, f.filename));
        toast("Compartir no está disponible; se descargó el archivo");
      }
    } catch (err) {
      if (err.name !== "AbortError") toast("No se pudo compartir el archivo", "error");
    }
  });

  /* ---------------------------------------------------------------
   * OPEN A SAVED DOCUMENT FOR FULL EDITING
   * Reconstructs editable page objects (canvas + filters + adjustments +
   * annotations) from the persisted dataURLs and drops the user straight
   * into the same review/edit pipeline used for brand-new documents —
   * add, remove, reorder, replace or re-edit any page, then it autosaves.
   * --------------------------------------------------------------- */
  async function openDocumentForEdit(id) {
    const doc = await DocuDB.getById(id);
    if (!doc) return;
    try {
      const pages = await Promise.all(doc.pages.map(async (pd) => {
        const isLegacy = typeof pd === "string"; // pre-Fase-2 documents stored flat thumbnail strings
        const img = await loadImage(isLegacy ? pd : pd.base);
        const page = {
          id: (!isLegacy && pd.id) || uid(),
          base: canvasFromImage(img),
          rotation: (!isLegacy && pd.rotation) || 0,
          filter: (!isLegacy && pd.filter) || "document",
          brightness: (!isLegacy && pd.brightness) || 0,
          contrast: (!isLegacy && pd.contrast) || 0,
          saturation: (!isLegacy && pd.saturation) || 0,
          annotations: (!isLegacy && pd.annotations) || [],
          strokes: (!isLegacy && pd.strokes) || [],
          watermark: (!isLegacy && pd.watermark) || null,
        };
        await preloadPageAssets(page);
        return page;
      }));
      State.currentPages = pages;
      State.editingDocId = doc.id;
      State.editingExistingIndex = null;
      State.activePage = null;
      $("#fileNameInput").value = doc.name;
      openReview();
    } catch (err) {
      console.error(err);
      toast("No se pudo abrir el documento", "error");
    }
  }

  $("#reviewDeleteBtn").addEventListener("click", async () => {
    if (!State.editingDocId) return;
    if (!(await confirmDialog("¿Eliminar este documento de tu historial? Esta acción no se puede deshacer."))) return;
    await DocuDB.remove(State.editingDocId);
    State.currentPages = [];
    State.editingDocId = null;
    updatePendingBar();
    renderHistory();
    Router.show("view-home");
    toast("Documento eliminado");
  });

  $("#reviewRenameBtn").addEventListener("click", async () => {
    const current = $("#fileNameInput").value || "Documento";
    const name = await textInputDialog("Renombrar documento", current);
    if (!name) return;
    $("#fileNameInput").value = name.trim().slice(0, 60) || current;
    $("#reviewTitle").textContent = $("#fileNameInput").value;
    if (State.editingDocId) { await persistCurrentDocument(); renderHistory(); }
    toast("Documento renombrado", "success");
  });

  /* ---------------------------------------------------------------
   * Bottom navigation / theme / install
   * --------------------------------------------------------------- */
  $$(".nav-btn[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.nav;
      if (target === "view-review" && State.currentPages.length === 0) {
        toast("Aún no hay páginas en el documento actual");
        return;
      }
      Router.show(target);
      if (target === "view-review") renderReviewGrid();
      if (target === "view-home") renderHistory();
    });
  });
  document.querySelector('[data-action="scan-now"]').addEventListener("click", startCameraFlow);

  function applyTheme(theme) {
    document.body.dataset.theme = theme;
    localStorage.setItem("skanix-theme", theme);
  }
  $("#themeToggle").addEventListener("click", () => {
    const next = document.body.dataset.theme === "light" ? "dark" : "light";
    applyTheme(next);
  });
  (function initTheme() {
    const saved = localStorage.getItem("skanix-theme");
    if (saved) applyTheme(saved);
    else if (window.matchMedia("(prefers-color-scheme: light)").matches) applyTheme("light");
  })();

  let deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    $("#installBtn").classList.remove("hidden");
  });
  $("#installBtn").addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $("#installBtn").classList.add("hidden");
  });
  window.addEventListener("appinstalled", () => $("#installBtn").classList.add("hidden"));

  /* ---------------------------------------------------------------
   * Service worker registration (offline support) — web/PWA only.
   * Wrapped natively (Capacitor), the app already ships as bundled
   * local files with no network dependency, so a service worker adds
   * nothing and iOS's WKWebView doesn't reliably support one anyway.
   * --------------------------------------------------------------- */
  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  if ("serviceWorker" in navigator && !isNative) {
    let swRegistration = null;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js")
        .then((reg) => { swRegistration = reg; })
        .catch((err) => console.warn("SW registration failed", err));
    });
    // Once a new service worker activates and takes control, the page
    // that's currently open is still running the OLD cached code in
    // memory — reload once so the user actually sees the update instead
    // of silently staying on stale JS until their next manual refresh.
    // Only do this for a genuine update (there was already a controller
    // before) — controllerchange also fires on the very first install,
    // where there's nothing to "update" from and reloading would just be
    // an unwanted flash on first visit.
    const hadControllerAtLoad = !!navigator.serviceWorker.controller;
    let reloadedForUpdate = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloadedForUpdate || !hadControllerAtLoad) return;
      reloadedForUpdate = true;
      window.location.reload();
    });
    // Proactively check for a new version instead of waiting on the
    // browser's own update heuristics, which are tied to full navigations
    // — an installed/homescreen PWA can stay suspended in the background
    // for days without one, silently missing updates a desktop browser
    // (reloaded/reopened more often) would already have. Re-check every
    // time the app is foregrounded, plus every 10 minutes while it stays
    // open, so a genuine update surfaces (and auto-reloads, per above)
    // within moments of the app actually being used.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && swRegistration) {
        swRegistration.update().catch(() => {});
      }
    });
    setInterval(() => {
      if (swRegistration) swRegistration.update().catch(() => {});
    }, 10 * 60 * 1000);
  }

  /* ---------------------------------------------------------------
   * Native shell integration (Capacitor)
   * --------------------------------------------------------------- */
  if (isNative) {
    // No install prompt inside a native app.
    $("#installBtn")?.classList.add("hidden");

    const Plugins = window.Capacitor.Plugins || {};
    Plugins.StatusBar?.setBackgroundColor?.({ color: "#0B0E1A" }).catch(() => {});
    Plugins.StatusBar?.setStyle?.({ style: "DARK" }).catch(() => {});

    // Android hardware back button: close any open dialog first, then
    // fall back to each view's own Cancel/Back button (so behaviour
    // matches tapping it by hand), then minimize instead of hard-exiting
    // from the home screen — abrupt app-kill on back-press is jarring
    // and not how well-behaved Android apps handle the root screen.
    Plugins.App?.addListener?.("backButton", () => {
      const openDialog = $$(".dialog-backdrop").find((d) => !d.classList.contains("hidden"));
      if (openDialog) {
        const cancelBtn = openDialog.querySelector("#signatureCancelBtn, #textAnnotateCancelBtn, #confirmCancel");
        (cancelBtn || openDialog.querySelector(".btn-secondary"))?.click();
        return;
      }
      const activeView = $(".view.view-active")?.id;
      const backButtonByView = {
        "view-camera": "#cameraBackBtn",
        "view-crop": "#cropBackBtn",
        "view-edit": "#editBackBtn",
        "view-review": null, // no dedicated back button — falls through to Router.show below
      };
      if (activeView && activeView in backButtonByView) {
        const sel = backButtonByView[activeView];
        if (sel) { $(sel)?.click(); return; }
        Router.show("view-home");
        return;
      }
      // Already at the root view — minimize rather than kill the app.
      Plugins.App?.minimizeApp?.();
    });
  }

  /* ---------------------------------------------------------------
   * Init
   * --------------------------------------------------------------- */
  renderHistory();
  updatePendingBar();
})();
