/**
 * camera.js — thin wrapper around getUserMedia for live capture,
 * including front/back camera switching and still-frame grabbing.
 */
const CameraController = (() => {
  let stream = null;
  let facingMode = "environment";
  let videoEl = null;

  async function start(video) {
    videoEl = video;
    await stop();
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 1920 },
        height: { ideal: 1920 },
      },
    };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    await video.play().catch(() => {});
  }

  async function stop() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
  }

  async function switchCamera() {
    facingMode = facingMode === "environment" ? "user" : "environment";
    if (videoEl) await start(videoEl);
  }

  function captureFrame(canvas) {
    const video = videoEl;
    const w = video.videoWidth, h = video.videoHeight;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, w, h);
    return canvas;
  }

  function isActive() {
    return !!stream;
  }

  return { start, stop, switchCamera, captureFrame, isActive };
})();
