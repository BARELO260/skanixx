/**
 * CameraController uses one stream for preview and capture. ImageCapture's
 * still-photo path is deliberately avoided because it can use a different
 * camera mode/FOV from the visible preview on mobile devices.
 */
const CameraController = (() => {
  let stream = null, facingMode = "environment", videoEl = null, lastGeometry = null;

  async function start(video) {
    videoEl = video;
    await stop();
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
      facingMode: { ideal: facingMode }, width: { ideal: 2560 }, height: { ideal: 1920 },
      aspectRatio: { ideal: 4 / 3 }, frameRate: { ideal: 30, max: 30 },
    }});
    video.srcObject = stream;
    await new Promise((resolve) => {
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return resolve();
      video.addEventListener("loadedmetadata", resolve, { once: true });
    });
    await video.play();
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

  // Captures precisely the portion of the stream shown to the user, at its
  // native stream density. No post-capture aspect-only crop is required.
  async function captureFrame(canvas, viewportAspect) {
    const rect = getPreviewSourceRect(viewportAspect);
    if (!rect) throw new Error("La vista previa aún no está lista");
    canvas.width = Math.round(rect.sw); canvas.height = Math.round(rect.sh);
    canvas.getContext("2d", { alpha: false }).drawImage(videoEl, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, canvas.width, canvas.height);
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
