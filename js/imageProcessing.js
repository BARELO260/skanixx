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

  function invertHomography(H) {
    // Invert the 3x3 matrix H (row-major, 9 values)
    const [a, b, c, d, e, f, g, h, i] = H;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
    const G = b * f - c * e, Hh = -(a * f - c * d), I = a * e - b * d;
    const det = a * A + b * B + c * C || 1e-12;
    return [A / det, D / det, G / det, B / det, E / det, Hh / det, C / det, F / det, I / det];
  }

  function applyH(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return {
      x: (H[0] * x + H[1] * y + H[2]) / w,
      y: (H[3] * x + H[4] * y + H[5]) / w,
    };
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

    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const p = applyH(H, x, y);
        const sx = p.x, sy = p.y;
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
          let l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          l = clamp((l - 120) * 2.1 + 150); // strong S-curve toward paper white
          const r = clamp(d[i] + (l - (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])) * 0.9);
          const g = clamp(d[i + 1] + (l - (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])) * 0.9);
          const b = clamp(d[i + 2] + (l - (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])) * 0.9);
          d[i] = r; d[i + 1] = g; d[i + 2] = b;
        }
        return imageData;
      }
      case "color": {
        for (let i = 0; i < d.length; i += 4) {
          const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          for (const k of [0, 1, 2]) {
            let v = d[i + k];
            v = lum + (v - lum) * 1.35; // saturate
            v = (v - 128) * 1.12 + 128 + 6; // contrast + slight brighten
            d[i + k] = clamp(v);
          }
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

  function sharpen(imageData) {
    const { width: w, height: h, data: src } = imageData;
    const out = new Uint8ClampedArray(src.length);
    const kernel = [0, -1, 0, -1, 5.4, -1, 0, -1, 0];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
          out[idx] = src[idx]; out[idx + 1] = src[idx + 1]; out[idx + 2] = src[idx + 2]; out[idx + 3] = src[idx + 3];
          continue;
        }
        for (let ch = 0; ch < 3; ch++) {
          let sum = 0, k = 0;
          for (let ky = -1; ky <= 1; ky++) {
            for (let kx = -1; kx <= 1; kx++) {
              const i = ((y + ky) * w + (x + kx)) * 4 + ch;
              sum += src[i] * kernel[k++];
            }
          }
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
  };
})();
