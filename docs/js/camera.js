/**
 * CameraController uses one stream for preview and capture. ImageCapture's
 * still-photo path is deliberately avoided because it can use a different
 * camera mode/FOV from the visible preview on mobile devices.
 */
const CameraController = (() => {
  let stream = null, facingMode = "environment", videoEl = null, lastGeometry = null, startPromise = null;

  // Upper bound only — this is *not* what we ask for by default. It exists
  // so applyConstraints() below never requests something absurd (e.g. a
  // buggy driver reporting an 8K "max"), while still letting real sensors
  // (8/12/48MP) be used instead of being capped at a fixed mid-range value.
  const HARD_MAX_DIM = 6000;

  // This app fully closes and reopens the camera stream around every single
  // photo (capture -> crop -> edit -> reopen for the next page), so a
  // multi-page scan can cycle getUserMedia() many times in one sitting.
  // Repeated rapid acquire/release of the camera hardware is a known source
  // of flakiness on Android WebViews in particular: a new getUserMedia()
  // call issued before the platform has actually released the previous
  // session can hang indefinitely (never resolving, never rejecting)
  // instead of failing cleanly — which is exactly what "stops taking photos
  // after a few tries, needs an app restart" looks like from the outside,
  // since nothing was left around to time it out. Every step below that
  // talks to the camera hardware is now wrapped in a timeout so a hang can
  // never again leave the app stuck; it surfaces as a normal, retryable
  // camera error instead.
  function withTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); }
      );
    });
  }
  function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function start(video) {
    // Re-entrancy guard: if start() is called again while one is already
    // in flight (double-tapping "open camera", tapping retry right after
    // an in-progress attempt, rapid view navigation), just ride along with
    // the existing attempt instead of firing a second concurrent
    // getUserMedia(). Two overlapping negotiations racing to assign the
    // shared `stream` variable can orphan the loser's tracks — a real
    // MediaStreamTrack left running but referenced nowhere, still holding
    // the camera hardware. A few of those piling up over a scanning
    // session is exactly the kind of thing that makes the camera "stop
    // working after a few tries" until the app (not just the view) restarts.
    if (startPromise) return startPromise;
    startPromise = doStart(video).finally(() => { startPromise = null; });
    return startPromise;
  }

  async function doStart(video) {
    videoEl = video;
    const hadPreviousStream = !!stream;
    await stop();
    // Give the platform a brief moment to actually release the previous
    // camera session before asking for a new one — reacquiring immediately
    // is the specific pattern that tends to trigger the hang/failure
    // described above. Skipped on the very first open (nothing to release).
    if (hadPreviousStream) await delay(150);
    // Ask for a generous "ideal" so the browser doesn't default to a low
    // preview resolution, then immediately try to push the track to the
    // camera's actual maximum via getCapabilities()/applyConstraints(). A
    // fixed ideal like 2560x1920 silently throws away real sensor
    // resolution on any phone whose camera can do better (most of them).
    stream = await withTimeout(
      navigator.mediaDevices.getUserMedia({ audio: false, video: {
        facingMode: { ideal: facingMode }, width: { ideal: 4096 }, height: { ideal: 3072 },
        aspectRatio: { ideal: 4 / 3 }, frameRate: { ideal: 30, max: 30 },
      }}),
      12000,
      "No se pudo acceder a la cámara (tiempo de espera agotado)."
    );
    await maximizeTrackResolution(stream.getVideoTracks()[0]);
    video.srcObject = stream;
    await withTimeout(new Promise((resolve) => {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return resolve();
      video.addEventListener("loadeddata", resolve, { once: true });
    }), 8000, "La cámara no entregó imagen a tiempo.");
    await withTimeout(video.play(), 5000, "No se pudo iniciar la vista previa de la cámara.");
    await waitForLiveFrame();
  }

  // Re-requests the track at the highest resolution the hardware actually
  // reports via getCapabilities(). This is best-effort and non-critical —
  // it's wrapped in its own short timeout so a stalled negotiation here
  // (seen in the wild on some Android drivers after several open/close
  // cycles) can never block the rest of start() from completing; on
  // timeout we simply keep whatever resolution getUserMedia already gave
  // us instead of failing the whole camera session over an enhancement.
  async function maximizeTrackResolution(track) {
    if (!track || typeof track.getCapabilities !== "function") return;
    try {
      const caps = track.getCapabilities();
      const settings = track.getSettings ? track.getSettings() : {};
      const maxW = caps.width && caps.width.max ? Math.min(caps.width.max, HARD_MAX_DIM) : null;
      const maxH = caps.height && caps.height.max ? Math.min(caps.height.max, HARD_MAX_DIM) : null;
      if (!maxW || !maxH) return;
      const alreadyAtMax = (settings.width || 0) >= maxW && (settings.height || 0) >= maxH;
      if (alreadyAtMax) return;
      await withTimeout(
        track.applyConstraints({ width: { ideal: maxW }, height: { ideal: maxH } }),
        3000,
        "applyConstraints timed out"
      );
    } catch {
      // Camera stays at whatever resolution getUserMedia already picked.
    }
  }

  async function stop() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null; lastGeometry = null;
  }
  async function switchCamera() {
    facingMode = facingMode === "environment" ? "user" : "environment";
    if (videoEl) await start(videoEl);
  }

  // Exact native-video rectangle rendered by CSS object-fit:cover.
  function getPreviewSourceRect(viewportAspect) {
    const vw = videoEl?.videoWidth || 0, vh = videoEl?.videoHeight || 0;
    if (!vw || !vh || !viewportAspect) return null;
    const videoAspect = vw / vh;
    let sx = 0, sy = 0, sw = vw, sh = vh;
    if (videoAspect > viewportAspect) { sw = vh * viewportAspect; sx = (vw - sw) / 2; }
    else if (videoAspect < viewportAspect) { sh = vw / viewportAspect; sy = (vh - sh) / 2; }
    return { sx, sy, sw, sh, vw, vh };
  }

  // Wait for a compositor-confirmed frame before drawing. `loadedmetadata`
  // only guarantees dimensions; drawing at that point can produce a black
  // canvas on Android WebView and some mobile Safari releases.
  function waitForLiveFrame(timeoutMs = 900) {
    if (!videoEl || videoEl.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return Promise.reject(new Error("La cámara todavía no entregó una imagen"));
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      const timeout = setTimeout(finish, timeoutMs);
      const done = () => { clearTimeout(timeout); finish(); };
      if (typeof videoEl.requestVideoFrameCallback === "function") {
        videoEl.requestVideoFrameCallback(done);
      } else {
        // Two paint turns make the current video frame available on older
        // engines without requestVideoFrameCallback.
        requestAnimationFrame(() => requestAnimationFrame(done));
      }
    });
  }

  // Some mobile browsers (iOS Safari in particular) fail or produce a
  // blank/corrupt canvas above roughly 16.7M total pixels. Now that the
  // camera is allowed to run at its real sensor resolution instead of a
  // fixed 2560x1920 cap, a modern phone can hand us a stream noticeably
  // above that — so the capture canvas itself needs the same safety clamp
  // app.js already applies to rendered/exported pages, or the resolution
  // fix could turn into "sometimes captures a blank photo" on those
  // devices. This only engages near/above that ceiling; on the vast
  // majority of phones it's a no-op.
  const SAFE_CAPTURE_AREA = 15000000;

  // Captures precisely the portion of the stream shown to the user, at its
  // native stream density (clamped by SAFE_CAPTURE_AREA above).
  async function captureFrame(canvas, viewportAspect) {
    await waitForLiveFrame();
    const rect = getPreviewSourceRect(viewportAspect);
    if (!rect) throw new Error("La vista previa aún no está lista");
    let outW = Math.round(rect.sw), outH = Math.round(rect.sh);
    const area = outW * outH;
    if (area > SAFE_CAPTURE_AREA) {
      const clamp = Math.sqrt(SAFE_CAPTURE_AREA / area);
      outW = Math.round(outW * clamp);
      outH = Math.round(outH * clamp);
    }
    canvas.width = outW; canvas.height = outH;
    const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    ctx.drawImage(videoEl, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, canvas.width, canvas.height);
    lastGeometry = { ...rect, outW: canvas.width, outH: canvas.height };
    return canvas;
  }
  function mapVideoPointToCapture(point, geometry = lastGeometry) {
    if (!geometry) return null;
    return { x: (point.x - geometry.sx) * geometry.outW / geometry.sw, y: (point.y - geometry.sy) * geometry.outH / geometry.sh };
  }
  function isActive() { return !!stream; }
  function getSettings() { return stream?.getVideoTracks()[0]?.getSettings?.() || null; }
  return { start, stop, switchCamera, captureFrame, getPreviewSourceRect, mapVideoPointToCapture, isActive, getSettings };
})();
