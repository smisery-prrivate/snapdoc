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

  // ---------- document detection: blur, Sobel, thin edges, gradient-guided Hough, best quad ----------
  function blur5(src, w, h) {
    const k = [1, 4, 6, 4, 1], tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0; for (let i = -2; i <= 2; i++) { let xx = x + i; if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1; s += src[y * w + xx] * k[i + 2]; }
      tmp[y * w + x] = s / 16;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0; for (let i = -2; i <= 2; i++) { let yy = y + i; if (yy < 0) yy = 0; else if (yy >= h) yy = h - 1; s += tmp[yy * w + x] * k[i + 2]; }
      out[y * w + x] = s / 16;
    }
    return out;
  }
  function intersect(l1, l2) {
    const det = l1.nx * l2.ny - l1.ny * l2.nx;
    if (Math.abs(det) < 1e-6) return null;
    return [(l1.rho * l2.ny - l2.rho * l1.ny) / det, (l1.nx * l2.rho - l2.nx * l1.rho) / det];
  }
  function sameLine(a, b, rTol) {
    let dt = Math.abs(a.t - b.t), rb = b.rho;
    if (dt > 90) { dt = 180 - dt; rb = -rb; }
    return dt <= 6 && Math.abs(a.rho - rb) <= rTol;
  }
  function quadArea(q) {
    let a = 0; for (let i = 0; i < 4; i++) { const p = q[i], n = q[(i + 1) % 4]; a += p[0] * n[1] - n[0] * p[1]; }
    return a / 2;
  }
  function convexAndSane(q, w, h) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const v1x = b[0] - a[0], v1y = b[1] - a[1], v2x = c[0] - b[0], v2y = c[1] - b[1];
      const cr = v1x * v2y - v1y * v2x; const s = cr > 0 ? 1 : -1;
      if (sign && s !== sign) return false; sign = s;
      const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
      if (l1 < 0.12 * Math.min(w, h) || l2 < 0.12 * Math.min(w, h)) return false;
      const cosA = (v1x * v2x + v1y * v2y) / (l1 * l2);           // angle between consecutive edges
      if (Math.abs(cosA) > 0.7) return false;                      // keep corners between 45 and 135 degrees
    }
    return true;
  }

  // Returns { quad: [[x,y]x4] in source pixels (TL,TR,BR,BL), score } or null.
  IMG.detectQuad = function (src, opts) {
    opts = opts || {};
    const size = opts.size || 400;
    const { w: sw, h: sh } = sizeOf(src);
    if (!sw || !sh) return null;
    const s = Math.min(1, size / Math.max(sw, sh));
    const w = Math.max(16, Math.round(sw * s)), h = Math.max(16, Math.round(sh * s));
    const c = makeCanvas(w, h), cx = ctx2d(c); cx.drawImage(src, 0, 0, w, h);
    const d = cx.getImageData(0, 0, w, h).data, n = w * h;
    const g = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    const b = blur5(g, w, h);
    const mag = new Float32Array(n), dir = new Float32Array(n);
    let maxMag = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -b[i - w - 1] - 2 * b[i - 1] - b[i + w - 1] + b[i - w + 1] + 2 * b[i + 1] + b[i + w + 1];
      const gy = -b[i - w - 1] - 2 * b[i - w] - b[i - w + 1] + b[i + w - 1] + 2 * b[i + w] + b[i + w + 1];
      const m = Math.sqrt(gx * gx + gy * gy); mag[i] = m; if (m > maxMag) maxMag = m; dir[i] = Math.atan2(gy, gx);
    }
    if (maxMag < 4) return null;
    const hist = new Int32Array(256), sc = 255 / maxMag;
    for (let i = 0; i < n; i++) hist[(mag[i] * sc) | 0]++;
    let acc = 0, thr = 0; const target = n * 0.91;
    for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc >= target) { thr = k / sc; break; } }
    thr = Math.max(thr, maxMag * 0.06, 6);
    const ex = [], ey = [], et = [];
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, m = mag[i]; if (m < thr) continue;
      let deg = dir[i] * 180 / Math.PI; if (deg < 0) deg += 180; if (deg >= 180) deg -= 180;
      let m1, m2;
      if (deg < 22.5 || deg >= 157.5) { m1 = mag[i - 1]; m2 = mag[i + 1]; }
      else if (deg < 67.5) { m1 = mag[i - w - 1]; m2 = mag[i + w + 1]; }
      else if (deg < 112.5) { m1 = mag[i - w]; m2 = mag[i + w]; }
      else { m1 = mag[i - w + 1]; m2 = mag[i + w - 1]; }
      if (m < m1 || m < m2) continue;
      ex.push(x); ey.push(y); et.push(deg);
    }
    const ne = ex.length; if (ne < 20) return null;
    const D = Math.ceil(Math.hypot(w, h)), nR = 2 * D + 1, nT = 180;
    const cosT = new Float32Array(nT), sinT = new Float32Array(nT);
    for (let t = 0; t < nT; t++) { cosT[t] = Math.cos(t * Math.PI / 180); sinT[t] = Math.sin(t * Math.PI / 180); }
    const votes = new Int32Array(nT * nR), SPREAD = 10;
    for (let k = 0; k < ne; k++) {
      const x = ex[k], y = ey[k], t0 = Math.round(et[k]);
      for (let dt = -SPREAD; dt <= SPREAD; dt++) {
        let t = t0 + dt; if (t < 0) t += 180; else if (t >= 180) t -= 180;
        votes[t * nR + Math.round(x * cosT[t] + y * sinT[t]) + D]++;
      }
    }
    const minVotes = Math.max(12, Math.round(0.12 * Math.min(w, h)));
    let peaks = [];
    for (let t = 0; t < nT; t++) for (let r = 2; r < nR - 2; r++) {
      const v = votes[t * nR + r]; if (v < minVotes) continue;
      let ok = true;
      for (let dt = -2; dt <= 2 && ok; dt++) {
        let tt = t + dt; if (tt < 0) tt += 180; else if (tt >= 180) tt -= 180;
        for (let dr = -2; dr <= 2; dr++) { if (!dt && !dr) continue; if (votes[tt * nR + r + dr] > v) { ok = false; break; } }
      }
      if (ok) peaks.push({ t, rho: r - D, v, nx: cosT[t], ny: sinT[t] });
    }
    peaks.sort((a, b) => b.v - a.v);
    const rTol = Math.max(6, 0.03 * D), kept = [];
    for (const p of peaks) { if (kept.some(k => sameLine(k, p, rTol))) continue; kept.push(p); if (kept.length >= 24) break; }
    const H = [], V = [];
    for (const p of kept) {
      if (p.t >= 45 && p.t < 135) { p.pos = (p.rho - p.nx * w / 2) / p.ny; if (H.length < 8) H.push(p); }
      else { p.pos = (p.rho - p.ny * h / 2) / p.nx; if (V.length < 8) V.push(p); }
    }
    // frame borders as weak candidates, for documents that touch or leave the frame
    const border = (t, rho, pos) => ({ t, rho, v: minVotes, nx: cosT[t], ny: sinT[t], pos, border: true });
    if (!V.some(l => Math.abs(l.pos) < 4)) V.push(border(0, 0, 0));
    if (!V.some(l => Math.abs(l.pos - (w - 1)) < 4)) V.push(border(0, w - 1, w - 1));
    if (!H.some(l => Math.abs(l.pos) < 4)) H.push(border(90, 0, 0));
    if (!H.some(l => Math.abs(l.pos - (h - 1)) < 4)) H.push(border(90, h - 1, h - 1));
    let best = null;
    const inside = p => p && isFinite(p[0]) && isFinite(p[1]) && p[0] > -0.08 * w && p[0] < 1.08 * w && p[1] > -0.08 * h && p[1] < 1.08 * h;
    for (let i = 0; i < V.length; i++) for (let j = i + 1; j < V.length; j++) {
      const vl = V[i].pos < V[j].pos ? V[i] : V[j], vr = vl === V[i] ? V[j] : V[i];
      if (vr.pos - vl.pos < 0.2 * w) continue;
      for (let a = 0; a < H.length; a++) for (let bq = a + 1; bq < H.length; bq++) {
        const ht = H[a].pos < H[bq].pos ? H[a] : H[bq], hb = ht === H[a] ? H[bq] : H[a];
        if (hb.pos - ht.pos < 0.2 * h) continue;
        const q = [intersect(vl, ht), intersect(vr, ht), intersect(vr, hb), intersect(vl, hb)];
        if (!q.every(inside)) continue;
        const area = Math.abs(quadArea(q)); if (area < 0.12 * w * h) continue;
        if (!convexAndSane(q, w, h)) continue;
        const lines = [vl, vr, ht, hb], real = lines.filter(l => !l.border), nb = 4 - real.length;
        if (nb > 2) continue;
        // a frame border stands in for a missing edge only: it brings half the votes of the real
        // edges and the whole quad is discounted, so a real edge wins whenever one was found
        const mean = real.reduce((a, l) => a + l.v, 0) / real.length;
        const votes = lines.reduce((a, l) => a + (l.border ? 0.5 * mean : l.v), 0);
        const score = votes * Math.pow(area / (w * h), 0.75) * (nb ? 0.7 : 1);
        if (!best || score > best.score) best = { q, score, nb };
      }
    }
    if (!best) return null;
    const clampP = p => [Math.min(sw, Math.max(0, p[0] / s)), Math.min(sh, Math.max(0, p[1] / s))];
    const quad = best.q.map(clampP);
    // order TL, TR, BR, BL
    const bySum = quad.slice().sort((p, q2) => (p[0] + p[1]) - (q2[0] + q2[1]));
    const tl = bySum[0], br = bySum[3];
    const rest = quad.filter(p => p !== tl && p !== br).sort((p, q2) => (p[0] - p[1]) - (q2[0] - q2[1]));
    return { quad: [tl, rest[1], br, rest[0]], score: best.score, borders: best.nb };
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
    // m: { bitmap (or a canvas), quad? (the outline the camera showed, in pixels of that picture), filter, maxOut }
    async preview(m) {
      const src = IMG.drawCapped(m.bitmap, 1e9); if (m.bitmap.close) m.bitmap.close();
      let quad = null;
      try { const det = IMG.detectQuad(src, { size: 320, prior: m.quad || undefined }); if (det) quad = det.quad; } catch (e) {}      // searched again on this very picture, as the full-size photo will be
      quad = quad || m.quad;
      quad = quad ? IMG.insetQuad(quad, 0.012) : IMG.fullQuad(src.width, src.height);
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
