/**
 * sound.js — Generates a short "camera shutter" click purely with the
 * Web Audio API, so no binary asset has to be fetched/cached for the
 * app to work offline as a PWA.
 */
const SoundFX = (() => {
  let ctx = null;
  let enabled = true;

  function ensureCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) ctx = new AC();
    }
    return ctx;
  }

  function shutter() {
    if (!enabled) return;
    const ac = ensureCtx();
    if (!ac) return;
    if (ac.state === "suspended") ac.resume();

    const now = ac.currentTime;

    // Two quick noise-ish clicks to emulate a mechanical shutter.
    [0, 0.07].forEach((offset, i) => {
      const dur = i === 0 ? 0.045 : 0.06;
      const bufferSize = Math.floor(ac.sampleRate * dur);
      const buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
      const data = buffer.getChannelData(0);
      for (let j = 0; j < bufferSize; j++) {
        data[j] = (Math.random() * 2 - 1) * (1 - j / bufferSize);
      }
      const src = ac.createBufferSource();
      src.buffer = buffer;

      const filter = ac.createBiquadFilter();
      filter.type = "highpass";
      filter.frequency.value = i === 0 ? 1800 : 900;

      const gain = ac.createGain();
      gain.gain.setValueAtTime(i === 0 ? 0.5 : 0.3, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + dur);

      src.connect(filter).connect(gain).connect(ac.destination);
      src.start(now + offset);
      src.stop(now + offset + dur);
    });
  }

  function setEnabled(v) { enabled = v; }
  function isEnabled() { return enabled; }

  return { shutter, setEnabled, isEnabled };
})();
