'use strict';
/* Snapdoc camera: live edge overlay, single and batch mode, automatic capture when the page
   holds still, import from the photo library. Every shot shows the cropped page at once, made from
   the live picture, with a button to adjust the crop; the full-size photo is processed in the
   background. */
let stream = null, track = null, imageCapture = null, camFromDoc = false, camCount = 0, liveTimer = null, torchOn = false, shooting = false, camGen = 0;
let lastQuad = null, liveQuad = null, autoHold = null, holdSig = null, holdMissSince = 0, sigMissSince = 0, holdUntil = 0, anchorQuad = null, stableSince = 0, readyFrac = 0, wakeLock = null, peekTimer = null, peekUrl = '';
let liveOn = false, rafId = 0, lastFrame = 0, shownQuad = null, targetQuad = null, quadAlpha = 0, readyShown = 0, lastSeenAt = 0, detWorker = null, detSeq = 0; const detPending = new Map();
let peekShot = null, peekSeq = 0; const shots = new Map();      // shots: page id -> the shot it came from, while that page is being worked on
// camSess: one number per opening of the camera. A photo, a finished page or a failure that belongs
// to an earlier opening must not act on the one that is on screen now, even for the same document.
// lastShot: the newest shot of this opening. shotsPending: shots (of any opening) whose photo has not arrived yet.
let camSess = 0, lastShot = null, shotsPending = 0;

