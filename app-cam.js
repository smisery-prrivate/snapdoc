'use strict';
/* Snapdoc camera: live edge overlay, single and batch mode, automatic capture when the page
   holds still, import from the photo library. Captures are processed in the background. */
let stream = null, track = null, imageCapture = null, camFromDoc = false, camCount = 0, liveTimer = null, torchOn = false, shooting = false;
let stableN = 0, lastQuad = null, autoHold = null, holdMiss = 0, wakeLock = null;

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
  camDoc = doc || null; camFromDoc = !!doc; camCount = 0; shooting = false; stableN = 0; lastQuad = null; autoHold = null;
  $('doneThumb').hidden = true; $('camMsg').hidden = true; $('shutter').disabled = false; setHint('');
  push('cam'); updateCamUI();
  await startStream();
}
// also called when the app comes back to the front and the phone had taken the camera away
async function startStream() {
  if (stream) for (const t of stream.getTracks()) t.stop();
  stream = null; track = null; imageCapture = null;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { camError('This browser has no camera access. You can import photos instead.'); return; }
  let s;
  try { s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false }); }
  catch (e) { camError(e && e.name === 'NotAllowedError' ? 'The camera permission was denied. Allow it in the site settings, or import photos instead.' : 'The camera could not be started. You can import photos instead.'); return; }
  if (current() !== 'cam') { for (const t of s.getTracks()) t.stop(); return; }
  stream = s; track = stream.getVideoTracks()[0];
  imageCapture = self.ImageCapture ? new ImageCapture(track) : null;
  const v = $('video'); v.srcObject = stream;
  try { await v.play(); } catch (e) {}
  let caps = {}; try { caps = track.getCapabilities ? track.getCapabilities() : {}; } catch (e) {}
  $('torchBtn').hidden = !caps.torch; $('torchBtn').style.opacity = .6; torchOn = false;
  keepAwake(); startLive();
}
function camError(msg) {
  const m = $('camMsg'); m.hidden = false; m.innerHTML = '<div>' + esc(msg) + '</div><button id="camImport">Import photos</button>';
  $('camImport').addEventListener('click', pickPhotos);
  $('shutter').disabled = true;
}
function stopCamera() {
  stopLive();
  if (stream) for (const t of stream.getTracks()) t.stop();
  stream = null; track = null; imageCapture = null; $('video').srcObject = null;
  const ov = $('camOverlay'); ov.getContext('2d').clearRect(0, 0, ov.width, ov.height);
  if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  camDoc = null; camFromDoc = false;
}
function startLive() { stopLive(); liveTimer = setInterval(liveDetect, 300); }
function stopLive() { clearInterval(liveTimer); liveTimer = null; }
const quadDist = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));
const quadArea = qd => Math.abs(qd.reduce((a, p, i) => a + p[0] * qd[(i + 1) % 4][1] - qd[(i + 1) % 4][0] * p[1], 0)) / 2;
function liveDetect() {
  const v = $('video'); if (!v.videoWidth || current() !== 'cam' || document.hidden || shooting || locked) return;
  let det = null; try { det = IMG.detectQuad(v, { size: 240 }); } catch (e) {}
  const vw = v.videoWidth, vh = v.videoHeight, diag = Math.hypot(vw, vh);
  const quad = det && det.borders < 2 ? det.quad : null;
  const full = det && det.borders === 0 && quadArea(det.quad) > 0.2 * vw * vh ? det.quad : null;   // automatic capture wants all four edges
  let hint = '', ready = 0;
  if (settings.auto) {
    if (autoHold) {                               // just captured: wait until this page has left before arming again
      if (!full || quadDist(full, autoHold) > 0.06 * diag) { if (++holdMiss >= 3) autoHold = null; } else holdMiss = 0;
      stableN = 0; hint = settings.batch ? 'Captured · next page' : '';
    } else if (!full) { stableN = 0; hint = 'Looking for a document'; }
    else {
      stableN = lastQuad && quadDist(full, lastQuad) < 0.02 * diag ? stableN + 1 : 0;
      hint = 'Hold still'; ready = Math.min(1, stableN / 4);
      if (stableN >= 4) { stableN = 0; shoot(); }
    }
    lastQuad = full;
  }
  drawOverlay(quad, vw, vh, ready); setHint(hint);
}
function drawOverlay(quad, vw, vh, ready) {
  const ov = $('camOverlay'), box = ov.getBoundingClientRect();
  const W = Math.round(box.width), H = Math.round(box.height); if (!W || !H) return;
  if (ov.width !== W || ov.height !== H) { ov.width = W; ov.height = H; }
  const cx = ov.getContext('2d'); cx.clearRect(0, 0, W, H);
  if (!quad) return;
  const s = Math.min(W / vw, H / vh), ox = (W - vw * s) / 2, oy = (H - vh * s) / 2;
  cx.beginPath(); quad.forEach((p, i) => cx[i ? 'lineTo' : 'moveTo'](ox + p[0] * s, oy + p[1] * s)); cx.closePath();
  cx.fillStyle = 'rgba(45,212,191,' + (0.16 + 0.3 * (ready || 0)).toFixed(2) + ')'; cx.fill(); cx.lineWidth = 3; cx.strokeStyle = '#2dd4bf'; cx.stroke();
}
async function takePhotoBlob() {
  if (imageCapture) { try { return await imageCapture.takePhoto(); } catch (e) {} }     // full sensor resolution where the browser offers it
  const v = $('video'), c = IMG.makeCanvas(v.videoWidth, v.videoHeight); c.getContext('2d').drawImage(v, 0, 0);
  return IMG.toBlob(c, 'image/jpeg', 0.92);
}
async function shoot() {
  if (shooting || !stream) return; shooting = true;
  autoHold = lastQuad; holdMiss = 0; stableN = 0;
  const fx = $('flashFx'); fx.classList.remove('on'); void fx.offsetWidth; fx.classList.add('on');
  let thumb = null; try { thumb = IMG.drawCapped($('video'), 120).toDataURL('image/jpeg', 0.7); } catch (e) {}
  let blob = null; try { blob = await takePhotoBlob(); } catch (e) {}
  shooting = false;
  if (current() !== 'cam') return;
  if (!blob) { toast('Could not take the photo.'); return; }
  addCapture(blob, thumb, false);
}
// A capture becomes a placeholder page at once; the worker fills it in.
function addCapture(blob, thumb, stay) {
  if (!camDoc) camDoc = newDoc();
  const d = camDoc, pageId = uid();
  d.pages.push({ id: pageId, status: 'processing' }); camCount++;
  save({ sync: false });
  queue(() => processNew(d, pageId, blob));
  if (thumb) { $('doneThumb').src = thumb; $('doneThumb').hidden = false; }
  updateCamUI();
  if (!stay && !settings.batch) finishCamera();
}
function finishCamera() {
  const d = camDoc;
  if (camFromDoc || !d) { back(); return; }
  stopCamera(); openDoc(d, { replace: true, fresh: true });      // straight to the pages, cursor in the name
}
function dropEmptyDoc(d) {
  const i = docs.indexOf(d); if (i >= 0) docs.splice(i, 1); delete snap[d.id];
  if (curDoc === d && current() === 'doc') back();
}
async function processNew(d, pageId, blob) {
  let r;
  try { r = await task({ cmd: 'process', blob, filter: settings.filter, keepOrig: true, maxOrig: 2800, maxOut: 2400 }); }
  catch (e) {
    const i = d.pages.findIndex(x => x.id === pageId); if (i >= 0) d.pages.splice(i, 1);
    if (!d.pages.length && !d.rev) dropEmptyDoc(d);
    save({ sync: false }); renderAll(); throw e;
  }
  const p = d.pages.find(x => x.id === pageId);
  if (!p || d.deleted) return;                                  // removed while it was processing
  await pagePut(pageId, d.id, { jpeg: r.jpeg, prev: r.prev, orig: r.orig, meta: { quad: r.quad, w: r.w, h: r.h, origW: r.origW, origH: r.origH, filter: settings.filter, rot: 0, thumb: r.thumb } });
  Object.assign(p, { w: r.w, h: r.h, size: r.jpeg.size, o: 1 }); delete p.status;
  touchContent(d); save(); renderAll();
}
function pickPhotos() { holdReloadUntil = Date.now() + 600000; $('importInput').click(); }   // the picker hides the app; do not restart it on return
$('shutter').addEventListener('click', shoot);
$('camClose').addEventListener('click', () => { if (camCount && !camFromDoc) finishCamera(); else back(); });
$('done').addEventListener('click', finishCamera);
$('modeSingle').addEventListener('click', () => { settings.batch = false; saveSettings(); updateCamUI(); });
$('modeBatch').addEventListener('click', () => { settings.batch = true; saveSettings(); updateCamUI(); });
$('autoBtn').addEventListener('click', () => { settings.auto = !settings.auto; saveSettings(); stableN = 0; autoHold = null; updateCamUI(); });
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
  if (!files.length || current() !== 'cam') return;
  for (const f of files) addCapture(f, null, true);
  finishCamera();
});
