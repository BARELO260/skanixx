/**
 * edgeDetector.js
 * Real document-quadrilateral detector (no external CV library, fully offline).
 *
 * Pipeline: grayscale -> box blur -> Sobel gradient magnitude -> adaptive
 * threshold -> binary edge mask -> dilate (closes small gaps) -> flood-fill
 * from the frame border over non-edge pixels ("outside") -> whatever is
 * left (not outside, not an edge pixel) is "interior" -> take the largest
 * interior region -> convex hull -> reduce to 4 points (Visvalingam-Whyatt
 * style min-area-loss simplification) -> validate (area fraction + interior
 * angles) -> pick best scoring quad.
 *
 * Why flood-fill instead of tracing the edge outline directly: a document's
 * outline in a real photo is rarely one perfectly closed 1px chain — a
 * shadow, a low-contrast side against a pale desk, or a reflection breaks
 * it into several disconnected fragments. Grouping those fragments back
 * into "the document" is unreliable. Flood-filling the *background* from
 * the frame border instead only needs the outline to be solid enough to
 * block the flood (which dilation helps with) — a small gap still mostly
 * blocks it, rather than fragmenting the shape into unusable pieces. This
 * also means the result is a filled region (real area), not a thin
 * outline, so ranking candidates by size directly corresponds to on-screen
 * area instead of edge-pixel count (which a busy textured background can
 * rack up far more of than a document's clean 4-line outline).
 *
 * Exposes:
 *   EdgeDetector.detectFromVideoFrame(videoEl) -> {corners, score} | null
 *     corners are in the video's *native* pixel space (videoWidth/videoHeight),
 *     i.e. directly usable with CameraController.captureFrame()'s canvas.
 *   EdgeDetector.detectFromCanvas(canvas) -> {corners, score} | null
 *     corners are in the source canvas's pixel space.
 */
