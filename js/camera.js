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
        width: { ideal: 2560 },
        height: { ideal: 1440 },
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

  // Prefers ImageCapture.takePhoto(), which asks the camera sensor for a
  // full-resolution still — the same path native camera apps use — instead
  // of just grabbing whatever frame the (much lower-res) live preview
  // stream happens to be showing. Falls back to a video-frame grab on
  // browsers without ImageCapture support (e.g. iOS Safari).
  async function captureFrame(canvas) {
    const track = stream && stream.getVideoTracks()[0];
    if (track && "ImageCapture" in window) {
      try {
        const capture = new ImageCapture(track);
        const blob = await capture.takePhoto();
        const bitmap = await createImageBitmap(blob);
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d").drawImage(bitmap, 0, 0);
        if (bitmap.close) bitmap.close();
        return canvas;
      } catch (err) {
        // Some devices advertise ImageCapture but reject takePhoto() for
        // the active track — fall through to the video-frame grab below.
      }
    }
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
