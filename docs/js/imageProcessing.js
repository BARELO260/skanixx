/**
 * imageProcessing.js
 * All pixel-level work for the scanner: perspective ("flatten") correction,
 * a lightweight automatic edge/document detector, colour filters and the
 * brightness / contrast / saturation adjustment pipeline. Everything runs
 * on the Canvas 2D API so it works fully offline with no external CV library.
 */
const ImageProcessing = (() => {

  /* ----------------------------------------------------------------
   * 1) PERSPECTIVE CORRECTION ("flatten" a photographed document)
   * We compute a projective (homography) transform that maps the four
   * user-chosen corners of the document in the source image to the four
   * corners of a clean output rectangle, then resample every output
   * pixel by looking up its position in the source via the inverse
   * matrix (classic inverse-mapping warp).
   * ---------------------------------------------------------------- */

  // Solve the 3x3 homography that maps src quad -> dst quad.
  function computeHomography(src, dst) {
    // src, dst: arrays of 4 {x,y} points, ordered TL, TR, BR, BL
    const A = [];
    const b = [];
    for (let i = 0; i < 4; i++) {
      const { x: sx, y: sy } = src[i];
      const { x: dx, y: dy } = dst[i];
      A.push([sx, sy, 1, 0, 0, 0, -sx * dx, -sy * dx]);
      b.push(dx);
      A.push([0, 0, 0, sx, sy, 1, -sx * dy, -sy * dy]);
      b.push(dy);
    }
    const h = solveLinearSystem(A, b); // 8 unknowns
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }

  // Gaussian elimination for an 8x8 (or NxN) linear system.
  function solveLinearSystem(A, b) {
    const n = A.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
      }
      [M[col], M[pivot]] = [M[pivot], M[col]];
      const pv = M[col][col] || 1e-12;
      for (let c = col; c <= n; c++) M[col][c] /= pv;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const factor = M[r][col];
        if (factor === 0) continue;
        for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
      }
    }
    return M.map((row) => row[n]);
  }

  /**
   * warpPerspective — flattens the quadrilateral `corners` (TL,TR,BR,BL,
   * in source pixel coordinates) from `srcCanvas` into a new canvas sized
   * to the estimated real document aspect ratio.
   */
  function warpPerspective(srcCanvas, corners) {
    const [tl, tr, br, bl] = corners;
    const widthTop = dist(tl, tr), widthBottom = dist(bl, br);
    const heightLeft = dist(tl, bl), heightRight = dist(tr, br);
    const outW = Math.max(40, Math.round(Math.max(widthTop, widthBottom)));
    const outH = Math.max(40, Math.round(Math.max(heightLeft, heightRight)));

    const dst = [
      { x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH },
    ];
    const H = computeHomography(dst, [tl, tr, br, bl]); // dst->src, used for inverse sampling directly
    // (dst->src) is exactly what we need for inverse mapping, no extra invert needed.

    const srcCtx = srcCanvas.getContext("2d");
    const srcData = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
    const sw = srcCanvas.width, sh = srcCanvas.height;

    const outCanvas = document.createElement("canvas");
    outCanvas.width = outW;
    outCanvas.height = outH;
    const outCtx = outCanvas.getContext("2d");
    const outData = outCtx.createImageData(outW, outH);

    const sPix = srcData.data, oPix = outData.data;

    // Inlined instead of calling applyH(H, x, y) per pixel: that call
    // allocated a fresh {x, y} object on every iteration of this loop —
    // up to millions of times for a full-resolution capture (this app now
    // captures at the sensor's native resolution, previously capped much
    // lower). That's millions of tiny object allocations feeding the
    // garbage collector during the single most performance-sensitive
    // moment in the app: the crop-confirm -> edit-view transition, which
    // runs synchronously on the main thread and was very noticeably
    // contributing to "the app feels slow". Same math, no per-pixel
    // allocation.
    const h0 = H[0], h1 = H[1], h2 = H[2], h3 = H[3], h4 = H[4], h5 = H[5], h6 = H[6], h7 = H[7], h8 = H[8];
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const w = h6 * x + h7 * y + h8;
        const sx = (h0 * x + h1 * y + h2) / w;
        const sy = (h3 * x + h4 * y + h5) / w;
        const oi = (y * outW + x) * 4;
        if (sx < 0 || sy < 0 || sx >= sw - 1 || sy >= sh - 1) {
          oPix[oi + 3] = 0;
          continue;
        }
        // bilinear interpolation
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        const fx = sx - x0, fy = sy - y0;
        for (let ch = 0; ch < 4; ch++) {
          const i00 = (y0 * sw + x0) * 4 + ch;
          const i10 = (y0 * sw + x0 + 1) * 4 + ch;
          const i01 = ((y0 + 1) * sw + x0) * 4 + ch;
          const i11 = ((y0 + 1) * sw + x0 + 1) * 4 + ch;
          const top = sPix[i00] * (1 - fx) + sPix[i10] * fx;
          const bot = sPix[i01] * (1 - fx) + sPix[i11] * fx;
          oPix[oi + ch] = top * (1 - fy) + bot * fy;
        }
      }
    }
    outCtx.putImageData(outData, 0, 0);
    return outCanvas;
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  /* ----------------------------------------------------------------
   * 2) AUTOMATIC DOCUMENT-EDGE DETECTION
   * Delegates to EdgeDetector (see js/edgeDetector.js), which runs a real
   * contour pipeline (Sobel edges -> connected components -> convex hull
   * -> quadrilateral reduction) instead of a simple bounding-box heuristic.
   * Always falls back gracefully to a safe inset of the full frame if no
   * confident quad is found.
   * ---------------------------------------------------------------- */
  function detectDocumentCorners(canvas) {
    if (typeof EdgeDetector !== "undefined") {
      const result = EdgeDetector.detectFromCanvas(canvas);
      if (result && result.corners) return result.corners;
    }
    // fallback: 4% inset from full frame
    const iw = canvas.width, ih = canvas.height;
    const mx = iw * 0.04, my = ih * 0.04;
    return [
      { x: mx, y: my }, { x: iw - mx, y: my },
      { x: iw - mx, y: ih - my }, { x: mx, y: ih - my },
    ];
  }

  /* ----------------------------------------------------------------
   * 3) FILTERS & ADJUSTMENTS — operate on an ImageData in place.
   * ---------------------------------------------------------------- */
  function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

  function applyAdjustments(imageData, { brightness = 0, contrast = 0, saturation = 0 }) {
    const d = imageData.data;
    const cFactor = (259 * (contrast + 255)) / (255 * (259 - contrast));
    const satFactor = 1 + saturation / 100;
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i], g = d[i + 1], b = d[i + 2];
      // brightness
      r += brightness; g += brightness; b += brightness;
      // contrast
      r = cFactor * (r - 128) + 128;
      g = cFactor * (g - 128) + 128;
      b = cFactor * (b - 128) + 128;
      // saturation (scale distance from luminance)
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      r = lum + (r - lum) * satFactor;
      g = lum + (g - lum) * satFactor;
      b = lum + (b - lum) * satFactor;
      d[i] = clamp(r); d[i + 1] = clamp(g); d[i + 2] = clamp(b);
    }
    return imageData;
  }

  function applyFilter(imageData, filter) {
    const d = imageData.data;
    switch (filter) {
      case "original":
        return imageData;
      case "gray": {
        for (let i = 0; i < d.length; i += 4) {
          const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          d[i] = d[i + 1] = d[i + 2] = l;
        }
        return imageData;
      }
      case "bw": {
        // adaptive-ish threshold using local mean approximation (simple global + slight bias)
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const mean = sum / (d.length / 4);
        const t = mean * 0.92;
        for (let i = 0; i < d.length; i += 4) {
          const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          const v = l > t ? 255 : 0;
          d[i] = d[i + 1] = d[i + 2] = v;
        }
        return imageData;
      }
      case "document": {
        // Boost contrast + lighten background toward white while keeping ink dark.
        for (let i = 0; i < d.length; i += 4) {
          // Original code recomputed 0.299*r+0.587*g+0.114*b three extra
          // times per pixel (once for the S-curve input, then again for
          // each of r/g/b's delta) — same deterministic value every time,
          // just wasted work. Computing it once and reusing it is
          // mathematically identical, ~4x fewer weighted-sum ops here,
          // in what's likely the most-used filter in a document scanner.
          const origLum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          const targetLum = clamp((origLum - 120) * 2.1 + 150); // strong S-curve toward paper white
          const delta = (targetLum - origLum) * 0.9;
          d[i] = clamp(d[i] + delta);
          d[i + 1] = clamp(d[i + 1] + delta);
          d[i + 2] = clamp(d[i + 2] + delta);
        }
        return imageData;
      }
      case "color": {
        for (let i = 0; i < d.length; i += 4) {
          const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          // Unrolled instead of `for (const k of [0,1,2])`: that allocated
          // a fresh 3-element array plus an iterator on every single
          // pixel purely to index 3 fixed channels. Same math, no
          // per-pixel allocation.
          let r = d[i], g = d[i + 1], b = d[i + 2];
          r = lum + (r - lum) * 1.35; r = (r - 128) * 1.12 + 128 + 6; // saturate, then contrast + slight brighten
          g = lum + (g - lum) * 1.35; g = (g - 128) * 1.12 + 128 + 6;
          b = lum + (b - lum) * 1.35; b = (b - 128) * 1.12 + 128 + 6;
          d[i] = clamp(r); d[i + 1] = clamp(g); d[i + 2] = clamp(b);
        }
        return imageData;
      }
      case "sharp": {
        return sharpen(imageData);
      }
      default:
        return imageData;
    }
  }

  /* ----------------------------------------------------------------
   * 4) OCR PREPROCESSING — distinct from the cosmetic filters above.
   * Converts to grayscale, then stretches contrast using the 1st/99th
   * intensity percentiles (robust to shadows/glare outliers) so faint
   * or low-contrast text becomes crisp before it reaches Tesseract.
   * ---------------------------------------------------------------- */
  function prepareForOcr(imageData) {
    const d = imageData.data;
    const n = d.length / 4;
    const gray = new Uint8ClampedArray(n);
    const hist = new Uint32Array(256);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      gray[p] = l;
      hist[l | 0]++;
    }
    // Find 1st/99th percentile levels to use as black/white points.
    const lo = n * 0.01, hi = n * 0.99;
    let cum = 0, black = 0, white = 255;
    for (let v = 0; v < 256; v++) {
      cum += hist[v];
      if (cum >= lo) { black = v; break; }
    }
    cum = 0;
    for (let v = 255; v >= 0; v--) {
      cum += hist[v];
      if (cum >= n - hi) { white = v; break; }
    }
    if (white - black < 20) { black = Math.max(0, black - 10); white = Math.min(255, white + 10); }
    const range = Math.max(1, white - black);
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const v = clamp(((gray[p] - black) / range) * 255);
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    return imageData;
  }

  function sharpen(imageData) {
    const { width: w, height: h, data: src } = imageData;
    const out = new Uint8ClampedArray(src.length);
    const stride = w * 4;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
          out[idx] = src[idx]; out[idx + 1] = src[idx + 1]; out[idx + 2] = src[idx + 2]; out[idx + 3] = src[idx + 3];
          continue;
        }
        // The kernel is [0,-1,0, -1,5.4,-1, 0,-1,0] — a "plus" shape, not a
        // full 3x3: all 4 corners carry weight 0. The original loop still
        // indexed, read, and multiplied-by-zero those 4 corner taps for
        // every channel of every non-border pixel — real work (~4 of 9
        // multiply-adds, plus their address math) that could only ever
        // contribute 0. Reading only the 5 taps that actually have
        // nonzero weight produces exactly the same sum.
        for (let ch = 0; ch < 3; ch++) {
          const i = idx + ch;
          const sum = 5.4 * src[i] - src[i - stride] - src[i + stride] - src[i - 4] - src[i + 4];
          out[idx + ch] = clamp(sum);
        }
        out[idx + 3] = src[idx + 3];
      }
    }
    return new ImageData(out, w, h);
  }

  return {
    warpPerspective,
    detectDocumentCorners,
    applyAdjustments,
    applyFilter,
    prepareForOcr,
  };
})();
