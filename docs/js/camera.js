/**
 * CameraController uses one stream for preview and capture. ImageCapture's
 * still-photo path is deliberately avoided because it can use a different
 * camera mode/FOV from the visible preview on mobile devices.
 */
const CameraController = (() => {
  let stream = null, facingMode = "environment", videoEl = null, lastGeometry = null;

  // Upper bound only — this is *not* what we ask for by default. It exists
  // so applyConstraints() below never requests something absurd (e.g. a
  // buggy driver reporting an 8K "max"), while still letting real sensors
  // (8/12/48MP) be used instead of being capped at a fixed mid-range value.
  const HARD_MAX_DIM = 6000;

  async function start(video) {
    videoEl = video;
    await stop();
    // Ask for a generous "ideal" so the browser doesn't default to a low
    // preview resolution, then immediately try to push the track to the
    // camera's actual maximum via getCapabilities()/applyConstraints(). A
    // fixed ideal like 2560x1920 silently throws away real sensor
    // resolution on any phone whose camera can do better (most of them).
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
      facingMode: { ideal: facingMode }, width: { ideal: 4096 }, height: { ideal: 3072 },
      aspectRatio: { ideal: 4 / 3 }, frameRate: { ideal: 30, max: 30 },
    }});
    await maximizeTrackResolution(stream.getVideoTracks()[0]);
    video.srcObject = stream;
    await new Promise((resolve) => {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return resolve();
      video.addEventListener("loadeddata", resolve, { once: true });
    });
    await video.play();
    await waitForLiveFrame();
  }

  // Re-requests the track at the highest resolution the hardware actually
  // reports via getCapabilities(). This is best-effort: some browsers
  // (older WebViews, some desktop UAs) don't implement getCapabilities on
  // video tracks, in which case we just keep whatever getUserMedia gave us.
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
      await track.applyConstraints({
        width: { ideal: maxW }, height: { ideal: maxH },
      });
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