const EdgeDetector = (() => {
  const ANALYSIS_WIDTH = 260;
  const DILATE_ITERATIONS = 3;
  let analysisCanvas = null;
  let analysisCtx = null;

  function getAnalysisCanvas(w, h) {
    if (!analysisCanvas) {
      analysisCanvas = document.createElement("canvas");
      analysisCtx = analysisCanvas.getContext("2d", { willReadFrequently: true });
    }
    if (analysisCanvas.width !== w || analysisCanvas.height !== h) {
      analysisCanvas.width = w;
      analysisCanvas.height = h;
    }
    return analysisCanvas;
  }

  function detectFromVideoFrame(video) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const scale = ANALYSIS_WIDTH / vw;
    const aw = ANALYSIS_WIDTH;
    const ah = Math.max(1, Math.round(vh * scale));
    getAnalysisCanvas(aw, ah);
    analysisCtx.drawImage(video, 0, 0, aw, ah);
    const quad = runPipeline(analysisCtx, aw, ah);
    if (!quad) return null;
    const inv = 1 / scale;
    return { corners: quad.corners.map((p) => ({ x: p.x * inv, y: p.y * inv })), score: quad.score };
  }

  function detectFromCanvas(sourceCanvas) {
    const sw = sourceCanvas.width, sh = sourceCanvas.height;
    if (!sw || !sh) return null;
    const scale = Math.min(1, ANALYSIS_WIDTH / sw);
    const aw = Math.max(1, Math.round(sw * scale));
    const ah = Math.max(1, Math.round(sh * scale));
    getAnalysisCanvas(aw, ah);
    analysisCtx.drawImage(sourceCanvas, 0, 0, aw, ah);
    const quad = runPipeline(analysisCtx, aw, ah);
    if (!quad) return null;
    const inv = 1 / scale;
    return { corners: quad.corners.map((p) => ({ x: p.x * inv, y: p.y * inv })), score: quad.score };
  }

  /* ---------------- core pipeline ---------------- */

  function runPipeline(ctx, w, h) {
    const { data } = ctx.getImageData(0, 0, w, h);
    const gray = toGray(data, w, h);
    const blurred = boxBlur3(gray, w, h);
    const mag = sobelMagnitude(blurred, w, h);

    let sum = 0;
    for (let i = 0; i < mag.length; i++) sum += mag[i];
    const mean = sum / mag.length;
    let variance = 0;
    for (let i = 0; i < mag.length; i++) variance += (mag[i] - mean) * (mag[i] - mean);
    const std = Math.sqrt(variance / mag.length);

    // Try progressively looser edge thresholds until a plausible document
    // region is found. Looser thresholds pick up fainter edges (helps with
    // low-contrast sides) at the cost of more background noise, which is
    // why we only fall back to them if the stricter pass finds nothing.
    let best = tryThreshold(mag, w, h, mean, std, 1.3);
    if (!best) best = tryThreshold(mag, w, h, mean, std, 0.9);
    if (!best) best = tryThreshold(mag, w, h, mean, std, 0.55);
    return best;
  }

  function tryThreshold(mag, w, h, mean, std, kFactor) {
    const thresh = Math.max(mean + std * kFactor, 10);

    const edgeMask = new Uint8Array(w * h);
    for (let i = 0; i < mag.length; i++) edgeMask[i] = mag[i] > thresh ? 1 : 0;
    dilate(edgeMask, w, h, DILATE_ITERATIONS);

    // Flood-fill the background from the frame border, blocked by the
    // (dilated) edge mask acting as walls.
    const outside = floodFillOutside(edgeMask, w, h);

    // Interior = neither background nor an edge-wall pixel itself.
    const interior = new Uint8Array(w * h);
    for (let i = 0; i < interior.length; i++) {
      interior[i] = !edgeMask[i] && !outside[i] ? 1 : 0;
    }
    // The wall eats into the interior by roughly DILATE_ITERATIONS pixels
    // all the way around — grow the interior back out by the same amount
    // so the detected boundary lands back near the true document edge
    // instead of noticeably inside it.
    dilate(interior, w, h, DILATE_ITERATIONS);

    const minSize = Math.max(40, Math.floor(w * h * 0.01));
    const components = connectedComponents(interior, w, h, minSize);
    if (!components.length) return null;

    const frameArea = w * h;
    let best = null;
    // Only the largest few interior regions can plausibly be the document —
    // ranking by pixel count here is meaningful (unlike edge-pixel counts)
    // since these are real filled areas.
    components.sort((a, b) => b.points.length - a.points.length);
    const candidates = components.slice(0, 5);
    for (const comp of candidates) {
      const hull = convexHull(boundaryPoints(comp.points));
      if (hull.length < 4) continue;
      const quad = reduceToQuad(hull);
      if (!quad) continue;
      const area = polygonArea(quad);
      const areaFrac = area / frameArea;
      if (areaFrac < 0.06 || areaFrac > 0.96) continue;
      if (!isRoughlyConvexQuad(quad)) continue;
      const ordered = orderCorners(quad);
      const rectangularity = quadRectangularity(ordered);
      const score = areaFrac * rectangularity;
      if (!best || score > best.score) best = { corners: ordered, score };
    }
    return best;
  }

  // Flood fill (4-connected, so it can't sneak through a diagonal touch
  // between two wall pixels) from every non-wall border pixel, marking
  // everything reachable as "outside". Iterative with an explicit stack to
  // avoid recursion limits on larger analysis sizes.
  function floodFillOutside(edgeMask, w, h) {
    const outside = new Uint8Array(w * h);
    const stack = [];
    const seed = (x, y) => {
      const idx = y * w + x;
      if (!edgeMask[idx] && !outside[idx]) {
        outside[idx] = 1;
        stack.push(idx);
      }
    };
    for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
    for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }

    while (stack.length) {
      const cur = stack.pop();
      const cy = (cur / w) | 0;
      const cx = cur - cy * w;
      if (cx > 0) { const idx = cur - 1; if (!edgeMask[idx] && !outside[idx]) { outside[idx] = 1; stack.push(idx); } }
      if (cx < w - 1) { const idx = cur + 1; if (!edgeMask[idx] && !outside[idx]) { outside[idx] = 1; stack.push(idx); } }
      if (cy > 0) { const idx = cur - w; if (!edgeMask[idx] && !outside[idx]) { outside[idx] = 1; stack.push(idx); } }
      if (cy < h - 1) { const idx = cur + w; if (!edgeMask[idx] && !outside[idx]) { outside[idx] = 1; stack.push(idx); } }
    }
    return outside;
  }

  // Extract just the boundary pixels of a filled region (points with at
  // least one non-member 4-neighbor). The convex hull only needs the
  // outline, and this keeps the hull's input set small even for a large
  // filled document region — hull cost stays cheap regardless of how much
  // of the frame the document fills.
  function boundaryPoints(points) {
    const set = new Set(points.map((p) => p.x + "," + p.y));
    const boundary = [];
    for (const p of points) {
      const isEdge =
        !set.has((p.x - 1) + "," + p.y) || !set.has((p.x + 1) + "," + p.y) ||
        !set.has(p.x + "," + (p.y - 1)) || !set.has(p.x + "," + (p.y + 1));
      if (isEdge) boundary.push(p);
    }
    return boundary.length >= 3 ? boundary : points;
  }

  function toGray(data, w, h) {
    const g = new Float32Array(w * h);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      g[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return g;
  }

  function boxBlur3(src, w, h) {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0, count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            sum += src[yy * w + xx];
            count++;
          }
        }
        out[y * w + x] = sum / count;
      }
    }
    return out;
  }

  function sobelMagnitude(gray, w, h) {
    const mag = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx =
          -gray[i - w - 1] + gray[i - w + 1] +
          -2 * gray[i - 1] + 2 * gray[i + 1] +
          -gray[i + w - 1] + gray[i + w + 1];
        const gy =
          -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1] +
          gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
        mag[i] = Math.sqrt(gx * gx + gy * gy);
      }
    }
    return mag;
  }

  function dilate(mask, w, h, iterations) {
    for (let it = 0; it < iterations; it++) {
      const copy = mask.slice();
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (copy[y * w + x]) continue;
          let on = false;
          for (let dy = -1; dy <= 1 && !on; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= w) continue;
              if (copy[yy * w + xx]) { on = true; break; }
            }
          }
          if (on) mask[y * w + x] = 1;
        }
      }
    }
  }

  function connectedComponents(mask, w, h, minSize) {
    const visited = new Uint8Array(w * h);
    const comps = [];
    const stack = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (!mask[idx] || visited[idx]) continue;
        const points = [];
        stack.length = 0;
        stack.push(idx);
        visited[idx] = 1;
        while (stack.length) {
          const cur = stack.pop();
          const cy = (cur / w) | 0;
          const cx = cur - cy * w;
          points.push({ x: cx, y: cy });
          for (let dy = -1; dy <= 1; dy++) {
            const ny = cy + dy;
            if (ny < 0 || ny >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              const nx = cx + dx;
              if (nx < 0 || nx >= w) continue;
              const nIdx = ny * w + nx;
              if (mask[nIdx] && !visited[nIdx]) {
                visited[nIdx] = 1;
                stack.push(nIdx);
              }
            }
          }
        }
        if (points.length >= minSize) comps.push({ points });
      }
    }
    return comps;
  }

  function convexHull(points) {
    const pts = points.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
    const n = pts.length;
    if (n < 3) return pts;
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = n - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    upper.pop();
    lower.pop();
    return lower.concat(upper);
  }

  // Reduce a convex polygon to exactly 4 vertices by repeatedly dropping the
  // vertex whose removal loses the least area (Visvalingam-Whyatt-style).
  function reduceToQuad(hull) {
    let pts = hull.slice();
    if (pts.length < 4) return null;
    while (pts.length > 4) {
      let minArea = Infinity, minIdx = -1;
      const n = pts.length;
      for (let i = 0; i < n; i++) {
        const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
        const area = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
        if (area < minArea) { minArea = area; minIdx = i; }
      }
      pts.splice(minIdx, 1);
    }
    return pts;
  }

  function polygonArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p1 = pts[i], p2 = pts[(i + 1) % pts.length];
      a += p1.x * p2.y - p2.x * p1.y;
    }
    return Math.abs(a) / 2;
  }

  function angleAt(p0, p1, p2) {
    const v1 = { x: p0.x - p1.x, y: p0.y - p1.y };
    const v2 = { x: p2.x - p1.x, y: p2.y - p1.y };
    const m1 = Math.hypot(v1.x, v1.y), m2 = Math.hypot(v2.x, v2.y);
    if (!m1 || !m2) return 0;
    let c = (v1.x * v2.x + v1.y * v2.y) / (m1 * m2);
    c = Math.max(-1, Math.min(1, c));
    return (Math.acos(c) * 180) / Math.PI;
  }

  function isRoughlyConvexQuad(q) {
    for (let i = 0; i < 4; i++) {
      const a = q[(i - 1 + 4) % 4], b = q[i], c = q[(i + 1) % 4];
      const ang = angleAt(a, b, c);
      if (ang < 25 || ang > 155) return false;
    }
    return true;
  }

  // 1.0 for a perfect rectangle, decreasing as corner angles stray from 90°.
  // Used to prefer genuinely document-shaped quads over larger-but-skewed
  // shapes a cluttered background can produce.
  function quadRectangularity(q) {
    let penalty = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[(i - 1 + 4) % 4], b = q[i], c = q[(i + 1) % 4];
      const ang = angleAt(a, b, c);
      penalty += Math.abs(ang - 90) / 90;
    }
    return Math.max(0, 1 - penalty / 4);
  }

  function orderCorners(q) {
    const sums = q.map((p) => p.x + p.y);
    const diffs = q.map((p) => p.x - p.y);
    const tl = q[sums.indexOf(Math.min(...sums))];
    const br = q[sums.indexOf(Math.max(...sums))];
    const tr = q[diffs.indexOf(Math.max(...diffs))];
    const bl = q[diffs.indexOf(Math.min(...diffs))];
    return [tl, tr, br, bl];
  }

  return { detectFromVideoFrame, detectFromCanvas };
})();
