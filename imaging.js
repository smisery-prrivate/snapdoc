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
    const out = makeCanvas(W, H), octx = out.getContext('2d'), od = octx.createImageData(W, H), o = od.data;
    const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], hh = m[7];
    const uMax = sw - 1.001, vMax = sh - 1.001, row = sw * 4;
    let k = 0;
    for (let y = 0; y < H; y++) {
      const yc = y + 0.5;
      for (let x = 0; x < W; x++) {
        const xc = x + 0.5, den = g * xc + hh * yc + 1;
        let u = (a * xc + b * yc + c) / den - 0.5, v = (d * xc + e * yc + f) / den - 0.5;
        if (!(u > 0)) u = 0; else if (u > uMax) u = uMax;
        if (!(v > 0)) v = 0; else if (v > vMax) v = vMax;
        const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0;
        const i00 = y0 * row + x0 * 4, i01 = i00 + 4, i10 = i00 + row, i11 = i10 + 4;
        const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy;
        o[k] = sd[i00] * w00 + sd[i01] * w01 + sd[i10] * w10 + sd[i11] * w11;
        o[k + 1] = sd[i00 + 1] * w00 + sd[i01 + 1] * w01 + sd[i10 + 1] * w10 + sd[i11 + 1] * w11;
        o[k + 2] = sd[i00 + 2] * w00 + sd[i01 + 2] * w01 + sd[i10 + 2] * w10 + sd[i11 + 2] * w11;
        o[k + 3] = 255; k += 4;
      }
    }
    octx.putImageData(od, 0, 0);
    return out;
  };

  // ---------- enhancement: shadow removal via local paper-white estimate ----------
  IMG.FILTERS = ['color', 'gray', 'bw', 'photo'];
  IMG.enhance = function (cv, mode) {
    mode = mode || 'color';
    if (mode === 'photo') return cv;
    const w = cv.width, h = cv.height, cx = ctx2d(cv);
    const id = cx.getImageData(0, 0, w, h), d = id.data;
    const blk = Math.max(8, Math.round(Math.max(w, h) / 80));
    const bw = Math.ceil(w / blk), bh = Math.ceil(h / blk);
    const bg = new Float32Array(bw * bh * 3);
    for (let y = 0; y < h; y++) {
      const by = (y / blk) | 0;
      for (let x = 0; x < w; x++) {
        const bi = (by * bw + ((x / blk) | 0)) * 3, i = (y * w + x) * 4;
        if (d[i] > bg[bi]) bg[bi] = d[i];
        if (d[i + 1] > bg[bi + 1]) bg[bi + 1] = d[i + 1];
        if (d[i + 2] > bg[bi + 2]) bg[bi + 2] = d[i + 2];
      }
    }
    // paper white = bright percentile of the block maxima; dark blocks (photos, logos) get a floor
    const lums = []; for (let i = 0; i < bw * bh; i++) lums.push(0.299 * bg[i * 3] + 0.587 * bg[i * 3 + 1] + 0.114 * bg[i * 3 + 2]);
    lums.sort((a, b) => a - b);
    const white = Math.max(40, lums[Math.floor(lums.length * 0.9)]), floor = 0.45 * white;
    for (let i = 0; i < bg.length; i++) if (bg[i] < floor) bg[i] = floor;
    // two box-blur passes on the small grid
    const tmp = new Float32Array(bg.length);
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) for (let ch = 0; ch < 3; ch++) {
        let s = 0, cnt = 0; for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= bw) continue; s += bg[(y * bw + xx) * 3 + ch]; cnt++; }
        tmp[(y * bw + x) * 3 + ch] = s / cnt;
      }
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) for (let ch = 0; ch < 3; ch++) {
        let s = 0, cnt = 0; for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= bh) continue; s += tmp[(yy * bw + x) * 3 + ch]; cnt++; }
        bg[(y * bw + x) * 3 + ch] = s / cnt;
      }
    }
    // upsample the background with the GPU
    const small = makeCanvas(bw, bh), sctx = small.getContext('2d'), sid = sctx.createImageData(bw, bh);
    for (let i = 0; i < bw * bh; i++) { sid.data[i * 4] = bg[i * 3]; sid.data[i * 4 + 1] = bg[i * 3 + 1]; sid.data[i * 4 + 2] = bg[i * 3 + 2]; sid.data[i * 4 + 3] = 255; }
    sctx.putImageData(sid, 0, 0);
    const big = makeCanvas(bw * blk, bh * blk), bctx = ctx2d(big);
    bctx.imageSmoothingEnabled = true; bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(small, 0, 0, bw, bh, 0, 0, bw * blk, bh * blk);
    const bd = bctx.getImageData(0, 0, w, h).data;
    const lo = 0.10, hi = 0.94, range = hi - lo;
    const n = w * h;
    if (mode === 'color') {
      for (let i = 0; i < n * 4; i += 4) for (let ch = 0; ch < 3; ch++) {
        const v = (d[i + ch] / Math.max(1, bd[i + ch]) - lo) / range * 255;
        d[i + ch] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    } else {
      for (let i = 0; i < n * 4; i += 4) {
        const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const lb = Math.max(1, 0.299 * bd[i] + 0.587 * bd[i + 1] + 0.114 * bd[i + 2]);
        let v = (l / lb - lo) / range;
        if (mode === 'bw') v = 1 / (1 + Math.exp(-(v - 0.62) * 16));
        v = v < 0 ? 0 : v > 1 ? 255 : v * 255;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    }
    cx.putImageData(id, 0, 0);
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
  IMG.tasks = {
    // m: { blob, quad?, filter, rot, keepOrig, maxOrig, maxOut }
    async process(m) {
      let bmp;
      try { bmp = await createImageBitmap(m.blob, { imageOrientation: 'from-image' }); } catch (e) { bmp = await createImageBitmap(m.blob); }   // older browsers reject the option
      const src = IMG.drawCapped(bmp, m.maxOrig || 2400); if (bmp.close) bmp.close();
      let quad = m.quad;
      if (!quad) { const det = IMG.detectQuad(src); quad = det ? IMG.insetQuad(det.quad, 0.012) : IMG.fullQuad(src.width, src.height); }
      let out = IMG.warp(src, quad, { maxSide: m.maxOut || 2000 });
      out = IMG.enhance(out, m.filter || 'color');
      if ((m.filter || 'color') !== 'photo') {      // a thin white frame hides slivers of table at the paper's edge
        const fx = out.getContext('2d'), fw = Math.max(2, Math.round(Math.min(out.width, out.height) * 0.006));
        fx.strokeStyle = '#fff'; fx.lineWidth = fw * 2; fx.strokeRect(0, 0, out.width, out.height);
      }
      if (m.rot) out = IMG.rotate(out, m.rot);
      const r = await derive(out);
      r.quad = quad; r.origW = src.width; r.origH = src.height;
      r.orig = m.keepOrig ? await IMG.toBlob(src, 'image/jpeg', 0.85) : null;
      return r;
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
