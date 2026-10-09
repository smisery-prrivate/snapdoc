/* Snapdoc imaging engine.
   Pure canvas + typed-array code. Runs on the main thread (HTMLCanvasElement) and inside a
   worker (OffscreenCanvas). Exposed as self.SnapdocImaging. No network, no DOM beyond canvas. */
(function (root) {
  'use strict';
  const IMG = {};
  const hasDOM = typeof document !== 'undefined';

  function makeCanvas(w, h) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    if (hasDOM) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
    return new OffscreenCanvas(w, h);
  }
  const ctx2d = c => c.getContext('2d', { willReadFrequently: true });
  function sizeOf(src) {
    return { w: src.videoWidth || src.naturalWidth || src.width, h: src.videoHeight || src.naturalHeight || src.height };
  }
  IMG.makeCanvas = makeCanvas; IMG.sizeOf = sizeOf;

  // Draw any image source into a canvas whose longest side is at most maxSide.
  IMG.drawCapped = function (src, maxSide) {
    const { w, h } = sizeOf(src);
    const s = Math.min(1, maxSide / Math.max(w, h));
    const c = makeCanvas(w * s, h * s);
    const cx = ctx2d(c);
    cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);      // transparent areas of an imported image become paper white, not black
    cx.drawImage(src, 0, 0, c.width, c.height);
    return c;
  };
  // Pull the corners slightly toward the centre so no sliver of table shows at the paper's edge.
  IMG.insetQuad = function (quad, frac) {
    const cx = (quad[0][0] + quad[1][0] + quad[2][0] + quad[3][0]) / 4, cy = (quad[0][1] + quad[1][1] + quad[2][1] + quad[3][1]) / 4;
    return quad.map(p => [p[0] + (cx - p[0]) * frac, p[1] + (cy - p[1]) * frac]);
  };
  IMG.toBlob = function (c, type, q) {
    if (c.convertToBlob) return c.convertToBlob({ type: type || 'image/jpeg', quality: q });
    return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('toBlob failed')), type || 'image/jpeg', q));
  };
  IMG.dataUrl = async function (c, type, q) {
    const blob = await IMG.toBlob(c, type, q);
    if (typeof FileReaderSync !== 'undefined') return new FileReaderSync().readAsDataURL(blob);
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
  };
  IMG.fullQuad = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];

  // ---------- document detection: edge maps, contours, Douglas-Peucker, four-line fit ----------
  // 1. Gradient of a smoothed, downscaled copy of the frame (brightness, plus colour differences at half size).
  // 2. Two thresholds on the gradient give two edge maps ("walls"), a sensitive and a strict one.
  // 3. In each map the free regions between the walls and the objects enclosed by the background region are
  //    labelled, their outer contours traced and simplified (Douglas-Peucker) into straight runs.
  // 4. The straight runs of all contours are pooled, snapped to the gradient ridge and combined four at a time
  //    into convex quads (this copes with rounded, curled and cut corners, with a finger on the edge and with
  //    shadows or folds that cut the page into several regions).
  // 5. Every quad is scored by how much of each side really is an edge, whether the sides end at the corners
  //    and whether they reach the frame border where they should. The best one wins; none may be good enough.
  const DQX = [1, 1, 0, -1, -1, -1, 0, 1], DQY = [0, 1, 1, 1, 0, -1, -1, -1];      // clockwise on screen, starting east
  const dqMem = {};                                                               // work buffers, kept between calls

  function intersect(l1, l2) {
    const det = l1.nx * l2.ny - l1.ny * l2.nx;
    if (Math.abs(det) < 1e-6) return null;
    return [(l1.rho * l2.ny - l2.rho * l1.ny) / det, (l1.nx * l2.rho - l2.nx * l1.rho) / det];
  }
  function quadArea(q) {
    let a = 0; for (let i = 0; i < 4; i++) { const p = q[i], n = q[(i + 1) % 4]; a += p[0] * n[1] - n[0] * p[1]; }
    return a / 2;
  }
  // convex, corners between about 37 and 143 degrees, no tiny side, corners not far outside the frame
  function dqQuadOk(q, w, h, out) {
    let sign = 0; const minSide = 0.07 * Math.min(w, h);
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      if (!a || !isFinite(a[0]) || !isFinite(a[1])) return false;
      if (a[0] < -out * w || a[0] > (1 + out) * w || a[1] < -out * h || a[1] > (1 + out) * h) return false;
      const v1x = b[0] - a[0], v1y = b[1] - a[1], v2x = c[0] - b[0], v2y = c[1] - b[1];
      const cr = v1x * v2y - v1y * v2x, s = cr > 0 ? 1 : -1;
      if (sign && s !== sign) return false; sign = s;
      const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
      if (l1 < minSide || l2 < minSide) return false;
      if (Math.abs(v1x * v2x + v1y * v2y) > 0.8 * l1 * l2) return false;
    }
    return true;
  }
  // part of the segment a-b that lies inside the frame, as [t0, t1] in units of its length (null: none)
  function dqClip(ax, ay, bx, by, w, h) {
    let t0 = 0, t1 = 1; const dx = bx - ax, dy = by - ay;
    const p = [-dx, dx, -dy, dy], q = [ax, w - 1 - ax, ay, h - 1 - ay];
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) { if (q[i] < 0) return null; continue; }
      const r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
    return [t0, t1];
  }

  // Smoothed gradient of the brightness: 3x3 binomial blur, then Sobel. Unit: twice the grey levels per pixel,
  // so a sharp step of H grey levels peaks near 0.75 H. M holds the buffers.
  function dqGradient(d, w, h, M) {
    const n = w * h, t = M.t, b = M.b, gx = M.gx, gy = M.gy, mag = M.mag, K = 1 / 256;
    for (let y = 0, o = 0, k = 0; y < h; y++) {
      let p = d[o] + 2 * d[o + 1] + d[o + 2], c = p, nx;
      for (let x = 0; x < w - 1; x++, o += 4, k++) { nx = d[o + 4] + 2 * d[o + 5] + d[o + 6]; t[k] = p + 2 * c + nx; p = c; c = nx; }
      t[k++] = p + 3 * c; o += 4;
    }
    for (let k = 0; k < w; k++) b[k] = 3 * t[k] + t[k + w];
    for (let k = w; k < n - w; k++) b[k] = t[k - w] + 2 * t[k] + t[k + w];
    for (let k = n - w; k < n; k++) b[k] = t[k - w] + 3 * t[k];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1, i = y * w + 1; x < w - 1; x++, i++) {
        const a = b[i - w - 1], e = b[i - w + 1], f = b[i + w - 1], g = b[i + w + 1];
        const x1 = (e + g - a - f + 2 * (b[i + 1] - b[i - 1])) * K, y1 = (f + g - a - e + 2 * (b[i + w] - b[i - w])) * K;
        gx[i] = x1; gy[i] = y1; mag[i] = Math.sqrt(x1 * x1 + y1 * y1);
      }
    }
  }
  // Colour edges that brightness does not show (a yellow page on a white table): the same gradient on two
  // colour-difference channels at half size; where it is stronger than the brightness gradient it replaces it.
  function dqChroma(d, w, h, M) {
    const cw = w >> 1, ch = h >> 1, cn = cw * ch, t = M.t, b = M.b, gx = M.gx, gy = M.gy, mag = M.mag;
    if (cw < 8 || ch < 8) return;
    // t: [c1 | c2] averaged over 2x2 pixels (sum of four), b: blurred
    for (let y = 0, k = 0; y < ch; y++) {
      let o = 2 * y * w * 4; const o2 = w * 4;
      for (let x = 0; x < cw; x++, o += 8, k++) {
        const R = d[o] + d[o + 4] + d[o + o2] + d[o + o2 + 4], Gn = d[o + 1] + d[o + 5] + d[o + o2 + 1] + d[o + o2 + 5], B = d[o + 2] + d[o + 6] + d[o + o2 + 2] + d[o + o2 + 6];
        t[k] = R - B; t[k + cn] = Gn - ((R + B) >> 1);
      }
    }
    for (let c = 0; c < 2; c++) {
      const off = c * cn;
      // 3x3 binomial blur in place via b (edges replicated)
      for (let y = 0, k = off; y < ch; y++) {
        let p = t[k], cc = p, nx;
        for (let x = 0; x < cw - 1; x++, k++) { nx = t[k + 1]; b[k] = p + 2 * cc + nx; p = cc; cc = nx; }
        b[k++] = p + 3 * cc;
      }
      for (let k = off; k < off + cw; k++) t[k] = 3 * b[k] + b[k + cw];
      for (let k = off + cw; k < off + cn - cw; k++) t[k] = b[k - cw] + 2 * b[k] + b[k + cw];
      for (let k = off + cn - cw; k < off + cn; k++) t[k] = b[k - cw] + 3 * b[k];
    }
    const K = 1 / 256;                                    // sum of four pixels, blur gain 16, Sobel / 4
    for (let y = 1; y < ch - 1; y++) {
      for (let x = 1, i = y * cw + 1; x < cw - 1; x++, i++) {
        let a = t[i - cw - 1], e = t[i - cw + 1], f = t[i + cw - 1], g = t[i + cw + 1];
        let bx = (e + g - a - f + 2 * (t[i + 1] - t[i - 1])) * K, by = (f + g - a - e + 2 * (t[i + cw] - t[i - cw])) * K, bm = bx * bx + by * by;
        const j = i + cn;
        a = t[j - cw - 1]; e = t[j - cw + 1]; f = t[j + cw - 1]; g = t[j + cw + 1];
        const x1 = (e + g - a - f + 2 * (t[j + 1] - t[j - 1])) * K, y1 = (f + g - a - e + 2 * (t[j + cw] - t[j - cw])) * K, m1 = x1 * x1 + y1 * y1;
        if (m1 > bm) { bm = m1; bx = x1; by = y1; }
        if (bm < 9) continue;                             // too faint to matter
        const m = Math.sqrt(bm), fi = 2 * y * w + 2 * x;
        if (m > mag[fi]) { mag[fi] = m; gx[fi] = bx; gy[fi] = by; }
        if (m > mag[fi + 1]) { mag[fi + 1] = m; gx[fi + 1] = bx; gy[fi + 1] = by; }
        if (m > mag[fi + w]) { mag[fi + w] = m; gx[fi + w] = bx; gy[fi + w] = by; }
        if (m > mag[fi + w + 1]) { mag[fi + w + 1] = m; gx[fi + w + 1] = bx; gy[fi + w + 1] = by; }
      }
    }
  }
  // The outermost ring copies its inner neighbour (an edge that runs out of the frame still closes at the border),
  // then the noise level is read from the flat fifth of the picture (text and patterns must not raise it): the
  // 20th percentile of the gradient magnitude, scaled to the median that pure noise would have.
  function dqLevel(w, h, M) {
    const n = w * h, gx = M.gx, gy = M.gy, mag = M.mag;
    for (let x = 1; x < w - 1; x++) { let i = x, j = x + w; gx[i] = gx[j]; gy[i] = gy[j]; mag[i] = mag[j]; i = (h - 1) * w + x; j = i - w; gx[i] = gx[j]; gy[i] = gy[j]; mag[i] = mag[j]; }
    for (let y = 0; y < h; y++) { const yy = y === 0 ? 1 : y === h - 1 ? h - 2 : y; let i = y * w, j = yy * w + 1; gx[i] = gx[j]; gy[i] = gy[j]; mag[i] = mag[j]; i = y * w + w - 1; j = yy * w + w - 2; gx[i] = gx[j]; gy[i] = gy[j]; mag[i] = mag[j]; }
    const hist = M.hist.fill(0);
    for (let i = 0; i < n; i++) { const v = (mag[i] * 16) | 0; hist[v > 255 ? 255 : v]++; }
    let acc = 0, med = 16;
    for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc >= n * 0.2) { med = (k + 0.5) / 16 * 1.76; break; } }
    return med;
  }

  // Connected components of the pixels with m[i] === 0 (4-connected, or 8-connected with conn8): the runs of free
  // pixels of a row are joined with the runs they touch in the row above (union-find). lab receives the component
  // id of every pixel (0 where m is set). Returns the components of at least minArea pixels; "first" is the
  // first pixel in reading order.
  function dqLabel(m, w, h, lab, U, conn8, minArea) {
    const par = U.par, first = U.first, area = U.area, bx0 = U.x0, bx1 = U.x1, by0 = U.y0, by1 = U.y1, runs = U.runs, ext = conn8 ? 1 : 0;
    let nl = 0, nr = 0;
    for (let y = 0; y < h; y++) {
      const row = y * w, end = row + w; let i = row;
      while (i < end) {
        if (m[i]) { lab[i++] = 0; continue; }
        const s0 = i++;
        while (i < end && !m[i]) i++;
        let l = 0;
        if (y > 0) {
          let a = s0 - w - ext, e = i - w + ext, last = 0;
          if (a < row - w) a = row - w; if (e > row) e = row;
          for (let j = a; j < e; j++) {
            const u = lab[j];
            if (u === 0 || u === last) continue;
            last = u;
            let r = u; while (par[r] !== r) { par[r] = par[par[r]]; r = par[r]; }
            if (l === 0) l = r; else if (r < l) { par[l] = r; l = r; } else if (r > l) par[r] = l;
          }
        }
        if (l === 0) { l = ++nl; par[l] = l; first[l] = s0; area[l] = 0; bx0[l] = w; bx1[l] = 0; by0[l] = h; by1[l] = 0; }
        for (let j = s0; j < i; j++) lab[j] = l;
        runs[nr++] = s0; runs[nr++] = i;
      }
    }
    for (let k = 0; k < nr; k += 2) {
      const s0 = runs[k], e = runs[k + 1], l0 = lab[s0]; let r = l0;
      while (par[r] !== r) { par[r] = par[par[r]]; r = par[r]; }
      if (l0 !== r) for (let j = s0; j < e; j++) lab[j] = r;
      const y = (s0 / w) | 0, xs = s0 - y * w, xe = e - 1 - y * w;
      area[r] += e - s0; if (xs < bx0[r]) bx0[r] = xs; if (xe > bx1[r]) bx1[r] = xe; if (y < by0[r]) by0[r] = y; if (y > by1[r]) by1[r] = y;
    }
    const regs = [];
    for (let l = 1; l <= nl; l++) if (par[l] === l && area[l] >= minArea) regs.push({ id: l, area: area[l], x0: bx0[l], x1: bx1[l], y0: by0[l], y1: by1[l], first: first[l] });
    return regs;
  }

  // Moore boundary following around the pixels with lab === id, clockwise on screen, from the first pixel
  // in reading order. Returns the number of contour points, 0 when there are more than cap.
  function dqTrace(lab, id, w, h, start, px, py, cap) {
    const x0 = start % w, y0 = (start - x0) / w;
    let x = x0, y = y0, np = 0, s = 4, first = -1;
    for (;;) {
      let found = -1;
      for (let k = 0; k < 8; k++) {
        const dir = (s + k) & 7, nx = x + DQX[dir], ny = y + DQY[dir];
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && lab[ny * w + nx] === id) { found = dir; break; }
      }
      if (found < 0) { px[0] = x; py[0] = y; return 1; }
      if (x === x0 && y === y0) { if (first < 0) first = found; else if (found === first) break; }
      if (np >= cap) return 0;
      px[np] = x; py[np] = y; np++;
      x += DQX[found]; y += DQY[found];
      s = (found + ((found & 1) ? 5 : 6)) & 7;
    }
    return np;
  }

  // Douglas-Peucker on a closed contour; marks the kept points in keep and returns their number.
  function dqSimplify(px, py, np, eps, keep, stk) {
    keep.fill(0, 0, np); keep[0] = 1;
    let far = 0, fd = 0;
    for (let i = 1; i < np; i++) { const dx = px[i] - px[0], dy = py[i] - py[0], d = dx * dx + dy * dy; if (d > fd) { fd = d; far = i; } }
    if (!far) return 1;
    keep[far] = 1;
    let sp = 0, nk = 2; const e2 = eps * eps;
    stk[sp++] = 0; stk[sp++] = far; stk[sp++] = far; stk[sp++] = np;
    while (sp) {
      const b = stk[--sp], a = stk[--sp];
      if (b - a < 2) continue;
      const ax = px[a], ay = py[a], bi = b === np ? 0 : b, dx = px[bi] - ax, dy = py[bi] - ay, l2 = dx * dx + dy * dy;
      let m = -1, md = e2;
      for (let i = a + 1; i < b; i++) {
        const ex = px[i] - ax, ey = py[i] - ay; let d2;
        if (l2 > 0) { const cr = ex * dy - ey * dx; d2 = cr * cr / l2; } else d2 = ex * ex + ey * ey;
        if (d2 > md) { md = d2; m = i; }
      }
      if (m >= 0) { keep[m] = 1; nk++; stk[sp++] = a; stk[sp++] = m; stk[sp++] = m; stk[sp++] = b; }
    }
    return nk;
  }

  // total-least-squares line through accumulated moments
  function dqFit(L) {
    const n = L.n, mx = L.sx / n, my = L.sy / n, a = L.sxx / n - mx * mx, b = L.sxy / n - mx * my, c = L.syy / n - my * my;
    const th = 0.5 * Math.atan2(2 * b, a - c);
    L.nx = -Math.sin(th); L.ny = Math.cos(th); L.rho = L.nx * mx + L.ny * my; L.mx = mx; L.my = my;
  }
  // frame side 1 left, 2 top, 3 right, 4 bottom
  function dqBorderLine(side, w, h) {
    return side === 1 ? { nx: 1, ny: 0, rho: -0.5, side } : side === 2 ? { nx: 0, ny: 1, rho: -0.5, side } : side === 3 ? { nx: 1, ny: 0, rho: w - 0.5, side } : { nx: 0, ny: 1, rho: h - 0.5, side };
  }

  // Outer contour of one component -> Douglas-Peucker polygon -> its straight runs (collinear runs joined, so a
  // side interrupted by a finger or a notch stays one line) -> pool. Runs along the frame border are left out.
  function dqContourLines(lab, id, first, w, h, S, pool, pri) {
    const px = S.px, py = S.py, md = Math.min(w, h);
    const np = dqTrace(lab, id, w, h, first, px, py, S.cap);
    if (np < 16) return;
    dqSimplify(px, py, np, Math.max(1.5, 0.0065 * Math.hypot(w, h)), S.keep, S.stk);
    const vi = []; for (let i = 0; i < np; i++) if (S.keep[i]) vi.push(i);
    if (vi.length < 3 || vi.length > 300) return;
    const edges = [];
    for (let k = 0; k < vi.length; k++) {
      const a = vi[k], b = k + 1 < vi.length ? vi[k + 1] : vi[0] + np, bj = b >= np ? b - np : b;
      const len = Math.hypot(px[bj] - px[a], py[bj] - py[a]);
      if (len >= 4) edges.push({ a, b, len });
    }
    edges.sort((e, f) => f.len - e.len);
    const lines = [];
    for (const e of edges) {
      const cnt = e.b - e.a + 1, t = cnt >= 10 ? Math.floor(cnt * 0.12) : (cnt >= 6 ? 1 : 0);
      let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, nb = 0;
      for (let i = e.a + t; i <= e.b - t; i++) {
        const j = i >= np ? i - np : i, x = px[j], y = py[j];
        n++; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) nb++;
      }
      if (nb >= 0.85 * n) continue;
      const bj = e.b >= np ? e.b - np : e.b, ax = px[e.a], ay = py[e.a], bx = px[bj], by = py[bj];
      const E = { n, sx, sy, sxx, sxy, syy, nx: 0, ny: 0, rho: 0, mx: 0, my: 0, len: e.len, ends: [ax, ay, bx, by] };
      dqFit(E);
      let merged = false;
      for (const L of lines) {
        if (Math.abs(L.nx * E.ny - L.ny * E.nx) > 0.16 || Math.abs(L.nx * E.mx + L.ny * E.my - L.rho) > 2) continue;
        if (Math.abs(L.nx * ax + L.ny * ay - L.rho) > 3 || Math.abs(L.nx * bx + L.ny * by - L.rho) > 3) continue;
        L.n += n; L.sx += sx; L.sy += sy; L.sxx += sxx; L.sxy += sxy; L.syy += syy; L.len += e.len; L.ends.push(ax, ay, bx, by);
        dqFit(L); merged = true; break;
      }
      if (!merged) lines.push(E);
    }
    for (const L of lines) if (L.len >= 0.1 * md) { L.pri = pri; pool.push(L); }
  }

  // Is there an edge across the direction (ox, oy) at (x, y)? Looks up to r pixels to either side as well. The
  // gradient must be at least thr, well aligned, and stand out against the gradient five pixels away on at least
  // one side (inside a pattern of parallel lines, such as wood grain, it does not). Returns the signed gradient or 0.
  function dqEdgeAt(G, x, y, ox, oy, thr, r) {
    const w = G.w, h = G.h, gx = G.gx, gy = G.gy; let bv = 0, ba = 0;
    for (let o = -r; o <= r; o++) {
      const xi = Math.round(x + o * ox), yi = Math.round(y + o * oy);
      if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
      const i = yi * w + xi, v = gx[i] * ox + gy[i] * oy, a = v < 0 ? -v : v;
      if (a > ba && a >= 0.7 * G.mag[i]) { ba = a; bv = v; }
    }
    if (ba < thr) return 0;
    let s1 = 0, s2 = 0, xi = Math.round(x + 5 * ox), yi = Math.round(y + 5 * oy);
    if (xi >= 0 && yi >= 0 && xi < w && yi < h) s1 = Math.abs(gx[yi * w + xi] * ox + gy[yi * w + xi] * oy);
    xi = Math.round(x - 5 * ox); yi = Math.round(y - 5 * oy);
    if (xi >= 0 && yi >= 0 && xi < w && yi < h) s2 = Math.abs(gx[yi * w + xi] * ox + gy[yi * w + xi] * oy);
    if (ba >= 1.6 * (s1 < s2 ? s1 : s2)) return bv;
    // not a clean line; it still counts when the brightness really steps from one side to the other (a soft
    // shadow edge, a page edge with text close to it), which a thin line or wood grain does not do
    let sum = 0;
    for (let o = -3; o <= 3; o++) {
      xi = Math.round(x + o * ox); yi = Math.round(y + o * oy);
      if (xi >= 0 && yi >= 0 && xi < w && yi < h) sum += gx[yi * w + xi] * ox + gy[yi * w + xi] * oy;
    }
    return (sum < 0 ? -sum : sum) >= 2 * thr && sum * bv > 0 ? bv : 0;
  }

  // Snap one side (a to b) to the gradient ridge beside it: for sample points along the middle of the side the
  // strongest gradient across the side within R pixels is looked up, a line is fitted through those peaks.
  // res.sup is the share of the samples that lie on that line with a clear, well-aligned gradient.
  function dqSnap(G, ax, ay, bx, by, cxm, cym, R, S, res) {
    const w = G.w, h = G.h, gx = G.gx, gy = G.gy, mag = G.mag;
    let dx = bx - ax, dy = by - ay; const len = Math.hypot(dx, dy);
    res.ok = false; res.sup = 0; res.str = 0; res.pol = 0; res.len = len; res.thr = G.tRef; res.valid = 0;
    if (len < 4) return;
    dx /= len; dy /= len;
    let ox = dy, oy = -dx;
    if ((cxm - ax) * ox + (cym - ay) * oy > 0) { ox = -ox; oy = -oy; }       // outward normal
    const ns = Math.max(6, Math.min(64, Math.round(len * 0.86))), t0 = 0.07 * len, st = 0.86 * len / (ns - 1);
    const sxs = S.sx, sys = S.sy, sv = S.sv, sa = S.sa, vals = S.vals;
    let valid = 0, lvIn = 0, lvOut = 0;
    for (let k = 0; k < ns; k++) {
      const t = t0 + k * st, x = ax + dx * t, y = ay + dy * t;
      if (x < 1 || y < 1 || x > w - 2 || y > h - 2) { sa[k] = 2; continue; }
      valid++;
      for (let o = -R - 1; o <= R + 1; o++) {
        let xi = Math.round(x + o * ox), yi = Math.round(y + o * oy);
        if (xi < 0) xi = 0; else if (xi >= w) xi = w - 1; if (yi < 0) yi = 0; else if (yi >= h) yi = h - 1;
        const i = yi * w + xi;
        vals[o + R + 1] = gx[i] * ox + gy[i] * oy;
      }
      let bo = 0, bw = -1;
      for (let o = -R; o <= R; o++) { const v = Math.abs(vals[o + R + 1]) * (1 - 0.05 * Math.abs(o)); if (v > bw) { bw = v; bo = o; } }
      const v0 = vals[bo + R + 1], y0 = Math.abs(v0), ym = Math.abs(vals[bo + R]), yp = Math.abs(vals[bo + R + 2]);
      let dlt = 0; const den = ym - 2 * y0 + yp;
      if (den < -1e-6) { dlt = 0.5 * (ym - yp) / den; if (dlt > 0.5) dlt = 0.5; else if (dlt < -0.5) dlt = -0.5; }
      const xi = Math.min(w - 1, Math.max(0, Math.round(x + bo * ox))), yi = Math.min(h - 1, Math.max(0, Math.round(y + bo * oy)));
      sv[k] = v0; sxs[k] = x + (bo + dlt) * ox; sys[k] = y + (bo + dlt) * oy;
      // the gradient five pixels to either side of the peak: a real edge stands out against at least one of them
      let s1 = 0, s2 = 0, xf = Math.round(x + (bo - 5) * ox), yf = Math.round(y + (bo - 5) * oy);
      if (xf >= 0 && yf >= 0 && xf < w && yf < h) s1 = Math.abs(gx[yf * w + xf] * ox + gy[yf * w + xf] * oy);
      xf = Math.round(x + (bo + 5) * ox); yf = Math.round(y + (bo + 5) * oy);
      if (xf >= 0 && yf >= 0 && xf < w && yf < h) s2 = Math.abs(gx[yf * w + xf] * ox + gy[yf * w + xf] * oy);
      lvIn += s1; lvOut += s2;
      let okc = y0 >= 1.6 * (s1 < s2 ? s1 : s2);
      if (!okc) {                                         // not a clean line: does the brightness step across it?
        let sum = 0; const o0 = Math.max(-R - 1, bo - 3), o1 = Math.min(R + 1, bo + 3);
        for (let o = o0; o <= o1; o++) sum += vals[o + R + 1];
        okc = Math.abs(sum) >= 2 * G.tRef && sum * v0 > 0;
      }
      sa[k] = (okc && y0 >= 0.7 * mag[yi * w + xi]) ? 1 : 0;
    }
    res.valid = valid;
    if (valid < 4) return;
    const thr = Math.max(G.tRef, 1.5 * Math.min(lvIn, lvOut) / valid);
    res.thr = thr;
    const L = S.fit; L.n = 0; L.sx = 0; L.sy = 0; L.sxx = 0; L.sxy = 0; L.syy = 0;
    for (let k = 0; k < ns; k++) {
      if (sa[k] === 2) continue;
      if (!sa[k] || Math.abs(sv[k]) < thr) { sa[k] = 0; continue; }
      const x = sxs[k], y = sys[k]; L.n++; L.sx += x; L.sy += y; L.sxx += x * x; L.sxy += x * y; L.syy += y * y;
    }
    if (L.n < Math.max(4, 0.25 * valid)) { res.sup = L.n / valid * 0.5; return; }
    dqFit(L);
    for (let pass = 0; pass < 2; pass++) {
      const tol = pass ? 1.2 : 1.6; let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, str = 0, pol = 0;
      for (let k = 0; k < ns; k++) {
        if (sa[k] !== 1) continue;
        const x = sxs[k], y = sys[k];
        if (Math.abs(L.nx * x + L.ny * y - L.rho) > tol) continue;
        n++; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y; str += Math.abs(sv[k]); pol += sv[k] > 0 ? 1 : -1;
      }
      if (n < Math.max(4, 0.25 * valid)) { res.sup = n / valid * 0.5; return; }
      L.n = n; L.sx = sx; L.sy = sy; L.sxx = sxx; L.sxy = sxy; L.syy = syy; dqFit(L);
      res.sup = n / valid; res.str = str / n; res.pol = pol / n;
    }
    if (Math.abs(L.nx * dx + L.ny * dy) > 0.26) return;        // the fit turned by more than 15 degrees: not this side
    res.ok = true; res.nx = L.nx; res.ny = L.ny; res.rho = L.rho;
  }

  // Refine a quad on the gradient (one pass per search radius in radii) and measure how well every side is supported.
  // bd: per side 0, or the frame side it lies on.
  function dqRefine(G, q0, bd, S, radii) {
    const w = G.w, h = G.h, res = S.res;
    let q = q0.map(p => [p[0], p[1]]);
    const sup = [0, 0, 0, 0], str = [0, 0, 0, 0], pol = [0, 0, 0, 0], sl = [0, 0, 0, 0], thr = [0, 0, 0, 0], lines = [null, null, null, null];
    for (let iter = 0; iter < radii.length; iter++) {
      const cxm = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cym = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
      for (let m = 0; m < 4; m++) {
        const a = q[m], b = q[(m + 1) % 4];
        if (bd[m]) { lines[m] = dqBorderLine(bd[m], w, h); sup[m] = -1; sl[m] = Math.hypot(b[0] - a[0], b[1] - a[1]); continue; }
        dqSnap(G, a[0], a[1], b[0], b[1], cxm, cym, radii[iter], S, res);
        sup[m] = res.sup; str[m] = res.str; pol[m] = res.pol; sl[m] = res.len; thr[m] = res.thr;
        if (res.ok) lines[m] = { nx: res.nx, ny: res.ny, rho: res.rho };
        else { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1, nx = -dy / l, ny = dx / l; lines[m] = { nx, ny, rho: nx * a[0] + ny * a[1] }; }
      }
      const nq = [intersect(lines[3], lines[0]), intersect(lines[0], lines[1]), intersect(lines[1], lines[2]), intersect(lines[2], lines[3])];
      if (!nq[0] || !nq[1] || !nq[2] || !nq[3]) return null;
      q = nq;
    }
    return { q, sup, str, pol, sl, thr, bd };
  }

  // The ends of the sides. run: how many of the eight side ends run on past their corner (the edge continues
  // straight on with the same sign: a line of the background pattern, or a block that is only part of a page).
  // open: how many side ends show no edge next to their corner. gap: a side that should run out of the frame
  // (next to a frame-border side, or towards a corner outside the frame) stops short of the border.
  function dqEnds(G, c) {
    const q = c.q, w = G.w, h = G.h; let run = 0, open = 0, gap = 0;
    const cxm = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cym = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    for (let m = 0; m < 4; m++) {
      if (c.bd[m]) continue;
      const a = q[m], b = q[(m + 1) % 4]; let dx = b[0] - a[0], dy = b[1] - a[1]; const len = Math.hypot(dx, dy);
      if (len < 4) continue;
      dx /= len; dy /= len;
      const E = Math.max(6, Math.min(14, Math.round(0.15 * len))), Z = Math.min(Math.max(7, Math.round(0.12 * len)), Math.round(0.3 * len)), ox = dy, oy = -dx;
      const sgn = c.pol[m] > 0.5 ? 1 : c.pol[m] < -0.5 ? -1 : 0, tr = Math.max(c.thr[m], 0.5 * c.str[m]);
      const os = ((cxm - a[0]) * ox + (cym - a[1]) * oy > 0) ? -1 : 1;      // pol was measured along the outward normal
      const clip = dqClip(a[0], a[1], b[0], b[1], w, h);
      for (let e = 0; e < 2; e++) {
        const px = e ? b[0] : a[0], py = e ? b[1] : a[1], sg = e ? 1 : -1; let k = 0, hit = 0;
        const outside = px < -1.5 || py < -1.5 || px > w + 0.5 || py > h + 0.5;
        for (let s = 3; s < 3 + E; s++) {
          const x = px + sg * dx * s, y = py + sg * dy * s;
          if (x < 1 || y < 1 || x > w - 2 || y > h - 2) continue;
          const v = dqEdgeAt(G, x, y, ox, oy, tr, 0) * os;
          k++; if (v && (!sgn || v * sgn > 0)) hit++;
        }
        if (k >= 4 && hit >= 0.7 * k) run++;
        if (outside || c.bd[e ? (m + 1) % 4 : (m + 3) % 4]) {        // this end must show its edge right up to the frame border
          if (!clip) { gap++; continue; }
          const t = (e ? clip[1] : clip[0]) * len, ex = a[0] + dx * t, ey = a[1] + dy * t; hit = 0;
          for (let s = 1; s < 7; s++) {
            const x = Math.min(w - 1, Math.max(0, ex - sg * dx * s)), y = Math.min(h - 1, Math.max(0, ey - sg * dy * s));
            if (dqEdgeAt(G, x, y, ox, oy, c.thr[m], 1)) hit++;
          }
          if (hit < 4) gap++;
          continue;
        }
        k = 0; hit = 0;
        for (let s = 2; s < 2 + Z; s++) {
          const x = px - sg * dx * s, y = py - sg * dy * s;
          if (x < 1 || y < 1 || x > w - 2 || y > h - 2) continue;
          k++; if (dqEdgeAt(G, x, y, ox, oy, c.thr[m], 1)) hit++;
        }
        if (k >= 3 && hit < 0.5 * k) open++;
      }
    }
    c.run = run; c.open = open; c.gap = gap;
  }

  function dqScore(G, c) {
    const w = G.w, h = G.h;
    let nb = 0, smin = 1, ssum = 0, lsum = 0, psum = 0;
    for (let m = 0; m < 4; m++) {
      if (c.bd[m]) { nb++; continue; }
      const s = c.sup[m], l = c.sl[m];
      if (s < smin) smin = s; ssum += s * l; lsum += l; psum += c.pol[m] * l;
    }
    c.nb = nb; c.smin = smin; c.smean = lsum ? ssum / lsum : 0; c.pcons = lsum ? Math.abs(psum) / lsum : 0;
    c.area = Math.abs(quadArea(c.q)); c.af = Math.min(1, c.area / (w * h));
    dqEnds(G, c);
    // qual: how convincing the outline is, whatever its size; score adds a mild preference for the larger one
    c.qual = c.smean * c.smean * (0.5 + 0.5 * smin) * (0.9 + 0.1 * c.pcons) * (nb === 0 ? 1 : nb === 1 ? 0.8 : 0.6)
      * Math.max(0.2, 1 - 0.1 * c.run) * Math.max(0.3, 1 - 0.1 * c.open) * (c.gap ? 0.2 : 1);
    c.score = c.qual * Math.pow(c.af, 0.3);
    return c.score;
  }

  // Evidence along a whole line of the pool, for the part of the line inside the frame: cum counts the steps
  // with an edge, cs sums their signs, cs0 does the same for edges exactly on the line (for the run-on test).
  function dqProfile(G, L, thr) {
    const w = G.w, h = G.h, dx = -L.ny, dy = L.nx, p0x = L.nx * L.rho, p0y = L.ny * L.rho, BIG = 2 * (w + h);
    const c = dqClip(p0x - BIG * dx, p0y - BIG * dy, p0x + BIG * dx, p0y + BIG * dy, w, h);
    if (!c) return false;
    const ta = Math.ceil((c[0] * 2 - 1) * BIG), tb = Math.floor((c[1] * 2 - 1) * BIG), len = tb - ta + 1;
    if (len < 8) return false;
    const cum = new Int16Array(len + 1), cs = new Int16Array(len + 1), cs0 = new Int16Array(len + 1), tr = Math.max(thr, 0.5 * L.str);
    for (let k = 0; k < len; k++) {
      const t = ta + k, x = p0x + t * dx, y = p0y + t * dy, v = dqEdgeAt(G, x, y, L.nx, L.ny, thr, 1), v0 = v ? dqEdgeAt(G, x, y, L.nx, L.ny, tr, 0) : 0;
      cum[k + 1] = cum[k] + (v ? 1 : 0); cs[k + 1] = cs[k] + (v > 0 ? 1 : v < 0 ? -1 : 0); cs0[k + 1] = cs0[k] + (v0 > 0 ? 1 : v0 < 0 ? -1 : 0);
    }
    L.t0 = ta; L.tl = len; L.cum = cum; L.cs = cs; L.cs0 = cs0; L.dx = dx; L.dy = dy; L.p0x = p0x; L.p0y = p0y;
    return true;
  }

  // Four-line quads from the pooled contour lines. Returns up to maxOut candidates { q, bd }.
  function dqPoolQuads(G, pool, S, maxOut) {
    const w = G.w, h = G.h, res = S.res, md = Math.min(w, h);
    // the lines of the strict edge map first (few, and strong by construction), then the others, longest first
    pool.sort((a, b) => (b.pri - a.pri) || (b.len - a.len));
    // the same edge comes from several contours (both faces of a wall, both edge maps): keep one
    const raw = [];
    for (const P of pool) {
      const dx = -P.ny, dy = P.nx; let ta = Infinity, tb = -Infinity;
      for (let k = 0; k < P.ends.length; k += 2) { const t = P.ends[k] * dx + P.ends[k + 1] * dy; if (t < ta) ta = t; if (t > tb) tb = t; }
      const bx = P.nx * P.rho, by = P.ny * P.rho, ax = bx + ta * dx, ay = by + ta * dy, ex = bx + tb * dx, ey = by + tb * dy;
      let dup = false;
      for (const Rr of raw) {
        const cr = Rr.nx * P.ny - Rr.ny * P.nx; if (cr > 0.07 || cr < -0.07) continue;
        if (Math.abs(Rr.nx * ax + Rr.ny * ay - Rr.rho) < 2.5 && Math.abs(Rr.nx * ex + Rr.ny * ey - Rr.rho) < 2.5) {
          const t1 = (ax - Rr.ax) * Rr.ux + (ay - Rr.ay) * Rr.uy, t2 = (ex - Rr.ax) * Rr.ux + (ey - Rr.ay) * Rr.uy;
          const lo = Math.min(0, t1, t2), hi = Math.max(Rr.l, t1, t2);
          Rr.ax += lo * Rr.ux; Rr.ay += lo * Rr.uy; Rr.l = hi - lo;
          dup = true; break;
        }
      }
      if (!dup && raw.length < 72) raw.push({ nx: P.nx, ny: P.ny, rho: P.rho, ax, ay, ux: dx, uy: dy, l: tb - ta });
    }
    // snap every line to its gradient ridge, rank by how much edge it carries
    const snapped = [];
    for (const Rr of raw) {
      dqSnap(G, Rr.ax, Rr.ay, Rr.ax + Rr.ux * Rr.l, Rr.ay + Rr.uy * Rr.l, Rr.ax - Rr.nx * 10 + Rr.ux * Rr.l / 2, Rr.ay - Rr.ny * 10 + Rr.uy * Rr.l / 2, 3, S, res);
      if (!res.ok || res.sup < 0.3) continue;
      const L = { nx: res.nx, ny: res.ny, rho: res.rho, side: 0, thr: res.thr, str: res.str, rank: res.sup * Math.min(Rr.l, 0.5 * md) * Math.sqrt(Math.min(res.str, 60)) };
      const mx = Rr.ax + Rr.ux * Rr.l / 2, my = Rr.ay + Rr.uy * Rr.l / 2, off = L.nx * mx + L.ny * my - L.rho;
      L.cx = mx - off * L.nx; L.cy = my - off * L.ny;
      snapped.push(L);
    }
    snapped.sort((a, b) => b.rank - a.rank);
    const lines = [];
    for (const L of snapped) {
      if (lines.length >= 24) break;
      let dup = false;
      for (const M of lines) {
        const cr = M.nx * L.ny - M.ny * L.nx; if (cr > 0.05 || cr < -0.05) continue;
        if (Math.abs(M.nx * L.cx + M.ny * L.cy - M.rho) < 1.5) { dup = true; break; }
      }
      if (dup || !dqProfile(G, L, L.thr) || L.cum[L.tl] < 0.12 * md) continue;
      lines.push(L);
    }
    const nReal = lines.length;
    if (nReal < 3) return [];
    for (let s = 1; s <= 4; s++) lines.push(dqBorderLine(s, w, h));
    const N = lines.length, found = [];
    // corner table: where two lines meet, if that can be the corner of a page; tc: how far along the first line
    const X = new Array(N * N).fill(null), tc = new Float32Array(N * N);
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
      const A = lines[i], B = lines[j];
      if (A.side && B.side) continue;
      if (Math.abs(A.nx * B.nx + A.ny * B.ny) > 0.8) continue;
      const p = intersect(A, B); if (!p) continue;
      const lim = (A.side || B.side) ? 0.02 : 0.3;
      if (p[0] < -lim * w || p[0] > (1 + lim) * w || p[1] < -lim * h || p[1] > (1 + lim) * h) continue;
      X[i * N + j] = X[j * N + i] = p;
      if (!A.side) tc[i * N + j] = (p[0] - A.p0x) * A.dx + (p[1] - A.p0y) * A.dy - A.t0;
      if (!B.side) tc[j * N + i] = (p[0] - B.p0x) * B.dx + (p[1] - B.p0y) * B.dy - B.t0;
    }
    // The stretch of line l between its corners with lines i and j (i < j), worked out once: sup = share of it that
    // is an edge (-3: cannot be a page side), pol = its sign along the line's normal, flags = run-ons (bits 0-1),
    // open ends (bits 2-3), no edge right at the i / j end (bits 4, 5), i / j end outside the frame (bits 6, 7).
    const mSup = new Float32Array(nReal * N * N).fill(-2), mLen = new Float32Array(nReal * N * N), mPol = new Float32Array(nReal * N * N), mFlag = new Uint8Array(nReal * N * N);
    const side = (l, i, j) => {
      const k = (l * N + i) * N + j;
      if (mSup[k] !== -2) return k;
      const L = lines[l], ti = tc[l * N + i], tj = tc[l * N + j], tp = ti < tj ? ti : tj, tq = ti < tj ? tj : ti, len = tq - tp;
      mSup[k] = -3; mLen[k] = len;
      if (len < 0.07 * md) return k;
      const lo = Math.max(0, Math.round(tp)), hi = Math.min(L.tl, Math.round(tq)), vis = hi - lo;
      if (vis < 0.5 * len || vis < 6) return k;
      const m = Math.round(0.06 * vis), cnt = L.cum[hi - m] - L.cum[lo + m], sup = cnt / (vis - 2 * m);
      if (sup < 0.5) return k;
      const cs = L.cs[hi - m] - L.cs[lo + m], sgn = cs >= 0 ? 1 : -1;
      const E = Math.max(6, Math.min(14, Math.round(0.15 * len))), Z = Math.min(Math.max(7, Math.round(0.12 * len)), Math.round(0.3 * len));
      let run = 0, open = 0;
      if (hi + 3 + E <= L.tl && sgn * (L.cs0[hi + 3 + E] - L.cs0[hi + 3]) >= 0.7 * E) run++;
      if (lo - 3 - E >= 0 && sgn * (L.cs0[lo - 3] - L.cs0[lo - 3 - E]) >= 0.7 * E) run++;
      const outLo = tp < -2, outHi = tq > L.tl + 1;
      const gapLo = L.cum[Math.min(L.tl, lo + 7)] - L.cum[Math.min(L.tl, lo + 1)] < 4, gapHi = L.cum[Math.max(0, hi - 1)] - L.cum[Math.max(0, hi - 7)] < 4;
      if ((outLo && gapLo) || (outHi && gapHi)) return k;   // towards a corner outside the frame the edge must reach the border
      if (!outLo && L.cum[Math.min(L.tl, lo + 2 + Z)] - L.cum[Math.min(L.tl, lo + 2)] < 0.5 * Z) open++;
      if (!outHi && L.cum[Math.max(0, hi - 2)] - L.cum[Math.max(0, hi - 2 - Z)] < 0.5 * Z) open++;
      const iLo = ti < tj;                                  // is the i end the low end?
      mSup[k] = sup; mPol[k] = cnt ? cs / cnt : 0;
      mFlag[k] = run | (open << 2) | ((iLo ? gapLo : gapHi) ? 16 : 0) | ((iLo ? gapHi : gapLo) ? 32 : 0) | ((iLo ? outLo : outHi) ? 64 : 0) | ((iLo ? outHi : outLo) ? 128 : 0);
      return k;
    };
    const ord = [0, 0, 0, 0];
    let minScore = 0;
    for (let a = 0; a < nReal; a++) for (let b = a + 1; b < N; b++) {
      const P1 = X[a * N + b]; if (!P1) continue;
      for (let c = a + 1; c < N; c++) {
        if (c === b) continue;
        const P2 = X[b * N + c]; if (!P2) continue;
        if (b < nReal) { if (mSup[side(b, a < c ? a : c, a < c ? c : a)] < 0) continue; } else if (Math.hypot(P2[0] - P1[0], P2[1] - P1[1]) < 0.07 * md) continue;
        for (let d = b + 1; d < N; d++) {
          if (d === c) continue;
          const P3 = X[c * N + d], P4 = X[d * N + a]; if (!P3 || !P4) continue;
          const nb = (b >= nReal ? 1 : 0) + (c >= nReal ? 1 : 0) + (d >= nReal ? 1 : 0);
          if (nb > 1) continue;
          // the cheap test first: every side must be an edge along most of its length
          if (c < nReal && mSup[side(c, b < d ? b : d, b < d ? d : b)] < 0) continue;
          if (d < nReal && mSup[side(d, a < c ? a : c, a < c ? c : a)] < 0) continue;
          if (mSup[side(a, b, d)] < 0) continue;
          const q = [P4, P1, P2, P3];                    // sides: P4-P1 on a, P1-P2 on b, P2-P3 on c, P3-P4 on d
          if (!dqQuadOk(q, w, h, 0.3)) continue;
          ord[0] = a; ord[1] = b; ord[2] = c; ord[3] = d;
          const cxq = (P1[0] + P2[0] + P3[0] + P4[0]) / 4, cyq = (P1[1] + P2[1] + P3[1] + P4[1]) / 4;
          let smin = 1, ssum = 0, lsum = 0, run = 0, open = 0, psum = 0, nout = 0, bad = false;
          for (let m = 0; m < 4; m++) {
            const l = ord[m]; if (l >= nReal) continue;
            const pv = ord[(m + 3) % 4], nx = ord[(m + 1) % 4], lo = pv < nx, k = side(l, lo ? pv : nx, lo ? nx : pv), sup = mSup[k];
            if (sup < 0) { bad = true; break; }
            const f = mFlag[k], len = mLen[k];
            // an end next to a frame-border side must show its edge right up to the border
            if (((f & (lo ? 16 : 32)) && pv >= nReal) || ((f & (lo ? 32 : 16)) && nx >= nReal)) { bad = true; break; }
            if (f & (lo ? 128 : 64)) nout++;
            if (sup < smin) smin = sup; ssum += sup * len; lsum += len; run += f & 3; open += (f >> 2) & 3;
            const L = lines[l], pa = q[m], pb = q[(m + 1) % 4];      // polarity along the outward normal
            psum += ((L.nx * ((pa[0] + pb[0]) / 2 - cxq) + L.ny * ((pa[1] + pb[1]) / 2 - cyq)) > 0 ? 1 : -1) * mPol[k] * len;
          }
          if (bad || nout > 1 || (nout && nb)) continue;
          const smean = ssum / lsum; if (smean < 0.65 || run > 4 || open > 3) continue;
          const af = Math.min(1, Math.abs(quadArea(q)) / (w * h)); if (af < 0.05) continue;
          const score = smean * smean * (0.5 + 0.5 * smin) * (0.9 + 0.1 * Math.abs(psum) / lsum) * Math.pow(af, 0.3) * (nb ? 0.8 : 1) * Math.max(0.2, 1 - 0.1 * run) * Math.max(0.3, 1 - 0.1 * open);
          if (score <= minScore) continue;
          found.push({ q: [P4.slice(), P1.slice(), P2.slice(), P3.slice()], bd: [0, lines[b].side || 0, lines[c].side || 0, lines[d].side || 0], score });
          if (found.length > 96) { found.sort((x, y) => y.score - x.score); found.length = 32; minScore = found[31].score; }
        }
      }
    }
    found.sort((x, y) => y.score - x.score);
    // keep the best few that differ from each other
    const outq = [];
    for (const f of found) {
      if (outq.length >= maxOut) break;
      let same = false;
      for (const g of outq) { let d = 0; for (let m = 0; m < 4; m++) { let bm = 1e9; for (let k = 0; k < 4; k++) bm = Math.min(bm, Math.hypot(f.q[m][0] - g.q[k][0], f.q[m][1] - g.q[k][1])); d = Math.max(d, bm); } if (d < 3) { same = true; break; } }
      if (!same) outq.push(f);
    }
    return outq;
  }

  // Quad Y inside quad X: how many sides of Y lie on sides of X (-1 when Y is not inside X)? With strict, a side of X
  // that is clearly longer than the side of Y lying on it must be well supported itself, otherwise X is just Y with
  // two sides drawn out to some other line.
  function dqShared(Y, X, strict) {
    const xq = X.q, yq = Y.q; let shared = 0;
    const sgn = quadArea(xq) > 0 ? 1 : -1;
    for (let k = 0; k < 4; k++) {            // every corner of Y inside X (2 px slack)
      const p = yq[k];
      for (let m = 0; m < 4; m++) {
        const a = xq[m], b = xq[(m + 1) % 4], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        if (sgn * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / l < -2) return -1;
      }
    }
    for (let k = 0; k < 4; k++) {
      const p = yq[k], r = yq[(k + 1) % 4];
      for (let m = 0; m < 4; m++) {
        const a = xq[m], b = xq[(m + 1) % 4], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const d1 = Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / l, d2 = Math.abs((b[0] - a[0]) * (r[1] - a[1]) - (b[1] - a[1]) * (r[0] - a[0])) / l;
        if (d1 < 2 && d2 < 2) {
          if (strict && !X.bd[m]) {                    // the stretch of X's side beyond Y's side must be an edge too
            const f = Math.hypot(r[0] - p[0], r[1] - p[1]) / l;
            if (f < 0.85 && (X.sup[m] - f * Math.min(1, Math.max(0, Y.sup[k]))) / (1 - f) < 0.5) return -1;
          }
          shared++; break;
        }
      }
    }
    return shared;
  }

  // Work buffers for one working size, kept between calls (the live view asks ten times a second).
  function dqBuffers(slot, w, h, full) {
    let M = dqMem[slot];
    if (M && M.w === w && M.h === h) return M;
    const n = w * h, c = makeCanvas(w, h);
    M = dqMem[slot] = { w, h, c, cx: ctx2d(c), t: new Int16Array(n), b: new Int16Array(n), gx: new Float32Array(n), gy: new Float32Array(n), mag: new Float32Array(n), hist: new Int32Array(256) };
    if (full) {
      const nu = (n >> 1) + h + 2, cap = 6 * (w + h);
      M.wall = new Uint8Array(n); M.tmp = new Uint8Array(n); M.lab = new Int32Array(n); M.lab2 = new Int32Array(n);
      M.U = { par: new Int32Array(nu), first: new Int32Array(nu), area: new Int32Array(nu), x0: new Int16Array(nu), x1: new Int16Array(nu), y0: new Int16Array(nu), y1: new Int16Array(nu), runs: new Int32Array(n + 2 * h + 2) };
      M.S = { px: new Int16Array(cap), py: new Int16Array(cap), keep: new Uint8Array(cap), stk: new Int32Array(4 * cap + 16), cap,
        sx: new Float32Array(64), sy: new Float32Array(64), sv: new Float32Array(64), sa: new Uint8Array(64), vals: new Float32Array(16), res: {}, fit: { n: 0, sx: 0, sy: 0, sxx: 0, sxy: 0, syy: 0, nx: 0, ny: 0, rho: 0, mx: 0, my: 0 } };
    }
    return M;
  }
  function dqDraw(M, src) {
    const cx = M.cx;
    cx.globalCompositeOperation = 'copy';                                        // the canvas is reused: replace what the last frame left
    cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'medium';       // mip-mapped: averages the pixels it skips, so sensor noise goes down
    cx.drawImage(src, 0, 0, M.w, M.h);
  }
  // which frame side (1 left, 2 top, 3 right, 4 bottom) the segment a-b lies on, 0 for none
  function dqOnBorder(a, b, w, h) {
    return (a[0] < 0.5 && b[0] < 0.5) ? 1 : (a[1] < 0.5 && b[1] < 0.5) ? 2 : (a[0] > w - 1.5 && b[0] > w - 1.5) ? 3 : (a[1] > h - 1.5 && b[1] > h - 1.5) ? 4 : 0;
  }
  // largest corner distance between two quads under the best way to pair their corners
  function dqQuadDist(p, q) {
    let best = Infinity;
    for (let rev = 0; rev < 2; rev++) for (let s = 0; s < 4; s++) {
      let m = 0;
      for (let i = 0; i < 4; i++) { const u = q[((rev ? 4 - i : i) + s) % 4]; m = Math.max(m, Math.hypot(p[i][0] - u[0], p[i][1] - u[1])); }
      if (m < best) best = m;
    }
    return best;
  }

  function dqDetect(src, opts) {
    const size = Math.max(32, Math.min(1600, +opts.size || 400));
    const { w: sw, h: sh } = sizeOf(src);
    if (!(sw > 0) || !(sh > 0)) return null;
    const s = Math.min(1, size / Math.max(sw, sh));
    const wf = Math.max(16, Math.round(sw * s)), hf = Math.max(16, Math.round(sh * s));
    // The search always runs on 240 pixels or less, so the live view (size 240) and the capture (size 400) see the
    // page the same way. A larger size only sharpens the corners of the result afterwards.
    const two = Math.max(wf, hf) > 256, sd = two ? 240 / Math.max(wf, hf) : 1;
    const w = two ? Math.max(16, Math.round(wf * sd)) : wf, h = two ? Math.max(16, Math.round(hf * sd)) : hf, n = w * h, md = Math.min(w, h);
    const M = dqBuffers('det', w, h, true);
    dqDraw(M, src);
    const d = M.cx.getImageData(0, 0, w, h).data;
    dqGradient(d, w, h, M);
    dqChroma(d, w, h, M);
    const med = dqLevel(w, h, M), tA = Math.min(10, Math.max(2.6, 2.4 * med + 0.8));
    const G = { w, h, gx: M.gx, gy: M.gy, mag: M.mag, tRef: tA * 0.9 }, mag = M.mag, wall = M.wall, tmp = M.tmp, lab = M.lab, lab2 = M.lab2, U = M.U, S = M.S;
    const pool = [];
    for (let si = 0; si < 2; si++) {
      const thr = tA * (si ? 2 : 1);
      for (let i = 0; i < n; i++) wall[i] = mag[i] >= thr ? 1 : 0;
      const regs = dqLabel(wall, w, h, lab, U, false, Math.max(12, 0.004 * n));
      regs.sort((a, b) => b.area - a.area);
      for (let k = 0; k < regs.length && k < 8; k++) {
        const R = regs[k]; if (R.x1 - R.x0 < 0.12 * md || R.y1 - R.y0 < 0.12 * md) continue;
        dqContourLines(lab, R.id, R.first, w, h, S, pool, si);
      }
      // the objects enclosed by the largest region that touches the frame (the background)
      for (let k = 0; k < regs.length; k++) {
        const R = regs[k];
        if (R.area < 0.06 * n) break;
        if (R.x0 > 0 && R.y0 > 0 && R.x1 < w - 1 && R.y1 < h - 1) continue;
        const id = R.id;
        for (let i = 0; i < n; i++) tmp[i] = lab[i] === id ? 1 : 0;
        const objs = dqLabel(tmp, w, h, lab2, U, true, Math.max(12, 0.03 * n));
        objs.sort((a, b) => b.area - a.area);
        for (let j = 0; j < objs.length && j < 3; j++) {
          const O = objs[j]; if (O.x1 - O.x0 < 0.12 * md || O.y1 - O.y0 < 0.12 * md) continue;
          dqContourLines(lab2, O.id, O.first, w, h, S, pool, si);
        }
        break;
      }
    }
    const pq = dqPoolQuads(G, pool, S, 6);
    const minQuad = 0.09 * n, cands = [];
    for (const p of pq) {
      const r = dqRefine(G, p.q, p.bd, S, [2, 2]);
      if (!r || !dqQuadOk(r.q, w, h, 0.3)) continue;
      dqScore(G, r);
      // an outline that leans on the frame border, or has a corner outside the frame, must be more convincing
      r.lean = r.nb > 0 || r.q.some(pt => pt[0] < -1.5 || pt[1] < -1.5 || pt[0] > w + 0.5 || pt[1] > h + 0.5);
      if (r.area >= (r.lean ? 1.7 : 1) * minQuad && r.nb <= 2 && r.smin >= 0.45 && r.smean >= 0.62 && r.qual >= (r.lean ? 0.5 : 0.3) && !(r.lean && r.run > 1)) cands.push(r);
    }
    // The outline of the last frame (opts.prior, in source pixels) is followed onto this frame. It stays unless
    // another outline is clearly better, and it may be a little weaker than a new one has to be: no flicker
    // between two outlines that are about equally good, no drop-out when one frame is noisier.
    const pr = opts.prior;
    if (Array.isArray(pr) && pr.length === 4 && pr.every(p => p && isFinite(p[0]) && isFinite(p[1]))) {
      const p0 = pr.map(p => [p[0] * w / sw - 0.5, p[1] * h / sh - 0.5]);
      const r = dqRefine(G, p0, [0, 1, 2, 3].map(m => dqOnBorder(p0[m], p0[(m + 1) % 4], w, h)), S, [3, 2]);
      if (r && dqQuadOk(r.q, w, h, 0.3) && dqQuadDist(r.q, p0) < 0.05 * Math.hypot(w, h)) {
        dqScore(G, r);
        r.lean = r.nb > 0 || r.q.some(pt => pt[0] < -1.5 || pt[1] < -1.5 || pt[0] > w + 0.5 || pt[1] > h + 0.5);
        if (r.area >= 0.9 * minQuad && r.nb <= 2 && r.smin >= 0.38 && r.smean >= 0.55 && r.qual >= (r.lean ? 0.4 : 0.24)) cands.push(r);
        for (const cd of cands) if (dqQuadDist(cd.q, r.q) < 0.02 * Math.hypot(w, h)) { cd.score *= 1.2; cd.prior = true; }
      }
    }
    cands.sort((a, b) => b.area - a.area);
    // An outline that leans on the frame border loses against one that lies inside it, shares sides with it and
    // shows all its edges: that page is simply close to the border.
    for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) {
      const X = cands[i], Y = cands[j];                   // X is the larger one
      if (X.nb > Y.nb && !X.out && Y.score >= 0.7 * X.score && dqShared(Y, X, false) >= 2) X.out = true;
    }
    for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) {
      const X = cands[i], Y = cands[j];
      if (X.out || Y.out || X.nb > Y.nb || Y.area > 0.97 * X.area) continue;
      if (Y.area > 0.8 * X.area) {
        // Nearly the same size. Two shared sides: a sheet on a stack of sheets, the upper one counts. Three: the
        // page with or without a narrow strip along one side, the whole page counts if it is about as convincing.
        const sh = dqShared(Y, X, false);
        if (sh === 2) { if (Y.score >= 0.85 * X.score) X.out = true; }
        else if (sh >= 3) { if (X.score >= 0.85 * Y.score) Y.out = true; else X.out = true; }
      } else if (X.qual >= 0.35 * Y.qual && dqShared(Y, X, true) >= 2) Y.out = true;      // a part of the page: header block, column, stripe
    }
    let best = null;
    for (const cd of cands) if (!cd.out && (!best || cd.score > best.score)) best = cd;
    if (!best) return null;
    let q = best.q, qw = w, qh = h;
    if (two) {
      // second pass: the sides are snapped once more on the gradient of the full working size
      const Mf = dqBuffers('fine', wf, hf, false);
      dqDraw(Mf, src);
      dqGradient(Mf.cx.getImageData(0, 0, wf, hf).data, wf, hf, Mf);
      const tF = Math.min(10, Math.max(2.6, 2.4 * dqLevel(wf, hf, Mf) + 0.8)), fx = wf / w, fy = hf / h;
      const q1 = q.map(p => [(p[0] + 0.5) * fx - 0.5, (p[1] + 0.5) * fy - 0.5]);
      const r2 = dqRefine({ w: wf, h: hf, gx: Mf.gx, gy: Mf.gy, mag: Mf.mag, tRef: tF * 0.9 }, q1, best.bd, S, [3, 2]);
      if (r2 && r2.q.every((p, i) => Math.hypot(p[0] - q1[i][0], p[1] - q1[i][1]) <= 2.5 * fx)) { q = r2.q; qw = wf; qh = hf; }
    }
    // to source pixels (pixel centres sit at +0.5), clamped to the frame, clockwise from the top-left corner
    const kx = sw / qw, ky = sh / qh;
    q = q.map(p => [Math.min(sw, Math.max(0, (p[0] + 0.5) * kx)), Math.min(sh, Math.max(0, (p[1] + 0.5) * ky))]);
    if (quadArea(q) < 0) q.reverse();
    let fi = 0;
    if (best.prior) {                                     // same corner order as in the last frame, so nothing swaps places on screen
      let bd = Infinity;
      for (let k = 0; k < 4; k++) { let m = 0; for (let i = 0; i < 4; i++) m = Math.max(m, Math.hypot(q[(i + k) % 4][0] - pr[i][0], q[(i + k) % 4][1] - pr[i][1])); if (m < bd) { bd = m; fi = k; } }
    } else for (let i = 1; i < 4; i++) if (q[i][0] + q[i][1] < q[fi][0] + q[fi][1]) fi = i;
    q = [q[fi], q[(fi + 1) % 4], q[(fi + 2) % 4], q[(fi + 3) % 4]];
    let borders = best.nb;
    if (!borders && best.lean) borders = 1;               // a corner lies outside the frame
    return { quad: q, score: best.score, borders };
  }

  // Returns { quad: [[x,y]x4] in source pixels (TL,TR,BR,BL), score, borders } or null when no outline is convincing.
  // borders counts the sides that lie on the frame border (it is 1 as well when a corner lies outside the frame);
  // 0 means all four paper edges were seen. score is between 0 and about 1.2, higher is more convincing.
  // opts.size: long side of the working copy (default 400). The search itself runs on 240 pixels at most, a larger
  // size refines the corners. opts.prior: the quad returned for the frame before (source pixels), for a calm outline.
  // Never throws.
  IMG.detectQuad = function (src, opts) {
    try { return dqDetect(src, opts || {}); } catch (e) { return null; }
  };

  // ---------- perspective correction ----------
  function gauss(A, B) {
    const n = B.length, M = A.map((r, i) => r.concat([B[i]]));
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      const tmp = M[c]; M[c] = M[p]; M[p] = tmp;
      const pv = M[c][c]; if (Math.abs(pv) < 1e-12) throw new Error('degenerate quad');
      for (let k = c; k <= n; k++) M[c][k] /= pv;
      for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c]; if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    return M.map(r => r[n]);
  }
  function perspective(src, dst) {       // src points -> dst points, 3x3 row-major with h33 = 1
    const A = [], B = [];
    for (let i = 0; i < 4; i++) {
      const x = src[i][0], y = src[i][1], u = dst[i][0], v = dst[i][1];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); B.push(v);
    }
    return gauss(A, B);
  }
  IMG.warp = function (src, quad, opts) {
    opts = opts || {};
    const maxSide = opts.maxSide || 2000;
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const [tl, tr, br, bl] = quad;
    let W = Math.max(dist(tl, tr), dist(bl, br)), H = Math.max(dist(tl, bl), dist(tr, br));
    const sc = Math.min(1, maxSide / Math.max(W, H));
    W = Math.max(2, Math.round(W * sc)); H = Math.max(2, Math.round(H * sc));
    const m = perspective([[0, 0], [W, 0], [W, H], [0, H]], quad);
    const { w: sw, h: sh } = sizeOf(src);
    const sd = ctx2d(src).getImageData(0, 0, sw, sh).data;
    const out = makeCanvas(W, H), octx = ctx2d(out), od = octx.createImageData(W, H), o = od.data;
    const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], hh = m[7];
    const uMax = sw - 1.001, vMax = sh - 1.001, row = sw * 4, dx = sw > 1 ? 4 : 0, dy = sh > 1 ? row : 0;   // a source one pixel wide or high has no neighbour to blend with
    let k = 0;
    for (let y = 0; y < H; y++) {
      const yc = y + 0.5;
      for (let x = 0; x < W; x++) {
        const xc = x + 0.5, den = g * xc + hh * yc + 1;
        let u = (a * xc + b * yc + c) / den - 0.5, v = (d * xc + e * yc + f) / den - 0.5;
        if (!(u > 0)) u = 0; else if (u > uMax) u = uMax;
        if (!(v > 0)) v = 0; else if (v > vMax) v = vMax;
        const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0;
        const i00 = y0 * row + x0 * 4, i01 = i00 + dx, i10 = i00 + dy, i11 = i10 + dx;
        const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy;
        o[k] = sd[i00] * w00 + sd[i01] * w01 + sd[i10] * w10 + sd[i11] * w11;
        o[k + 1] = sd[i00 + 1] * w00 + sd[i01 + 1] * w01 + sd[i10 + 1] * w10 + sd[i11 + 1] * w11;
        o[k + 2] = sd[i00 + 2] * w00 + sd[i01 + 2] * w01 + sd[i10 + 2] * w10 + sd[i11 + 2] * w11;
        o[k + 3] = 255; k += 4;
      }
    }
    octx.putImageData(od, 0, 0);
    out.px = od;                      // the pixels just written: the look that follows uses them instead of reading the canvas back
    return out;
  };

  // ---------- enhancement: even out the lighting, leave the content alone ----------
  // The page should look like a clean scan, not like a filtered photo. So the only thing that is
  // estimated and removed is the LIGHTING (shadows, gradients, the colour of the lamp):
  //   1. a small copy of the page; a morphological closing removes thin dark things (text, lines)
  //      and leaves "what the paper looks like here", shadows included;
  //   2. a very smooth estimate of the plain paper brightness, used only to tell things apart;
  //   3. every spot gets a trust value: is the closed picture really paper there? Yes where the
  //      page shows a plateau of that brightness (blank or printed paper, also under a shadow).
  //      No where it is far darker (a dark header, a photo) or a small dim island (a filled table
  //      cell, a logo), and, on a capture that is out of focus, wherever there is content at all;
  //   4. where it is not trusted, the lighting is filled in from the trusted paper around it, so
  //      content is never brightened away;
  //   5. white paper is white-balanced per channel; clearly coloured paper keeps its colour;
  //   6. a tone curve: near-white becomes white (which also removes paper grain and sensor
  //      noise), the greys below are deepened a little so pale print stays easy to read.
  IMG.FILTERS = ['color', 'gray', 'bw', 'photo'];
  const F32 = n => new Float32Array(n);
  function boxBlur(src, w, h, r, out, tmp) {       // separable box blur with edge clamping, running sums
    const win = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const o = y * w; let s = 0;
      for (let i = -r; i <= r; i++) s += src[o + (i < 0 ? 0 : i >= w ? w - 1 : i)];
      for (let x = 0; x < w; x++) { tmp[o + x] = s / win; const a = x + r + 1, b = x - r; s += src[o + (a >= w ? w - 1 : a)] - src[o + (b < 0 ? 0 : b)]; }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += tmp[(i < 0 ? 0 : i >= h ? h - 1 : i) * w + x];
      for (let y = 0; y < h; y++) { out[y * w + x] = s / win; const a = y + r + 1, b = y - r; s += tmp[(a >= h ? h - 1 : a) * w + x] - tmp[(b < 0 ? 0 : b) * w + x]; }
    }
  }
  const blur2 = (a, w, h, r, out, t1, t2) => { boxBlur(a, w, h, r, t2, t1); boxBlur(t2, w, h, r, out, t1); };   // two passes: a soft, wide kernel
  // running maximum or minimum along one line, window 2r+1, linear time (van Herk / Gil-Werman).
  // Outside the line counts as "nothing there". P, G, H are scratch buffers of n + 2r entries.
  function ext1d(src, so, ss, n, r, mx, out, oo, os, P, G, H) {
    const k = 2 * r + 1, m = n + 2 * r, pad = mx ? -Infinity : Infinity;
    for (let i = 0; i < r; i++) { P[i] = pad; P[r + n + i] = pad; }
    for (let i = 0; i < n; i++) P[r + i] = src[so + i * ss];
    // c counts the position inside the current block of k: G restarts at a block's first entry, H at its last
    if (mx) {
      for (let i = 0, c = 0; i < m; i++) { G[i] = c && G[i - 1] > P[i] ? G[i - 1] : P[i]; if (++c === k) c = 0; }
      for (let i = m - 1, c = m % k; i >= 0; i--) { H[i] = c && i !== m - 1 && H[i + 1] > P[i] ? H[i + 1] : P[i]; c = c ? c - 1 : k - 1; }
      for (let i = 0; i < n; i++) { const a = H[i], b = G[i + k - 1]; out[oo + i * os] = a > b ? a : b; }
    } else {
      for (let i = 0, c = 0; i < m; i++) { G[i] = c && G[i - 1] < P[i] ? G[i - 1] : P[i]; if (++c === k) c = 0; }
      for (let i = m - 1, c = m % k; i >= 0; i--) { H[i] = c && i !== m - 1 && H[i + 1] < P[i] ? H[i + 1] : P[i]; c = c ? c - 1 : k - 1; }
      for (let i = 0; i < n; i++) { const a = H[i], b = G[i + k - 1]; out[oo + i * os] = a < b ? a : b; }
    }
  }
  function morph(src, w, h, r, mx, out, tmp) {     // square window: rows into tmp, columns into out
    const m = Math.max(w, h) + 2 * r, P = F32(m), G = F32(m), H = F32(m);
    for (let y = 0; y < h; y++) ext1d(src, y * w, 1, w, r, mx, tmp, y * w, 1, P, G, H);
    for (let x = 0; x < w; x++) ext1d(tmp, x, w, h, r, mx, out, x, w, P, G, H);
  }
  function median3(src, w, h, out) {               // 3x3 median: takes sensor noise out, keeps lines and edges
    const v = F32(9);
    for (let y = 0; y < h; y++) {
      const y0 = (y ? y - 1 : 0) * w, y1 = y * w, y2 = (y < h - 1 ? y + 1 : y) * w;
      for (let x = 0; x < w; x++) {
        const xa = x ? x - 1 : 0, xb = x < w - 1 ? x + 1 : x;
        v[0] = src[y0 + xa]; v[1] = src[y0 + x]; v[2] = src[y0 + xb]; v[3] = src[y1 + xa]; v[4] = src[y1 + x]; v[5] = src[y1 + xb]; v[6] = src[y2 + xa]; v[7] = src[y2 + x]; v[8] = src[y2 + xb];
        for (let i = 1; i < 9; i++) { const t = v[i]; let j = i - 1; while (j >= 0 && v[j] > t) { v[j + 1] = v[j]; j--; } v[j + 1] = t; }
        out[y1 + x] = v[4];
      }
    }
  }
  function percentile(arr, n, p, mask) {
    const hist = new Uint32Array(256); let cnt = 0;
    for (let i = 0; i < n; i++) if (!mask || mask[i]) { const v = arr[i] | 0; hist[v < 0 ? 0 : v > 255 ? 255 : v]++; cnt++; }
    if (!cnt) return -1;
    let acc = 0; const want = cnt * p;
    for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc >= want) return k; }
    return 255;
  }
  const sstep = (x, a, b) => { const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a); return t * t * (3 - 2 * t); };
  // The lighting of a page. cv: the flattened page, d: its pixels (RGBA).
  // Returns f: three arrays (red, green, blue) of sw x sh entries: what blank paper looks like there;
  // tint: the colour the paper gets in the result (white unless the paper is clearly coloured);
  // soft: 0..1, how much the whole capture is out of focus.
  // work: longest side of the small working copy (320; less for a quick preview, which is faster and a little coarser)
  function lightingField(cv, d, work) {
    const w = cv.width, h = cv.height, S = Math.min(1, (work || 320) / Math.max(w, h));
    const sw = Math.max(8, Math.round(w * S)), sh = Math.max(8, Math.round(h * S)), n = sw * sh, big = Math.max(sw, sh);
    const sc = makeCanvas(sw, sh), sx = ctx2d(sc); sx.imageSmoothingEnabled = true; sx.imageSmoothingQuality = 'high'; sx.drawImage(cv, 0, 0, sw, sh);
    const sd = sx.getImageData(0, 0, sw, sh).data;
    const ch = [F32(n), F32(n), F32(n)], L0 = F32(n), Lc = F32(n), t1 = F32(n), t2 = F32(n), a1 = F32(n), a2 = F32(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) { ch[0][i] = sd[j]; ch[1][i] = sd[j + 1]; ch[2][i] = sd[j + 2]; }
    if (S > 0.25) for (const c of ch) { median3(c, sw, sh, t2); c.set(t2); }      // a small page keeps its sensor noise in the copy: take it out
    for (let i = 0; i < n; i++) L0[i] = 0.299 * ch[0][i] + 0.587 * ch[1][i] + 0.114 * ch[2][i];
    const r = Math.max(2, Math.round(0.022 * big));
    for (const c of ch) { morph(c, sw, sh, r, true, t2, t1); morph(t2, sw, sh, r, false, c, t1); }      // closing: text and thin lines vanish
    for (let i = 0; i < n; i++) Lc[i] = 0.299 * ch[0][i] + 0.587 * ch[1][i] + 0.114 * ch[2][i];

    // plain paper brightness, very smooth: fitted to what looks like paper, then twice more to what
    // agrees with the fit, so neither a shadow nor a glare spot nor a block of content bends it
    const top = Math.max(30, percentile(Lc, n, 0.9)), G = F32(n).fill(top), wt = F32(n), lw = F32(n);
    const R = Math.max(6, Math.round(0.13 * big));
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < n; i++) { const v = Lc[i], ok = (pass ? v >= 0.92 * G[i] && v <= 1.1 * G[i] : v >= 0.6 * top) ? 1 : 0; wt[i] = ok; lw[i] = ok * v; }
      blur2(wt, sw, sh, R, wt, t1, t2); blur2(lw, sw, sh, R, lw, t1, t2);
      for (let i = 0; i < n; i++) if (wt[i] > 0.03) G[i] = lw[i] / wt[i];
    }

    // from the full-size page, in 2x2 blocks (which halves the sensor noise): how much of each spot
    // sits on the plateau, how much is really dark, how much is clearly darker than its surroundings
    const hi = new Uint32Array(n), dk = new Uint32Array(n), fn = new Uint32Array(n), ct = new Uint32Array(n), Lm = F32(n);
    boxBlur(L0, sw, sh, 2, Lm, t1);                      // what the surroundings of a spot look like on average
    const xs = new Int32Array(w); for (let x = 0; x < w; x++) xs[x] = Math.min(sw - 1, (x * sw / w) | 0);
    const row = w * 4;
    for (let y = 0; y + 1 < h; y += 2) {
      const so = Math.min(sh - 1, (y * sh / h) | 0) * sw; let j = y * row;
      for (let x = 0; x + 1 < w; x += 2, j += 8) {
        const k = j + row, si = so + xs[x], c = Lc[si];
        const l = 0.07475 * (d[j] + d[j + 4] + d[k] + d[k + 4]) + 0.14675 * (d[j + 1] + d[j + 5] + d[k + 1] + d[k + 5]) + 0.0285 * (d[j + 2] + d[j + 6] + d[k + 2] + d[k + 6]);
        ct[si]++; if (l >= 0.93 * c) hi[si]++; else if (l < 0.6 * c) dk[si]++;
        if (l < 0.75 * Lm[si]) fn[si]++;
      }
    }
    // Is the whole capture out of focus? Then there is content (the small copy shows it) but no pixel
    // is clearly darker than its surroundings. Between such lines of text the paper never shows, so
    // the closed picture is too dark there. On a page like that the lighting under the content is
    // taken from the blank paper around it, and the tone curve keeps weak content instead of
    // cutting it to white.
    const T = F32(n); let cells = 0, sFn = 0, sCt2 = 0;
    for (let i = 0; i < n; i++) { T[i] = (Lc[i] - L0[i]) / Math.max(1, Lc[i]); if (T[i] > 0.035) { cells++; sFn += fn[i]; sCt2 += ct[i]; } }
    const soft = sstep(cells / n, 0.02, 0.06) * (1 - sstep(sCt2 ? sFn / sCt2 : 0, 0.004, 0.02));
    const T0 = T.slice(), T0s = F32(n); boxBlur(T0, sw, sh, 1, T0s, t1);          // T0, T0s: content at this very spot
    morph(T, sw, sh, 2, true, t2, t1); boxBlur(t2, sw, sh, 2, T, t1);          // T: is there content at or next to this spot
    const sup = F32(n); for (let i = 0; i < n; i++) sup[i] = ct[i] ? hi[i] / ct[i] : 1;
    boxBlur(sup, sw, sh, r, a1, t1);                     // a1: plateau share in the neighbourhood

    // dim patches (darker than plain paper): inside the page they may be content
    const dim = new Uint8Array(n), content = new Uint8Array(n);
    for (let i = 0; i < n; i++) { const q = Lc[i] / Math.max(1, G[i]); if (q < 0.9) dim[i] = 1; if (q < 0.55) content[i] = 1; }
    const lab = new Int32Array(n), stack = new Int32Array(n), small = 0.04 * n, verdict = [0]; let next = 0;
    for (let s0 = 0; s0 < n; s0++) {
      if (!dim[s0] || lab[s0]) continue;
      let sp = 0, cnt = 0, edge = false; const id = ++next;
      stack[sp++] = s0; lab[s0] = id;
      while (sp) {
        const p = stack[--sp], x = p % sw, y = (p - x) / sw; cnt++;
        if (x === 0 || y === 0 || x === sw - 1 || y === sh - 1) edge = true;
        if (x > 0 && dim[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack[sp++] = p - 1; }
        if (x < sw - 1 && dim[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack[sp++] = p + 1; }
        if (y > 0 && dim[p - sw] && !lab[p - sw]) { lab[p - sw] = id; stack[sp++] = p - sw; }
        if (y < sh - 1 && dim[p + sw] && !lab[p + sw]) { lab[p + sw] = id; stack[sp++] = p + sw; }
      }
      verdict[id] = !edge && cnt <= small ? 1 : 0;       // a shadow comes in from the edge of the page; a small island inside it is a filled cell or a logo
    }
    for (let i = 0; i < n; i++) if (lab[i] && verdict[lab[i]]) content[i] = 1;

    // trust in the local estimate, softened at its borders
    const tr = F32(n), w1 = F32(n), f1 = F32(n);
    const settle = () => { boxBlur(tr, sw, sh, 1, t2, t1); for (let i = 0; i < n; i++) tr[i] = content[i] ? 0 : Math.min(tr[i], t2[i]); };
    for (let i = 0; i < n; i++) tr[i] = content[i] ? 0 : (1 - soft * sstep(T[i], 0.012, 0.03)) * sstep(a1[i], 0.35, 0.55);
    settle();
    const R1 = Math.max(4, Math.round(0.07 * big));
    if (soft > 0.01) {
      // Out of focus: under the content the closed picture is darker than the paper by a factor that
      // is about the same all over the page. It is measured where content lies next to blank paper,
      // and then taken out, so a shadow that falls across the text can still be removed.
      for (let i = 0; i < n; i++) lw[i] = tr[i] * Lc[i];
      blur2(tr, sw, sh, R1, w1, t1, t2); blur2(lw, sw, sh, R1, f1, t1, t2);
      const hist = new Uint32Array(120); let cnt = 0;
      for (let i = 0; i < n; i++) if (!content[i] && T0[i] > 0.035 && w1[i] > 0.1) { const q = 100 * Lc[i] * w1[i] / Math.max(1, f1[i]); hist[q < 0 ? 0 : q > 119 ? 119 : q | 0]++; cnt++; }
      if (cnt > 0.01 * n) {
        let acc = 0, med = 100; for (let k = 0; k < 120; k++) { acc += hist[k]; if (acc >= cnt / 2) { med = k + 0.5; break; } }
        const b = Math.min(1, Math.max(0.6, med / 100));
        for (let i = 0; i < n; i++) {
          if (content[i]) continue;
          const k = 1 / (1 + soft * sstep(T0s[i], 0.012, 0.03) * (b - 1));
          ch[0][i] *= k; ch[1][i] *= k; ch[2][i] *= k; Lc[i] *= k; tr[i] = sstep(a1[i], 0.35, 0.55);
        }
        settle();
      }
    }

    // the colour of the paper itself (median over what is trusted paper, relative to its brightness)
    const pm = new Uint8Array(n); let np = 0; for (let i = 0; i < n; i++) if (tr[i] > 0.5) { pm[i] = 1; np++; }
    const mask = np > 0.02 * n ? pm : null, v = F32(n);
    const rel = c => { for (let i = 0; i < n; i++) v[i] = 128 * ch[c][i] / Math.max(1, Lc[i]); return percentile(v, n, 0.5, mask) / 128; };
    let pc = [rel(0), rel(1), rel(2)]; if (!(pc[0] > 0 && pc[1] > 0 && pc[2] > 0)) pc = [1, 1, 1];
    const sat = (Math.max(pc[0], pc[1], pc[2]) - Math.min(pc[0], pc[1], pc[2])) / Math.max(pc[0], pc[1], pc[2]);
    let ref = percentile(Lc, n, 0.5, mask); if (ref < 0) ref = top;
    // paper has one colour: a patch of clearly another colour (a tinted box, a bright spot in a
    // picture) is content, however light it is. The slight blue of a shadow stays below the limit.
    for (let i = 0; i < n; i++) {
      if (!tr[i]) continue;
      const l = Math.max(1, Lc[i]), dev = Math.max(Math.abs(ch[0][i] / l - pc[0]), Math.abs(ch[1][i] / l - pc[1]), Math.abs(ch[2][i] / l - pc[2]));
      if (dev > 0.1) tr[i] *= 1 - sstep(dev, 0.1, 0.18);
    }
    // A faint tint is the lamp and is removed. A clear colour is the paper and is kept.
    const keep = sstep(sat, 0.13, 0.24), tint = pc.map(p => 1 + keep * (Math.min(1, ref * p / 255) - 1));

    // where the local estimate is not trusted: the lighting of the trusted paper around it, from
    // near by where there is some, from further away where there is none, the plain fit as a last resort
    const R2 = Math.round(2.5 * R1), w2 = F32(n), f2 = F32(n);
    blur2(tr, sw, sh, R1, w1, t1, t2); blur2(tr, sw, sh, R2, w2, t1, t2);
    for (let c = 0; c < 3; c++) {
      const cc = ch[c];
      for (let i = 0; i < n; i++) lw[i] = tr[i] * cc[i];
      blur2(lw, sw, sh, R1, f1, t1, t2); blur2(lw, sw, sh, R2, f2, t1, t2);
      for (let i = 0; i < n; i++) {
        const g1 = sstep(w1[i], 0.02, 0.12), g2 = sstep(w2[i], 0.02, 0.12);
        let fill = G[i] * pc[c];
        if (g2 > 0) fill += g2 * (f2[i] / w2[i] - fill);
        if (g1 > 0) fill += g1 * (f1[i] / w1[i] - fill);
        cc[i] = fill + tr[i] * (cc[i] - fill);
      }
      morph(cc, sw, sh, 1, false, t2, t1);             // lean to the dark side of a shadow edge: no grey rim is left there
      boxBlur(t2, sw, sh, 1, cc, t1);
    }
    return { sw, sh, f: ch, tint, sat, soft };
  }
  // Tone curve as a table: index = 512 x (pixel / paper), up to 8 times as bright as the paper.
  // Near-white becomes the paper colour (white, unless the paper is coloured); below that the greys
  // are deepened a little, so pale print (a thermal receipt, pencil) reads as well on white as it
  // did on grey paper. Brighter than coloured paper runs on up to white (white print on a dark
  // sheet). For a capture that is out of focus the white point sits higher and weak content is
  // deepened more, so faint lines stay visible instead of being cut to white.
  const TN = 4096, TK = 512;
  function toneCurve(soft, paper) {
    const t = new Uint8ClampedArray(TN), lo = 0.035, hi = 0.9 + 0.045 * soft, g = 1.35 + 0.3 * soft, top = 1 / Math.max(0.05, paper);
    for (let i = 0; i < TN; i++) {
      const q = i / TK, x = (q - lo) / (hi - lo);
      let o = x <= 0 ? 0 : x >= 1 ? paper : paper * Math.pow(x, g);
      if (q > 1.08 && paper < 0.97) o = paper + (1 - paper) * Math.min(1, (q - 1.08) / Math.max(0.05, top - 1.08));
      t[i] = Math.round(255 * o);
    }
    return t;
  }
  const TONE0 = toneCurve(0, 1);
  IMG.lightingField = lightingField;
  IMG.enhance = function (cv, mode, opts) {
    mode = mode || 'color';
    const w = cv.width, h = cv.height, px = cv.px; cv.px = null;
    if (mode === 'photo') return cv;
    const cx = ctx2d(cv), id = px && px.width === w && px.height === h ? px : cx.getImageData(0, 0, w, h), d = id.data, M = TN - 1;      // px: the pixels the warp just wrote, no need to read them back
    const lf = lightingField(cv, d, opts && opts.work), sw = lf.sw, sh = lf.sh, n = sw * sh, colour = mode === 'color';
    const tn = p => lf.soft > 0.01 || p < 0.995 ? toneCurve(lf.soft, p) : TONE0, pl = 0.299 * lf.tint[0] + 0.587 * lf.tint[1] + 0.114 * lf.tint[2];
    // 512 / lighting, at working size (per channel for colour, of the brightness otherwise). Between
    // its cells the page is filled in by straight-line blending: down the page once per row, across
    // it per pixel. So the lighting is never blown up to a second picture of full size.
    const inv = colour ? [F32(n), F32(n), F32(n)] : [F32(n)];
    for (let i = 0; i < n; i++) {
      if (colour) for (let c = 0; c < 3; c++) { const v = lf.f[c][i]; inv[c][i] = TK / (v > 8 ? v : 8); }
      else { const v = 0.299 * lf.f[0][i] + 0.587 * lf.f[1][i] + 0.114 * lf.f[2][i]; inv[0][i] = TK / (v > 8 ? v : 8); }
    }
    const X0 = new Int32Array(w), FX = F32(w), rows = inv.map(() => F32(sw));
    for (let x = 0; x < w; x++) { let s = (x + 0.5) * sw / w - 0.5; s = s < 0 ? 0 : s > sw - 1.001 ? sw - 1.001 : s; X0[x] = s | 0; FX[x] = s - (s | 0); }
    let tR, tG, tB, tL;
    if (colour) { tR = tn(lf.tint[0]); tG = tn(lf.tint[1]); tB = tn(lf.tint[2]); }
    else if (mode === 'gray') tL = tn(pl);              // a coloured sheet becomes a grey sheet, not a white one
    else {                                              // black on white: darker than the paper is ink; on a dark sheet the light print is the ink
      tL = new Uint8ClampedArray(TN); const c = 0.72 + 0.08 * lf.soft, dark = pl < 0.45;
      for (let i = 0; i < TN; i++) { const l = i / TK; tL[i] = Math.round(dark ? 255 / (1 + Math.exp((l - 1.5) * 8)) : 255 / (1 + Math.exp(-(l - c) * 22))); }
    }
    for (let y = 0, i = 0; y < h; y++) {
      let s = (y + 0.5) * sh / h - 0.5; s = s < 0 ? 0 : s > sh - 1.001 ? sh - 1.001 : s;
      const o0 = (s | 0) * sw, o1 = o0 + sw, fy = s - (s | 0);
      for (let c = 0; c < inv.length; c++) { const a = inv[c], r = rows[c]; for (let k = 0; k < sw; k++) r[k] = a[o0 + k] + fy * (a[o1 + k] - a[o0 + k]); }
      if (colour) {
        const rR = rows[0], rG = rows[1], rB = rows[2];
        for (let x = 0; x < w; x++, i += 4) {
          const x0 = X0[x], fx = FX[x];
          const r = (d[i] * (rR[x0] + fx * (rR[x0 + 1] - rR[x0]))) | 0, g = (d[i + 1] * (rG[x0] + fx * (rG[x0 + 1] - rG[x0]))) | 0, b = (d[i + 2] * (rB[x0] + fx * (rB[x0 + 1] - rB[x0]))) | 0;
          d[i] = tR[r > M ? M : r]; d[i + 1] = tG[g > M ? M : g]; d[i + 2] = tB[b > M ? M : b];
        }
      } else {
        const rL = rows[0];
        for (let x = 0; x < w; x++, i += 4) {
          const x0 = X0[x], k = ((0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * (rL[x0] + FX[x] * (rL[x0 + 1] - rL[x0]))) | 0;
          d[i] = d[i + 1] = d[i + 2] = tL[k > M ? M : k];
        }
      }
    }
    cx.putImageData(id, 0, 0);
    cv.paper = mode === 'bw' ? [255, 255, 255] : mode === 'gray' ? [1, 1, 1].map(() => Math.round(255 * pl)) : lf.tint.map(t => Math.round(255 * t));   // the colour blank paper has in the result
    return cv;
  };

  IMG.rotate = function (cv, deg) {
    deg = ((deg % 360) + 360) % 360; if (!deg) return cv;
    const w = cv.width, h = cv.height;
    const out = makeCanvas(deg === 180 ? w : h, deg === 180 ? h : w), cx = out.getContext('2d');
    cx.translate(out.width / 2, out.height / 2); cx.rotate(deg * Math.PI / 180); cx.drawImage(cv, -w / 2, -h / 2);
    return out;
  };

  // ---------- PDF: JPEG pages wrapped in a minimal PDF 1.4 ----------
  function pdfText(s) {
    let hex = 'FEFF';
    for (const ch of String(s)) {
      const cp = ch.codePointAt(0);
      if (cp > 0xFFFF) { const v = cp - 0x10000; hex += (0xD800 + (v >> 10)).toString(16).padStart(4, '0') + (0xDC00 + (v & 0x3FF)).toString(16).padStart(4, '0'); }
      else hex += cp.toString(16).padStart(4, '0');
    }
    return '<' + hex.toUpperCase() + '>';
  }
  // pages: [{ bytes: Uint8Array (JPEG), w, h }]; opts: { title, pageSize: 'A4' | 'Letter' | 'fit' }
  IMG.makePdf = function (pages, opts) {
    opts = opts || {};
    const enc = new TextEncoder(), parts = [], offs = []; let pos = 0;
    const put = s => { const u = typeof s === 'string' ? enc.encode(s) : s; parts.push(u); pos += u.length; };
    const obj = (num, body) => { offs[num] = pos; put(num + ' 0 obj\n' + body + '\nendobj\n'); };
    put('%PDF-1.4\n'); put(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));
    const n = pages.length, sizes = { A4: [595.28, 841.89], Letter: [612, 792] }, ps = opts.pageSize || 'A4';
    const kids = []; for (let i = 0; i < n; i++) kids.push((3 + i * 3) + ' 0 R');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + n + ' >>');
    const f = x => x.toFixed(2);
    for (let i = 0; i < n; i++) {
      const p = pages[i], pn = 3 + i * 3, im = pn + 1, ct = pn + 2;
      let pw, ph, iw, ih, ix, iy;
      if (ps === 'fit') { const s = 841.89 / Math.max(p.w, p.h); pw = iw = p.w * s; ph = ih = p.h * s; ix = iy = 0; }
      else {
        let a = (sizes[ps] || sizes.A4)[0], b = (sizes[ps] || sizes.A4)[1];
        if (p.w > p.h) { const t = a; a = b; b = t; }
        pw = a; ph = b; const s = Math.min(pw / p.w, ph / p.h); iw = p.w * s; ih = p.h * s; ix = (pw - iw) / 2; iy = (ph - ih) / 2;
      }
      obj(pn, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + f(pw) + ' ' + f(ph) + '] /Resources << /XObject << /Im0 ' + im + ' 0 R >> >> /Contents ' + ct + ' 0 R >>');
      offs[im] = pos;
      put(im + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + p.w + ' /Height ' + p.h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + p.bytes.length + ' >>\nstream\n');
      put(p.bytes); put('\nendstream\nendobj\n');
      const content = 'q ' + f(iw) + ' 0 0 ' + f(ih) + ' ' + f(ix) + ' ' + f(iy) + ' cm /Im0 Do Q';
      obj(ct, '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream');
    }
    const info = 3 + n * 3, dt = new Date(), pad = x => String(x).padStart(2, '0');
    const date = 'D:' + dt.getFullYear() + pad(dt.getMonth() + 1) + pad(dt.getDate()) + pad(dt.getHours()) + pad(dt.getMinutes()) + pad(dt.getSeconds());
    obj(info, '<< ' + (opts.title ? '/Title ' + pdfText(opts.title) + ' ' : '') + '/Producer (Snapdoc) /Creator (Snapdoc) /CreationDate (' + date + ') /ModDate (' + date + ') >>');
    const xref = pos, total = info + 1;
    let x = 'xref\n0 ' + total + '\n0000000000 65535 f \n';
    for (let i = 1; i < total; i++) x += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
    x += 'trailer\n<< /Size ' + total + ' /Root 1 0 R /Info ' + info + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
    put(x);
    const out = new Uint8Array(pos); let o = 0; for (const u of parts) { out.set(u, o); o += u.length; }
    return out;
  };
  // Recover the JPEG pages from a PDF written by makePdf (or any PDF with plain DCTDecode images).
  IMG.extractPdfJpegs = function (u8) {
    const txt = new TextDecoder('latin1').decode(u8), out = []; let p = 0;
    while ((p = txt.indexOf('/Subtype /Image', p)) !== -1) {
      const sPos = txt.indexOf('stream', p); if (sPos === -1) break;
      const dictStart = Math.max(0, txt.lastIndexOf(' obj', p));
      const head = txt.slice(dictStart, sPos);
      const len = +((/\/Length\s+(\d+)/.exec(head) || [])[1] || 0), w = +((/\/Width\s+(\d+)/.exec(head) || [])[1] || 0), h = +((/\/Height\s+(\d+)/.exec(head) || [])[1] || 0);
      let ds = sPos + 6; if (txt[ds] === '\r') ds++; if (txt[ds] === '\n') ds++;
      if (len > 0 && /DCTDecode/.test(head)) out.push({ bytes: u8.slice(ds, ds + len), w, h });
      p = ds + len;
    }
    return out;
  };

  // ---------- tasks shared by the worker and the main-thread fallback ----------
  const PREV = 900, THUMB = 200;
  async function derive(out) {
    const jpeg = await IMG.toBlob(out, 'image/jpeg', 0.82);
    const prev = await IMG.toBlob(IMG.drawCapped(out, PREV), 'image/jpeg', 0.8);
    const thumb = await IMG.dataUrl(IMG.drawCapped(out, THUMB), 'image/jpeg', 0.7);
    return { jpeg, prev, thumb, w: out.width, h: out.height };
  }
  // the look of a flattened page: the filter, then a thin frame in the colour of the paper that
  // hides slivers of table at the paper's edge
  function dress(out, filter, opts) {
    filter = filter || 'color';
    out = IMG.enhance(out, filter, opts);
    if (filter !== 'photo') {
      const fx = out.getContext('2d'), fw = Math.max(2, Math.round(Math.min(out.width, out.height) * 0.006)), p = out.paper || [255, 255, 255];
      fx.strokeStyle = 'rgb(' + p[0] + ',' + p[1] + ',' + p[2] + ')'; fx.lineWidth = fw * 2; fx.strokeRect(0, 0, out.width, out.height);
    }
    return out;
  }
  IMG.tasks = {
    // m: { blob, quad?, filter, rot, keepOrig, maxOrig, maxOut }
    async process(m) {
      let bmp;
      try { bmp = await createImageBitmap(m.blob, { imageOrientation: 'from-image' }); } catch (e) { bmp = await createImageBitmap(m.blob); }   // older browsers reject the option
      const src = IMG.drawCapped(bmp, m.maxOrig || 2400); if (bmp.close) bmp.close();
      let quad = m.quad;
      if (!quad) { const det = IMG.detectQuad(src); quad = det ? IMG.insetQuad(det.quad, 0.012) : IMG.fullQuad(src.width, src.height); }
      let out = dress(IMG.warp(src, quad, { maxSide: m.maxOut || 2000 }), m.filter);
      if (m.rot) out = IMG.rotate(out, m.rot);
      const r = await derive(out);
      r.quad = quad; r.origW = src.width; r.origH = src.height;
      r.orig = m.keepOrig ? await IMG.toBlob(src, 'image/jpeg', 0.85) : null;
      return r;
    },
    // Feedback right after a shot: the live picture of that moment, cut to the page and given its
    // look, in screen size. It is on screen while the full-size photo is still being taken and worked on.
    // The page is searched for exactly as "process" does it (same search, same fallback to the whole
    // picture), so the quick picture shows the crop the stored page will have whenever the photo
    // shows what the live picture showed.
    // m: { bitmap (or a canvas), quad? (the outline the camera showed; a hint only), filter, maxOut }
    async preview(m) {
      const src = IMG.drawCapped(m.bitmap, 1e9); if (m.bitmap.close) m.bitmap.close();
      let det = null; try { det = IMG.detectQuad(src, { prior: m.quad || undefined }); } catch (e) {}
      const quad = det ? IMG.insetQuad(det.quad, 0.012) : IMG.fullQuad(src.width, src.height);
      const out = dress(IMG.warp(src, quad, { maxSide: m.maxOut || 900 }), m.filter, { work: 224 });
      return { jpeg: await IMG.toBlob(out, 'image/jpeg', 0.8), w: out.width, h: out.height };
    },
    // Runs the preview once on a made-up page. The camera asks for this while it starts, so the
    // code is already compiled when the first real shot wants its picture at once.
    async warm() {
      const c = makeCanvas(640, 480), x = ctx2d(c);
      x.fillStyle = '#8a8378'; x.fillRect(0, 0, 640, 480); x.fillStyle = '#e6e2da'; x.fillRect(90, 50, 460, 380);
      x.fillStyle = '#2a2a2a'; for (let y = 90; y < 400; y += 14) x.fillRect(120, y, 400 - (y % 5) * 30, 4);
      for (let i = 0; i < 2; i++) await IMG.tasks.preview({ bitmap: c, quad: null, filter: 'color', maxOut: 900 });
      return {};
    },
    // live outline: one small video frame in, one outline out (runs in its own worker)
    async detect(m) {
      let det = null;
      try { det = IMG.detectQuad(m.bitmap, { size: m.size || 240, prior: m.prior || undefined }); } catch (e) { det = null; }
      if (m.bitmap && m.bitmap.close) m.bitmap.close();
      return { det: det ? { quad: det.quad, borders: det.borders, score: det.score } : null };
    },
    async rotate(m) {
      const bmp = await createImageBitmap(m.blob);
      const c = IMG.drawCapped(bmp, 1e9); if (bmp.close) bmp.close();
      return derive(IMG.rotate(c, m.deg));
    },
    async ingest(m) {
      const u8 = new Uint8Array(await m.blob.arrayBuffer());
      const pages = [];
      for (const im of IMG.extractPdfJpegs(u8)) {
        const blob = new Blob([im.bytes], { type: 'image/jpeg' });
        const bmp = await createImageBitmap(blob);
        const prev = await IMG.toBlob(IMG.drawCapped(bmp, PREV), 'image/jpeg', 0.8);
        const thumb = await IMG.dataUrl(IMG.drawCapped(bmp, THUMB), 'image/jpeg', 0.7);
        pages.push({ jpeg: blob, prev, thumb, w: bmp.width, h: bmp.height }); if (bmp.close) bmp.close();
      }
      return { pages };
    },
    async pdf(m) {
      const pages = [];
      for (const p of m.pages) pages.push({ bytes: new Uint8Array(await p.blob.arrayBuffer()), w: p.w, h: p.h });
      const u8 = IMG.makePdf(pages, { title: m.title, pageSize: m.pageSize });
      return { pdf: new Blob([u8], { type: 'application/pdf' }), size: u8.length };
    }
  };

  root.SnapdocImaging = IMG;
})(typeof self !== 'undefined' ? self : this);