function updateCamUI() {
  $('modeSingle').classList.toggle('on', !settings.batch); $('modeBatch').classList.toggle('on', settings.batch);
  $('autoBtn').classList.toggle('on', !!settings.auto);
  $('done').hidden = !camCount;
  $('doneLbl').textContent = 'Done · ' + camCount;
  if (!settings.auto) setHint('');
}
function setHint(t) { const h = $('camHint'); if (h.textContent !== t) h.textContent = t; h.hidden = !t; }
async function keepAwake() {
  if (!('wakeLock' in navigator) || document.hidden || wakeLock) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch (e) { wakeLock = null; }
}
async function openCamera(doc) {
  if (doc && !hasContent(doc)) { toast(STILL_DOWNLOADING); return; }
  camDoc = doc || null; camFromDoc = !!doc; camCount = 0; shooting = false; camSess++; lastShot = null;
  lastQuad = null; liveQuad = null; autoHold = null; holdSig = null; holdUntil = 0; anchorQuad = null; readyFrac = 0;
  $('doneThumb').hidden = true; $('camMsg').hidden = true; $('shutter').disabled = false; setHint(''); hidePeek();
  push('cam'); updateCamUI();
  startDetWorker();                                  // it warms up while the camera starts
  await startStream();
}
// also called when the app comes back to the front and the phone had taken the camera away
async function startStream() {
  const my = ++camGen;                               // a later start or a stop makes this call stand down
  if (stream) for (const t of stream.getTracks()) t.stop();
  stream = null; track = null; imageCapture = null;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { camError('This browser has no camera access. You can import photos instead.'); return; }
  let s;
  try { s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false }); }
  catch (e) {
    if (my !== camGen) return;
    camError(e && e.name === 'NotAllowedError' ? 'The camera permission was denied. Allow it in the site settings, or import photos instead.' : 'The camera could not be started. You can import photos instead.'); return;
  }
  const drop = () => { for (const t of s.getTracks()) t.stop(); };
  if (my !== camGen || current() !== 'cam') { drop(); return; }
  stream = s; track = stream.getVideoTracks()[0];
  $('camMsg').hidden = true; $('shutter').disabled = false;
  imageCapture = self.ImageCapture ? new ImageCapture(track) : null;
  const v = $('video'); v.srcObject = stream;
  try { await v.play(); } catch (e) {}
  if (my !== camGen) { drop(); if (stream === s) { stream = null; track = null; imageCapture = null; } return; }
  let caps = {}; try { caps = track.getCapabilities ? track.getCapabilities() : {}; } catch (e) {}
  $('torchBtn').hidden = !caps.torch; $('torchBtn').style.opacity = .6; torchOn = false;
  keepAwake(); startLive();
}
function resumeCam() {                               // back in front, or unlocked again
  if (current() !== 'cam' || document.hidden || locked) return;
  if (!track || track.readyState !== 'live') startStream(); else { keepAwake(); if (!liveOn) startLive(); }
}
function camError(msg) {
  const m = $('camMsg'); m.hidden = false; m.innerHTML = '<div>' + esc(msg) + '</div><button id="camImport">Import photos</button>';
  $('camImport').addEventListener('click', pickPhotos);
  $('shutter').disabled = true;
}
function stopCamera() {
  camGen++; stopLive(); hidePeek();
  if (stream) for (const t of stream.getTracks()) t.stop();
  stream = null; track = null; imageCapture = null; $('video').srcObject = null;
  const ov = $('camOverlay'); ov.getContext('2d').clearRect(0, 0, ov.width, ov.height);
  if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  const d = camDoc; camDoc = null; camFromDoc = false;
  if (d && !d.pages.length && !d.rev && docs.includes(d)) { dropEmptyDoc(d); persist(); }      // every shot failed: no empty document stays in the list
}
// ---------- live outline ----------
// Two loops. Detection runs about eight times a second, in its own worker where the browser allows
// it, so the picture never stutters. Drawing runs with every screen refresh and glides the outline
// toward the latest result, so it moves smoothly instead of jumping from find to find.
function startDetWorker() {
  if (detWorker || !self.Worker || !self.OffscreenCanvas || !self.createImageBitmap) return;
  try {
    detWorker = new Worker('worker.js');
    detWorker.onmessage = e => { const p = detPending.get(e.data.id); if (!p) return; detPending.delete(e.data.id); if (e.data.ok) p.res(e.data); else p.rej(new Error(e.data.error)); };
    detWorker.onerror = () => { for (const p of detPending.values()) p.rej(new Error('worker failed')); detPending.clear(); detWorker = null; };
    detWorker.postMessage({ id: 0, cmd: 'warm' });     // a dry run of the quick preview, so the first real one is fast
  } catch (e) { detWorker = null; }
}
function startLive() {
  stopLive(); liveOn = true; startDetWorker();
  lastQuad = null; liveQuad = null;                    // an outline from before the camera was restarted is not the one it sees now
  shownQuad = null; targetQuad = null; quadAlpha = 0; readyShown = 0; lastSeenAt = 0; lastFrame = 0;
  detectTick(); rafId = requestAnimationFrame(renderLive);
}
function stopLive() { liveOn = false; clearTimeout(liveTimer); liveTimer = null; cancelAnimationFrame(rafId); rafId = 0; }
const quadDist = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));
const quadArea = qd => Math.abs(qd.reduce((a, p, i) => a + p[0] * qd[(i + 1) % 4][1] - qd[(i + 1) % 4][0] * p[1], 0)) / 2;
// What is on the page, as a tiny brightness pattern of the flattened outline. It stays the same when
// the camera moves and changes when another page is put down.
function pageSig(v, quad) {
  try {
    const small = IMG.drawCapped(v, 240), k = small.width / (v.videoWidth || small.width);
    const w = IMG.warp(small, quad.map(p => [p[0] * k, p[1] * k]), { maxSide: 48 });
    const c = IMG.makeCanvas(16, 16), cx = c.getContext('2d', { willReadFrequently: true }); cx.drawImage(w, 0, 0, 16, 16);
    const d = cx.getImageData(0, 0, 16, 16).data, s = new Float32Array(256); let m = 0;
    for (let i = 0; i < 256; i++) { s[i] = 0.3 * d[i * 4] + 0.59 * d[i * 4 + 1] + 0.11 * d[i * 4 + 2]; m += s[i]; }
    m /= 256; for (let i = 0; i < 256; i++) s[i] -= m;
    return s;
  } catch (e) { return null; }
}
const sigDiff = (a, b) => { let t = 0; for (let i = 0; i < 256; i++) t += Math.abs(a[i] - b[i]); return t / 256; };
// one detection on the current video frame; the result is in video pixels
async function detectOnce(v) {
  const vw = v.videoWidth, vh = v.videoHeight, k = Math.min(1, 240 / Math.max(vw, vh));
  if (detWorker) {
    let bmp;
    try { bmp = await createImageBitmap(v, { resizeWidth: Math.max(1, Math.round(vw * k)), resizeHeight: Math.max(1, Math.round(vh * k)), resizeQuality: 'low' }); }
    catch (e) { return null; }                         // the video had no picture just now: nothing found this time, the worker is fine
    const w = detWorker; if (!w) { if (bmp.close) bmp.close(); return null; }
    try {
      const kx = bmp.width / vw, ky = bmp.height / vh, id = ++detSeq;
      const res = await new Promise((ok, no) => { detPending.set(id, { res: ok, rej: no }); w.postMessage({ id, cmd: 'detect', bitmap: bmp, size: 240, prior: liveQuad ? liveQuad.map(p => [p[0] * kx, p[1] * ky]) : null }, [bmp]); });
      return res.det ? { quad: res.det.quad.map(p => [p[0] / kx, p[1] / ky]), borders: res.det.borders } : null;
    } catch (e) {                                      // the worker itself failed: give it up, and answer everything that still waits for it
      if (detWorker === w) { detWorker = null; try { w.terminate(); } catch (e2) {} for (const p of detPending.values()) p.rej(new Error('worker stopped')); detPending.clear(); }
    }
  }
  try { return IMG.detectQuad(v, { size: 240, prior: liveQuad || undefined }); } catch (e) { return null; }
}
async function detectTick() {
  if (!liveOn) return;
  const t0 = performance.now(), v = $('video');
  if (v.videoWidth && current() === 'cam' && !document.hidden && !shooting && !locked && !passive) {
    const gen = camGen, det = await detectOnce(v);
    if (!liveOn || gen !== camGen) return;
    if (!shooting) onDetection(det, v, performance.now());
  }
  if (liveOn) liveTimer = setTimeout(detectTick, Math.max(30, 120 - (performance.now() - t0)));
}
function onDetection(det, v, now) {
  const vw = v.videoWidth, vh = v.videoHeight, diag = Math.hypot(vw, vh);
  const quad = det && det.borders < 2 ? det.quad : null;
  liveQuad = quad; if (quad) { targetQuad = quad; lastSeenAt = now; }
  const full = det && det.borders === 0 && quadArea(det.quad) > 0.2 * vw * vh ? det.quad : null;   // automatic capture wants all four edges
  let hint = '';
  readyFrac = 0;
  if (settings.auto) {
    if (!autoHold && holdUntil > now && full) { autoHold = full; holdSig = pageSig(v, full); holdMissSince = 0; sigMissSince = 0; holdUntil = 0; }   // shutter pressed by hand without an outline: latch the page once it is seen
    if (autoHold) {                                   // just captured: arm again only when this page has really gone
      if (!full) { if (!holdMissSince) holdMissSince = now; else if (now - holdMissSince > 800) autoHold = null; }
      else {
        holdMissSince = 0;
        const sg = holdSig ? pageSig(v, full) : null;
        if (sg && sigDiff(sg, holdSig) > 12) { if (!sigMissSince) sigMissSince = now; else if (now - sigMissSince > 450) autoHold = null; } else sigMissSince = 0;      // another page lies there now
      }
      anchorQuad = null; hint = settings.batch ? 'Captured · next page' : '';
    } else if (!full) { anchorQuad = null; hint = 'Looking for a document'; }
    else {
      if (!anchorQuad || quadDist(full, anchorQuad) > 0.03 * diag) { anchorQuad = full; stableSince = now; }      // moved: the clock starts again
      readyFrac = Math.min(1, (now - stableSince) / 900);
      hint = 'Hold still';
      if (readyFrac >= 1) { anchorQuad = null; lastQuad = full; setHint(hint); shoot(); return; }
    }
    lastQuad = full;
  }
  setHint(hint);
}
function renderLive(ts) {
  if (!liveOn) return;
  rafId = requestAnimationFrame(renderLive);
  const v = $('video'); if (!v.videoWidth || document.hidden) return;
  const dt = Math.min(100, lastFrame ? ts - lastFrame : 16); lastFrame = ts;
  const ease = 1 - Math.exp(-dt / 70), now = performance.now();
  if (targetQuad && now - lastSeenAt < 450) {         // a short gap in detection does not make the outline flicker
    if (!shownQuad) shownQuad = targetQuad.map(p => p.slice());
    else for (let i = 0; i < 4; i++) { shownQuad[i][0] += (targetQuad[i][0] - shownQuad[i][0]) * ease; shownQuad[i][1] += (targetQuad[i][1] - shownQuad[i][1]) * ease; }
    quadAlpha = Math.min(1, quadAlpha + dt / 140);
  } else { quadAlpha = Math.max(0, quadAlpha - dt / 220); if (!quadAlpha) shownQuad = null; }
  readyShown += (readyFrac - readyShown) * (1 - Math.exp(-dt / 90));
  drawOverlay(shownQuad, v.videoWidth, v.videoHeight, readyShown, quadAlpha);
}
function drawOverlay(quad, vw, vh, ready, alpha) {
  const ov = $('camOverlay'), box = ov.getBoundingClientRect(), dpr = Math.min(2, self.devicePixelRatio || 1);
  const W = Math.round(box.width * dpr), H = Math.round(box.height * dpr); if (!W || !H) return;
  if (ov.width !== W || ov.height !== H) { ov.width = W; ov.height = H; }
  const cx = ov.getContext('2d'); cx.clearRect(0, 0, W, H);
  if (!quad || !(alpha > 0)) return;
  const s = Math.min(W / vw, H / vh), ox = (W - vw * s) / 2, oy = (H - vh * s) / 2, P = quad.map(p => [ox + p[0] * s, oy + p[1] * s]);
  cx.globalAlpha = alpha; cx.lineJoin = 'round';
  cx.beginPath(); P.forEach((p, i) => cx[i ? 'lineTo' : 'moveTo'](p[0], p[1])); cx.closePath();
  cx.fillStyle = 'rgba(45,212,191,' + (0.14 + 0.3 * ready).toFixed(3) + ')'; cx.fill();
  cx.lineWidth = (2.5 + 1.5 * ready) * dpr; cx.strokeStyle = '#2dd4bf'; cx.stroke();
  for (const p of P) { cx.beginPath(); cx.arc(p[0], p[1], (5 + 3 * ready) * dpr, 0, Math.PI * 2); cx.fillStyle = '#fff'; cx.fill(); cx.lineWidth = 2 * dpr; cx.strokeStyle = '#0f766e'; cx.stroke(); }
  cx.globalAlpha = 1;
}
// The picture of the shutter moment is kept before anything is waited for. It is the photo where
// the browser has no still camera, and it stands in when the still camera fails, takes too long,
// or the camera is closed while the photo is under way. A video without a picture gives no photo.
async function takePhotoBlob() {
  const v = $('video'), cap = imageCapture; let still = null;
  if (v.videoWidth && v.videoHeight) { try { still = IMG.makeCanvas(v.videoWidth, v.videoHeight); still.getContext('2d').drawImage(v, 0, 0); } catch (e) { still = null; } }
  if (cap) {                                          // full sensor resolution where the browser offers it
    try {
      const photo = await Promise.race([cap.takePhoto(), new Promise((ok, no) => setTimeout(() => no(new Error('the photo took too long')), 6000))]);
      if (photo && photo.size) return photo;
    } catch (e) {}
  }
  return still ? IMG.toBlob(still, 'image/jpeg', 0.92) : null;
}
// small picture for the Done button, taken from the live view and already cut to the outline
function quickThumb(v, quad) {
  try {
    const small = IMG.drawCapped(v, 360);
    if (!quad) return IMG.drawCapped(small, 120).toDataURL('image/jpeg', 0.7);
    const k = small.width / v.videoWidth;
    return IMG.warp(small, quad.map(p => [p[0] * k, p[1] * k]), { maxSide: 140 }).toDataURL('image/jpeg', 0.7);
  } catch (e) { return null; }
}
// ---------- the page at once ----------
// The moment the shutter fires, the live picture of that moment is cut to the page and given its
// look, in the worker that otherwise looks for the outline. That takes a fraction of a second, so
// the cropped page is on screen while the full-size photo is still being taken and worked on.
// quad: the outline the camera showed, in video pixels. Resolves to { jpeg, w, h } or null.
async function quickPreview(v, quad) {
  const vw = v.videoWidth, vh = v.videoHeight; if (!vw || !vh) return null;
  const k = Math.min(1, 1280 / Math.max(vw, vh)), msg = { cmd: 'preview', quad: quad ? quad.map(p => [p[0] * k, p[1] * k]) : null, filter: lookOf(settings.filter), maxOut: 900 };
  try {
    if (detWorker) {
      const bmp = await createImageBitmap(v, { resizeWidth: Math.max(1, Math.round(vw * k)), resizeHeight: Math.max(1, Math.round(vh * k)), resizeQuality: 'medium' });
      const w = detWorker; if (!w) { if (bmp.close) bmp.close(); return null; }
      const id = ++detSeq;
      return await new Promise((ok, no) => { detPending.set(id, { res: ok, rej: no }); w.postMessage(Object.assign({ id, bitmap: bmp }, msg), [bmp]); });
    }
    const still = IMG.drawCapped(v, 1280);             // no worker: keep this moment, work on it once the flash has been drawn
    await new Promise(r => setTimeout(r, 50));
    return await IMG.tasks.preview(Object.assign({ bitmap: still }, msg));
  } catch (e) { return null; }
}
// A shot: { sess, gen, label, quick: { url, w, h } once the quick picture is there, pageId and doc once
// the photo is there, counted: it is in this opening's page count, shown: its picture was on screen,
// dead: the photo or the page failed, done: its page is finished, fixing: "Adjust crop" was tapped }
function shotQuickReady(shot, r) {
  if (!r || !r.jpeg || shot.dead || shot.done) return;           // the photo failed, or its page is finished already
  shot.quick = { url: URL.createObjectURL(r.jpeg), w: r.w, h: r.h };
  if (current() === 'cam' && camGen === shot.gen && !locked) showPeek(shot.quick.url, shot.label, shot, false);
  attachQuick(shot);
}
// The page of a shot gets the quick picture as its stand-in as soon as both exist.
function attachQuick(shot) {
  if (!shot.quick || !shot.pageId || shot.attached) return;
  shot.attached = true;
  const d = shot.doc, p = d && !d.deleted ? d.pages.find(x => x.id === shot.pageId) : null;
  if (!p || !p.status) { const u = shot.quick.url; setTimeout(() => URL.revokeObjectURL(u), 4000); return; }     // that page is finished or gone already
  quickPrev.set(shot.pageId, shot.quick);
  if (current() === 'doc' && curDoc === d) renderDoc();
}
function killShot(shot) {
  shot.dead = true; if (peekShot === shot) hidePeek();
  if (shot.quick && !shot.attached) { shot.attached = true; URL.revokeObjectURL(shot.quick.url); }
}
async function shoot() {
  const v = $('video');
  if (shooting || !stream || locked || passive || !v.videoWidth) return;      // no picture in the viewfinder yet: nothing to take
  shooting = true; shotsPending++;
  const d0 = camDoc, sess = camSess, quad0 = settings.auto ? lastQuad : null;  // lastQuad is kept up to date only while Auto is on
  autoHold = quad0; holdSig = quad0 ? pageSig(v, quad0) : null; holdUntil = quad0 ? 0 : performance.now() + 3000; holdMissSince = 0; sigMissSince = 0; anchorQuad = null; readyFrac = 0;
  const fx = $('flashFx'); fx.classList.remove('on'); void fx.offsetWidth; fx.classList.add('on');
  const thumb = quickThumb(v, quad0 || liveQuad);
  const shot = lastShot = { sess, gen: camGen, label: 'Page ' + ((d0 ? d0.pages.length : 0) + 1), quick: null, pageId: null, doc: null, counted: false, shown: false, dead: false, done: false, attached: false, fixing: false };
  quickPreview(v, quad0 || liveQuad).then(r => shotQuickReady(shot, r));
  let blob = null; try { blob = await takePhotoBlob(); } catch (e) {}
  shotsPending--; if (sess === camSess) shooting = false;                      // a later opening of the camera has its own shutter
  if (!blob) { killShot(shot); if (sess === camSess && current() === 'cam') toast('Could not take the photo.'); return; }
  // Done, X or Back was pressed while the photo was being taken, or the camera was even opened again:
  // the photo belongs to the document it was shot for, not to whatever the camera shows now
  if (sess !== camSess || current() !== 'cam' || camDoc !== d0) { lateCapture(blob, d0, shot); return; }
  addCapture(blob, thumb, false, shot);
}
// A shot that already flashed is never thrown away: it goes into the document the camera was
// working on, or into a new one.
function lateCapture(blob, d0, shot) {
  let d = d0 && docs.includes(d0) && !d0.deleted ? d0 : null;
  if (!d) d = newDoc();
  const pageId = uid();
  d.pages.push({ id: pageId, status: 'processing' }); save({ sync: false });
  if (shot) { shot.pageId = pageId; shot.doc = d; shots.set(pageId, shot); attachQuick(shot); }
  queue(() => processNew(d, pageId, blob)); renderAll();
  toast('The last shot was added to ' + ((d.name || '').trim() || 'a new document') + '.');
}
// A capture becomes a placeholder page at once; the worker fills it in.
function addCapture(blob, thumb, stay, shot) {
  if (!camDoc) camDoc = newDoc();
  else if (!docs.includes(camDoc)) { docs.unshift(camDoc); snap[camDoc.id] = sigOf(camDoc); }      // dropped after a failed first page: take it back
  const d = camDoc, pageId = uid();
  d.pages.push({ id: pageId, status: 'processing' }); camCount++;
  if (shot) { shot.pageId = pageId; shot.doc = d; shot.counted = true; shots.set(pageId, shot); attachQuick(shot); }
  save({ sync: false });
  queue(() => processNew(d, pageId, blob));
  if (thumb) { $('doneThumb').src = thumb; $('doneThumb').hidden = false; }
  updateCamUI();
  if (!stay && !settings.batch) finishCamera();
}
function finishCamera() {
  const d = camDoc;
  if (camFromDoc || !d || !docs.includes(d)) { back(); return; }
  stopCamera(); openDoc(d, { replace: true, fresh: true });      // straight to the pages, cursor in the name
}
function dropEmptyDoc(d) {
  const i = docs.indexOf(d); if (i >= 0) docs.splice(i, 1); delete snap[d.id];
  if (curDoc === d && current() === 'doc') back();
}
async function processNew(d, pageId, blob) {
  const look = lookOf(settings.filter);
  const forget = () => { const s = shots.get(pageId); shots.delete(pageId); if (s) killShot(s); dropQuick(pageId); pageSettled(pageId); return s; };
  const fail = () => {                                // nothing half-done stays behind, whatever step failed
    const i = d.pages.findIndex(x => x.id === pageId); if (i >= 0) d.pages.splice(i, 1);
    const s = forget();
    idb.del('pages', pageId).catch(() => {});
    if (d === camDoc && s && s.counted && s.sess === camSess) { camCount = Math.max(0, camCount - 1); updateCamUI(); }      // only a page this opening of the camera counted
    if (!d.pages.length && !d.rev && d !== camDoc) dropEmptyDoc(d);
    save({ sync: false }); renderAll();
  };
  let r;
  try { r = await task({ cmd: 'process', blob, filter: look, keepOrig: true, maxOrig: 2800, maxOut: 2400 }); }
  catch (e) { fail(); throw e; }
  const p = d.pages.find(x => x.id === pageId);
  if (!p || d.deleted) { forget(); return; }                    // removed while it was processing
  try { await pagePut(pageId, d.id, { jpeg: r.jpeg, prev: r.prev, orig: r.orig, meta: { quad: r.quad, w: r.w, h: r.h, origW: r.origW, origH: r.origH, filter: look, rot: 0, thumb: r.thumb } }); }
  catch (e) { fail(); throw e; }
  Object.assign(p, { w: r.w, h: r.h, size: r.jpeg.size, o: 1 }); delete p.status;
  if (!docs.includes(d) && !d.deleted) { docs.unshift(d); snap[d.id] = sigOf(d); }
  if (hasContent(d)) { touchContent(d); save(); }
  else { p.local = 1; save({ sync: false }); syncNow(); }        // a newer version is still downloading: this page is added to it once it is here
  const shot = shots.get(pageId); shots.delete(pageId); if (shot) shot.done = true;
  renderAll(); showFinished(d, r, shot); pageSettled(pageId);
  setTimeout(() => dropQuick(pageId), 2500);                    // by then the finished picture stands where the quick one stood
}
// The finished page of a shot. Its quick picture was shown at the moment of the shot; if that is
// still up, the finished one takes its place quietly. Only a shot that never got a quick picture
// (an old browser) gets its pop-up now. All of this is for the newest shot of this opening of the
// camera only: an import, a page of an earlier opening or an older page that finishes late changes
// neither the picture on the Done button nor the pop-up.
function showFinished(d, r, shot) {
  if (current() !== 'cam' || camDoc !== d || locked) return;
  if (!shot || shot.sess !== camSess || shot !== lastShot) return;
  $('doneThumb').src = r.thumb; $('doneThumb').hidden = false;
  // the photo can show the page a little differently from the live picture, and then it may be cut
  // differently: in that case the stored page is shown, so the pop-up never confirms a crop that is not there
  const same = shot.quick && Math.abs(Math.log((r.w / r.h) / (shot.quick.w / shot.quick.h))) < 0.04;
  if (shot.shown && same) {
    if (peekShot === shot && !$('camPeek').hidden) { if (peekUrl) URL.revokeObjectURL(peekUrl); peekUrl = URL.createObjectURL(r.prev); $('camPeekImg').src = peekUrl; }
    return;
  }
  if (shot.fixing) return;                             // "Adjust crop" was tapped: the corners open next and show the stored crop
  showPeek(URL.createObjectURL(r.prev), shot.label, shot, true);
}
// feedback after each shot: the cropped, cleaned page pops up large for a moment and lands on the
// Done button. owned: the address belongs to the pop-up and is given back when it closes.
function showPeek(url, label, shot, owned) {
  hidePeek();
  const el = $('camPeek'), img = $('camPeekImg'), my = peekSeq;
  if (owned) peekUrl = url;
  peekShot = shot;
  $('camPeekLbl').textContent = label;
  img.onload = () => {                                 // only once the picture is really there: never the previous page for a blink
    if (my !== peekSeq || !el.hidden) return;
    if (shot) shot.shown = true;
    el.hidden = false; el.classList.remove('go'); void el.offsetWidth; el.classList.add('go');
    peekTimer = setTimeout(hidePeek, PEEK_MS);
  };
  img.onerror = () => { if (my === peekSeq) hidePeek(); };
  img.src = url;
}
function hidePeek() {
  clearTimeout(peekTimer); peekTimer = null; peekShot = null; peekSeq++;
  const el = $('camPeek'), img = $('camPeekImg'), btn = $('camPeekFix'); el.hidden = true; el.classList.remove('go');
  img.onload = img.onerror = null; img.removeAttribute('src');
  btn.textContent = 'Adjust crop'; btn.disabled = false;
  if (peekUrl) { URL.revokeObjectURL(peekUrl); peekUrl = ''; }
}
const PEEK_MS = 2200;                                  // keep equal to the length of the "peek" animation in index.html
// "Adjust crop" on the pop-up: the pop-up stays, and the corners of that page open as soon as its
// photo has been worked through. If the camera has moved on to the document meanwhile (single
// shot), they open there.
async function peekFix() {
  const shot = peekShot; if (!shot || shot.dead || shot.fixing) return;
  shot.fixing = true;
  clearTimeout(peekTimer); peekTimer = null;
  const btn = $('camPeekFix'); $('camPeek').classList.remove('go'); btn.textContent = 'Opening…'; btn.disabled = true;
  busy(true);
  await new Promise(res => { const t = setInterval(() => { if (shot.dead || shot.done) { clearInterval(t); res(); } }, 80); });
  busy(false); shot.fixing = false;
  if (peekShot === shot) hidePeek();
  const d = shot.doc, p = d && !d.deleted ? d.pages.find(x => x.id === shot.pageId) : null;
  if (shot.dead || !p || p.status || locked || passive) return;
  if ((current() === 'cam' && camDoc === d) || (current() === 'doc' && curDoc === d)) openEdit(p, d);
}
// back in the camera after the corners: the page that still lies there is not captured a second time
function camAfterEdit() {
  if (!stack.includes('cam')) return;
  if (settings.auto && !autoHold) holdUntil = performance.now() + 3000;
  resumeCam();                                         // the phone may have taken the camera away while the corners were open
}
$('camPeekFix').addEventListener('click', peekFix);
$('camPeekImg').addEventListener('click', () => { const s = peekShot; if (!s || !s.fixing) hidePeek(); });      // a tap on the picture puts it away
function pickPhotos() { holdReloadUntil = Date.now() + 600000; $('importInput').click(); }   // the picker hides the app; do not restart it on return
$('shutter').addEventListener('click', shoot);
$('camClose').addEventListener('click', () => { if (camCount && !camFromDoc) finishCamera(); else back(); });
$('done').addEventListener('click', finishCamera);
$('modeSingle').addEventListener('click', () => { settings.batch = false; saveSettings(); updateCamUI(); });
$('modeBatch').addEventListener('click', () => { settings.batch = true; saveSettings(); updateCamUI(); });
$('autoBtn').addEventListener('click', () => { settings.auto = !settings.auto; saveSettings(); lastQuad = null; anchorQuad = null; autoHold = null; holdUntil = 0; readyFrac = 0; updateCamUI(); });
$('torchBtn').addEventListener('click', async () => {
  if (!track) return; torchOn = !torchOn;
  try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch (e) { torchOn = false; }
  $('torchBtn').style.opacity = torchOn ? 1 : .6;
});
$('gallery').addEventListener('click', pickPhotos);
$('importInput').addEventListener('cancel', () => { holdReloadUntil = 0; });
$('importInput').addEventListener('change', e => {
  const files = Array.from(e.target.files || []).filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name));
  e.target.value = ''; holdReloadUntil = 0;
  if (!files.length || current() !== 'cam' || passive) return;
  for (const f of files) addCapture(f, null, true);
  finishCamera();
});
