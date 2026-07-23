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
    show(viewId) {
      $$(".view").forEach((v) => v.classList.remove("view-active"));
      $(`#${viewId}`).classList.add("view-active");
      $$(".nav-btn[data-nav]").forEach((b) =>
        b.classList.toggle("nav-active", b.dataset.nav === viewId)
      );
      window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
      if (viewId !== "view-camera") { CameraController.stop(); EdgeLoop.stop(); }
    },
  };

  /* ---------------------------------------------------------------
   * LIVE EDGE DETECTION — real-time document outline over the camera
   * preview (Sobel + connected components, see js/edgeDetector.js),
   * temporally smoothed so the overlay glides instead of jittering.
   * --------------------------------------------------------------- */
  const EdgeLoop = (() => {
    const SMOOTH_ALPHA = 0.35;
    const MAX_MISS = 6;
    const STABLE_NEEDED = 4;
    const DETECT_INTERVAL = 180; // ms between analysis passes

    let raf = null, timer = null, running = false;
    let smoothed = null;   // {corners, score} in video-native pixel space
    let missStreak = 0, stableStreak = 0;
    let overlayCanvas = null, overlayCtx = null, videoEl = null;

    function start(video) {
      stop();
      videoEl = video;
      overlayCanvas = $("#edgeOverlay");
      overlayCtx = overlayCanvas.getContext("2d");
      smoothed = null; missStreak = 0; stableStreak = 0;
      running = true;
      setState("searching");
      tick();
      raf = requestAnimationFrame(renderLoop);
    }

    function stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      raf = null; timer = null;
      if (overlayCtx && overlayCanvas) overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      const stage = document.querySelector(".camera-stage");
      if (stage) stage.classList.remove("edge-locked", "edge-searching");
      const shutter = $("#shutterBtn");
      if (shutter) shutter.classList.remove("ready");
      smoothed = null;
    }

    function tick() {
      if (!running) return;
      try {
        if (videoEl.readyState >= 2) {
          const result = EdgeDetector.detectFromVideoFrame(videoEl);
          if (result) {
            missStreak = 0;
            stableStreak = Math.min(stableStreak + 1, 99);
            smoothed = !smoothed ? result : {
              corners: smoothed.corners.map((c, i) => ({
                x: c.x + (result.corners[i].x - c.x) * SMOOTH_ALPHA,
                y: c.y + (result.corners[i].y - c.y) * SMOOTH_ALPHA,
              })),
              score: result.score,
            };
            setState(stableStreak >= STABLE_NEEDED ? "locked" : "searching");
          } else {
            missStreak++;
            stableStreak = 0;
            if (missStreak > MAX_MISS) { smoothed = null; setState("searching"); }
          }
        }
      } catch (err) {
        // detection must never break the capture flow
      }
      timer = setTimeout(tick, DETECT_INTERVAL);
    }

    function renderLoop() {
      if (!running) return;
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

      const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
      const scale = Math.max(cw / vw, ch / vh); // object-fit: cover mapping
      const drawnW = vw * scale, drawnH = vh * scale;
      const offX = (cw - drawnW) / 2, offY = (ch - drawnH) / 2;
      const toDisplay = (p) => ({ x: p.x * scale + offX, y: p.y * scale + offY });
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
      if (hint) hint.textContent = state === "locked" ? "Documento detectado · toca para capturar" : "Buscando el documento…";
      if (badgeText) badgeText.textContent = state === "locked" ? "Listo" : "Buscando…";
    }

    function currentQuad() {
      return smoothed ? smoothed.corners : null;
    }

    return { start, stop, currentQuad };
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
    // downscale for performance if huge
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

  function pageThumb(page, maxDim = 500) {
    return renderPage(page, maxDim).toDataURL("image/jpeg", 0.82);
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
    try {
      await CameraController.start($("#cameraVideo"));
      EdgeLoop.start($("#cameraVideo"));
    } catch (err) {
      toast("No se pudo acceder a la cámara. Revisa los permisos.", "error");
      Router.show("view-home");
    }
  }

  $("#cameraBackBtn").addEventListener("click", () => {
    CameraController.stop();
    EdgeLoop.stop();
    Router.show("view-home");
  });
  $("#cameraSwitchBtn").addEventListener("click", async () => {
    await CameraController.switchCamera();
    EdgeLoop.start($("#cameraVideo")); // fresh stream -> restart detection cleanly
  });
  $("#shutterBtn").addEventListener("click", async () => {
    if (!CameraController.isActive()) return;
    SoundFX.shutter();
    const flash = $("#flashOverlay");
    flash.classList.remove("flashing"); void flash.offsetWidth; flash.classList.add("flashing");

    const canvas = $("#captureCanvas");
    CameraController.captureFrame(canvas);
    // capture the live-detected quad (native video pixel space, matches
    // captureFrame's canvas exactly) before it's cleared by EdgeLoop.stop()
    State.pendingDetectedCorners = EdgeLoop.currentQuad();
    const img = await loadImage(canvas.toDataURL("image/jpeg", 0.95));
    State.uploadQueue.push(img);
    // keep camera open for rapid multi-page capture; queue processes in background
    processNextInQueue();
  });

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
    }
    function up() { Crop.dragIndex = -1; }

    canvas.addEventListener("mousedown", down);
    canvas.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    canvas.addEventListener("touchstart", down, { passive: false });
    canvas.addEventListener("touchmove", move, { passive: false });
    canvas.addEventListener("touchend", up);
  }
  setupCropInteraction();

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
    openEditView();
  });

  /* ---------------------------------------------------------------
   * EDIT VIEW (filters / adjustments / transform)
   * --------------------------------------------------------------- */
  let editRenderToken = 0;
  function openEditView() {
    Router.show("view-edit");
    const p = State.activePage;
    $$(".filter-chip").forEach((b) => b.classList.toggle("active", b.dataset.filter === p.filter));
    $("#rangeBrightness").value = p.brightness; $("#outBrightness").textContent = p.brightness;
    $("#rangeContrast").value = p.contrast; $("#outContrast").textContent = p.contrast;
    $("#rangeSaturation").value = p.saturation; $("#outSaturation").textContent = p.saturation;
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
  });

  function bindSlider(rangeId, outId, prop) {
    const range = $(rangeId), out = $(outId);
    range.addEventListener("input", () => {
      out.textContent = range.value;
      State.activePage[prop] = Number(range.value);
      debouncedRender();
    });
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
  });

  $("#rotateLeftBtn").addEventListener("click", () => {
    State.activePage.rotation = (State.activePage.rotation + 270) % 360;
    renderEditCanvas();
  });
  $("#rotateRightBtn").addEventListener("click", () => {
    State.activePage.rotation = (State.activePage.rotation + 90) % 360;
    renderEditCanvas();
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

    function addText() {
      const text = prompt("Texto a añadir:", "Texto");
      if (!text) return;
      const a = { id: uid(), type: "text", xFrac: 0.28, yFrac: 0.42, size: 0.045, color: "#111827", text: text.slice(0, 200) };
      page.annotations.push(a);
      selectedId = a.id; tool = null;
      $$(".ann-tool").forEach((b) => b.classList.remove("active"));
      renderEditCanvas().then(drawSelection);
      scheduleAutosave();
    }

    $("#annEditTextBtn").addEventListener("click", () => {
      const a = currentSelected();
      if (!a || a.type !== "text") return;
      const text = prompt("Editar texto:", a.text);
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
    $("#signatureInsertBtn").addEventListener("click", async () => {
      const blank = await isCanvasBlank(Sig.canvas);
      if (blank) { toast("Dibuja tu firma antes de insertarla", "error"); return; }
      const dataUrl = Sig.canvas.toDataURL("image/png");
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
      const canvas = renderPage(State.activePage, 2000);
      const { text } = await OCR.recognize(canvas, "spa+eng", (progress) => {
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

  function renderReviewGrid() {
    const grid = $("#reviewGrid");
    grid.innerHTML = "";
    $("#reviewCount").textContent = `${State.currentPages.length} página${State.currentPages.length === 1 ? "" : "s"}`;
    State.currentPages.forEach((page, i) => {
      const card = document.createElement("div");
      card.className = "review-card";
      card.draggable = true;
      card.dataset.index = i;
      card.dataset.pageId = page.id;
      card.innerHTML = `
        <span class="rc-num">${i + 1}</span>
        <img src="${pageThumb(page, 360)}" alt="Página ${i + 1}" />
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
  }

  $("#addMorePagesBtn").addEventListener("click", () => {
    State.editingExistingIndex = null;
    startCameraFlow();
  });

  $("#rangeQuality").addEventListener("input", (e) => {
    $("#outQuality").textContent = `${e.target.value}%`;
  });

  async function buildExportBlobs() {
    const format = document.querySelector('input[name="format"]:checked').value;
    const quality = Number($("#rangeQuality").value) / 100;
    const name = ($("#fileNameInput").value || "Documento").trim() || "Documento";
    const pages = State.currentPages.map((p) => renderPage(p, 2200));

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
  async function persistCurrentDocument() {
    const name = ($("#fileNameInput").value || "Documento").trim() || "Documento";
    const pagesData = State.currentPages.map((p) => ({
      id: p.id,
      base: p.base.toDataURL("image/jpeg", 0.92),
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
  function scheduleAutosave() {
    if (!State.editingDocId) return; // only autosave documents already in history
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(async () => {
      try {
        await persistCurrentDocument();
        const hint = $("#reviewSavedHint");
        if (hint) {
          hint.textContent = "Guardado ✓";
          hint.classList.remove("hidden");
          hint.classList.add("pulse");
          setTimeout(() => hint.classList.remove("pulse"), 900);
        }
        renderHistory();
      } catch (err) {
        console.error("autosave failed", err);
      }
    }, 1200);
  }

  $("#saveExportBtn").addEventListener("click", async () => {
    if (State.currentPages.length === 0) { toast("Añade al menos una página primero", "error"); return; }
    const btn = $("#saveExportBtn");
    btn.disabled = true; const original = btn.textContent; btn.textContent = "Exportando…";
    try {
      const files = await buildExportBlobs();
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
    const name = prompt("Nuevo nombre del documento:", current);
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
   * Service worker registration (offline support)
   * --------------------------------------------------------------- */
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((err) => console.warn("SW registration failed", err));
    });
  }

  /* ---------------------------------------------------------------
   * Init
   * --------------------------------------------------------------- */
  renderHistory();
  updatePendingBar();
})();
