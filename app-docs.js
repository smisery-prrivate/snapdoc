'use strict';
/* Snapdoc: the document list, the document view (all pages one below the other), PDF and sharing,
   and the page editor (corners, look, rotation). */

// ---------- home ----------
function cloudGlyph(d) {
  if (!SYNC || !session || !Vault.hasCloudKey(session.uid)) return '';
  if (d.rev_have < d.rev) return '<span class="cloud busy" title="Downloading">☁↓</span>';
  if (d.pushed_rev < d.rev || d.updated_at !== d.srv) return '<span class="cloud busy" title="Waiting to upload">☁↑</span>';
  return '<span class="cloud ok" title="In the cloud, encrypted">☁✓</span>';
}
function renderHome() {
  const list = $('list'), items = alive(), st = list.scrollTop;
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = '<div class="empty"><b>No scans yet</b>Tap the big button and point the camera at a document. Batch mode puts several pages into one PDF.</div>';
    return;
  }
  for (const d of items) {
    const el = document.createElement('div'); el.className = 'card';
    const n = d.pages.length || d.pageCount || 0;
    el.innerHTML = '<div class="th"></div><div class="body"><div class="name">' + esc(d.name.trim() || dateStamp(d.created_at)) + '</div><div class="meta">' + esc(fmtDate(d.created_at)) + ' · ' + n + (n === 1 ? ' page' : ' pages') + (d.size ? ' · ' + fmtSize(d.size) : '') + '</div></div>' + cloudGlyph(d);
    thumbGet(d.id).then(t => { if (!t || !el.isConnected) return; const img = new Image(); img.className = 'th'; img.alt = ''; img.src = t; el.replaceChild(img, el.firstChild); });
    el.addEventListener('click', () => openDoc(d));
    list.appendChild(el);
  }
  list.scrollTop = st;
}
$('scanBtn').addEventListener('click', () => openCamera(null));
$('menuBtn').addEventListener('click', () => openSheet());

// ---------- document view ----------
let selPage = null; const pageUrls = new Map();
function openDoc(d, opts) {
  opts = opts || {}; curDoc = d; selPage = null;
  if (opts.replace) replaceTop('doc'); else push('doc');
  $('pages').scrollTop = 0; renderDoc();
  if (opts.fresh) setTimeout(focusName, 120);
  if (d.rev_have < d.rev) syncNow();
}
function focusName() {            // cursor right behind "YYYY-MM-DD " so the name can be typed straight away
  const inp = $('docName'); inp.focus();
  try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e) {}
}
function dropPageUrls() { for (const u of pageUrls.values()) URL.revokeObjectURL(u); pageUrls.clear(); }
function leaveDoc() { commitName(); dropPageUrls(); curDoc = null; selPage = null; }
function commitName() {
  if (!curDoc) return;
  const v = $('docName').value;
  if (v !== curDoc.name) { curDoc.name = v; save(); renderHome(); }
}
$('docName').addEventListener('change', commitName);
$('docName').addEventListener('blur', commitName);
$('docName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
$('docBack').addEventListener('click', back);
function docMetaLine(d) {
  const n = d.pages.length || d.pageCount || 0;
  let s = fmtDate(d.created_at) + ' · ' + n + (n === 1 ? ' page' : ' pages') + (d.size ? ' · ' + fmtSize(d.size) : '');
  if (SYNC && session && Vault.hasCloudKey(session.uid)) s += d.rev_have < d.rev ? ' · downloading' : d.pushed_rev < d.rev ? ' · not uploaded yet' : ' · in the cloud';
  return s;
}
function renderDoc() {
  const d = curDoc; if (!d) return;
  const inp = $('docName'); if (document.activeElement !== inp) inp.value = d.name;
  $('docMeta').textContent = docMetaLine(d);
  $('shareBtn').disabled = !d.pages.some(p => !p.status);
  const list = $('pages'), st = list.scrollTop; list.innerHTML = '';
  if (!d.pages.length) {
    list.innerHTML = '<div class="empty">' + (d.rev_have < d.rev ? '<div class="spin" style="margin:0 auto 12px"></div>Downloading this document from the cloud…' : '<b>No pages</b>Add pages with the camera.') + '</div>';
    return;
  }
  d.pages.forEach((p, i) => {
    const el = document.createElement('div'); el.className = 'page' + (selPage === p.id ? ' sel' : '');
    const ratio = p.w && p.h ? ' style="aspect-ratio:' + (+p.w) + '/' + (+p.h) + '"' : '';
    el.innerHTML = (p.status ? '<div class="pimg wait"><div class="spin"></div>Processing…</div>' : '<div class="pimg"' + ratio + '><img alt="Page ' + (i + 1) + '" decoding="async"></div>') +
      '<div class="pcap">Page ' + (i + 1) + ' of ' + d.pages.length + '</div>' +
      '<div class="ptools"><button data-a="up"' + (i === 0 ? ' disabled' : '') + '>↑</button><button data-a="down"' + (i === d.pages.length - 1 ? ' disabled' : '') + '>↓</button><button data-a="rot">Rotate</button><button data-a="edit">Crop</button><button data-a="del" class="del">Delete</button></div>';
    const img = el.querySelector('img'); if (img) loadPrev(p.id, img);
    el.querySelector('.pimg').addEventListener('click', () => { if (p.status) return; selPage = selPage === p.id ? null : p.id; renderDoc(); });
    el.querySelectorAll('.ptools button').forEach(b => b.addEventListener('click', () => pageAction(b.dataset.a, p)));
    list.appendChild(el);
  });
  list.scrollTop = st;
}
async function loadPrev(id, img) {
  let u = pageUrls.get(id);
  if (!u) {
    let rec = null; try { rec = await pageGet(id, ['prev']); } catch (e) {}
    if (!rec || !rec.prev) return;
    u = pageUrls.get(id); if (!u) { u = URL.createObjectURL(rec.prev); pageUrls.set(id, u); }
  }
  img.src = u;
}
function dropPrev(id) { const u = pageUrls.get(id); if (u) { URL.revokeObjectURL(u); pageUrls.delete(id); } }
async function pageAction(a, p) {
  const d = curDoc; if (!d) return; const i = d.pages.indexOf(p); if (i < 0) return;
  if (a === 'up' && i > 0) { d.pages.splice(i, 1); d.pages.splice(i - 1, 0, p); touchContent(d); save(); renderDoc(); }
  else if (a === 'down' && i < d.pages.length - 1) { d.pages.splice(i, 1); d.pages.splice(i + 1, 0, p); touchContent(d); save(); renderDoc(); }
  else if (a === 'rot') {
    busy(true);
    try {
      const rec = await pageGet(p.id, ['orig']); if (!rec) throw new Error('page data is missing');
      let r, meta;
      if (rec.orig) {             // re-render from the original photo: no quality loss however often it is turned
        const rot = ((rec.rot || 0) + 90) % 360;
        r = await task({ cmd: 'process', blob: rec.orig, quad: rec.quad, filter: rec.filter || 'color', rot, keepOrig: false, maxOrig: 2800, maxOut: 2400 });
        meta = { w: r.w, h: r.h, rot, thumb: r.thumb };
      } else {
        const j = await pageGet(p.id, ['jpeg']);
        r = await task({ cmd: 'rotate', blob: j.jpeg, deg: 90 }); meta = { w: r.w, h: r.h, thumb: r.thumb };
      }
      await pagePut(p.id, d.id, { jpeg: r.jpeg, prev: r.prev, meta });
      Object.assign(p, { w: r.w, h: r.h, size: r.jpeg.size }); dropPrev(p.id);
      touchContent(d); save(); renderDoc();
    } catch (e) { toast('Rotate failed: ' + (e.message || e)); } finally { busy(false); }
  }
  else if (a === 'edit') openEdit(p);
  else if (a === 'del') {
    d.pages.splice(i, 1); selPage = null; touchContent(d); save(); renderDoc(); renderHome();
    let undone = false;
    toast('Page removed', { label: 'Undo',
      fn: () => { undone = true; if (d.deleted) return; d.pages.splice(Math.min(i, d.pages.length), 0, p); touchContent(d); save(); renderAll(); },
      expire: () => { if (!undone) { idb.del('pages', p.id).catch(() => {}); dropPrev(p.id); } } });
  }
}
$('addBtn').addEventListener('click', () => { if (curDoc) openCamera(curDoc); });
$('docMore').addEventListener('click', () => {
  const d = curDoc; if (!d) return;
  popup(d.name.trim() || 'Document', '', [
    { label: 'Save PDF to this device', fn: () => savePdfLocal(d) },
    { label: 'Rename', fn: focusName },
    { label: 'Delete document', cls: 'danger', fn: () => popup('Delete this document?', 'All ' + d.pages.length + ' pages and the PDF are removed' + (SYNC && session ? ' here and in the cloud' : '') + '.', [
      { label: 'Delete', cls: 'danger', fn: async () => { d.deleted = true; await purgeDocData(d); save(); if (current() === 'doc') back(); renderAll(); toast('Document deleted'); } },
      { label: 'Keep', cls: 'quiet' }]) },
    { label: 'Cancel', cls: 'quiet' }
  ]);
});

// ---------- PDF ----------
async function waitForPages() { while (qLen > 0) await q; }
async function getPdf(d) {
  await waitForPages();
  const sig = d.rev + '|' + settings.pageSize + '|' + (d.name || '').trim();
  const c = await pdfGet(d.id).catch(() => null);
  if (c && c.sig === sig) return c.blob;
  const pages = [];
  for (const p of d.pages) { if (p.status) continue; const rec = await pageGet(p.id, ['jpeg']); if (rec && rec.jpeg) pages.push({ blob: rec.jpeg, w: rec.w, h: rec.h }); }
  if (!pages.length) throw new Error('no pages');
  const r = await task({ cmd: 'pdf', pages, title: (d.name || '').trim() || dateStamp(d.created_at), pageSize: settings.pageSize });
  await pdfPut(d.id, sig, r.pdf);
  return r.pdf;
}
const pdfTimers = new Map();
function schedulePdf(d) {            // built ahead so Share opens at once and the upload has its file
  clearTimeout(pdfTimers.get(d.id));
  pdfTimers.set(d.id, setTimeout(() => {
    pdfTimers.delete(d.id);
    const cur = byId(d.id); if (!cur || cur.deleted || !cur.pages.length || cur.rev_have !== cur.rev || !Vault.isOpen()) return;
    getPdf(cur).then(scheduleSync).catch(() => {});
  }, 1500));
}
function downloadBlob(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
async function savePdfLocal(d) {
  try { downloadBlob(await getPdf(d), fileName(d)); toast('Saved: ' + fileName(d)); } catch (e) { toast('Could not build the PDF: ' + (e.message || e)); }
}
async function sharePdf(d) {
  if (!d.pages.some(p => !p.status)) { toast('No pages yet.'); return; }
  let blob; busy(true);
  try { blob = await getPdf(d); } catch (e) { toast('Could not build the PDF: ' + (e.message || e)); return; } finally { busy(false); }
  const file = new File([blob], fileName(d), { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { holdReloadUntil = Date.now() + 600000; await navigator.share({ files: [file], title: d.name.trim() || fileName(d) }); return; }
    catch (e) {
      if (e && e.name === 'AbortError') return;
      if (e && e.name === 'NotAllowedError') {      // building took longer than the tap stays valid: one more tap shares at once
        popup('Your PDF is ready', fileName(d), [{ label: 'Share', cls: 'primary', fn: () => sharePdf(d) }, { label: 'Save to this device', fn: () => savePdfLocal(d) }, { label: 'Cancel', cls: 'quiet' }]);
        return;
      }
    }
  }
  downloadBlob(blob, fileName(d)); toast('Saved: ' + fileName(d));
}
$('shareBtn').addEventListener('click', () => { if (curDoc) { commitName(); sharePdf(curDoc); } });

// ---------- page editor: corners first, then look and rotation ----------
let ed = null, dragIdx = -1;
async function openEdit(p) {
  busy(true);
  try {
    let rec = await pageGet(p.id, ['orig']); if (!rec) throw new Error('page data is missing');
    const hasOrig = !!rec.orig;
    if (!hasOrig) rec = await pageGet(p.id, ['jpeg']);
    const blob = hasOrig ? rec.orig : rec.jpeg;
    const bmp = await createImageBitmap(blob);
    const srcCanvas = IMG.drawCapped(bmp, 2800); if (bmp.close) bmp.close();
    const full = IMG.fullQuad(srcCanvas.width, srcCanvas.height);
    ed = { page: p, hasOrig, blob, srcCanvas, step: 'crop', warped: null, scale: 1,
      quad: (hasOrig && Array.isArray(rec.quad) ? rec.quad : full).map(c => c.slice()),
      filter: hasOrig ? (rec.filter || 'color') : 'photo', rot: hasOrig ? (rec.rot || 0) : 0 };
    ed.start = JSON.stringify([ed.quad, ed.filter, ed.rot]);
    push('edit'); renderEdit();
  } catch (e) { toast('Could not open the page: ' + (e.message || e)); } finally { busy(false); }
}
function editCleanup() { ed = null; dragIdx = -1; }
function renderEdit() {
  if (!ed) return;
  const crop = ed.step === 'crop';
  $('editTitle').textContent = crop ? 'Adjust corners' : 'Look';
  $('editAuto').hidden = !crop; $('cropCanvas').hidden = !crop; $('filterCanvas').hidden = crop;
  $('editBack').hidden = crop; $('editRotL').hidden = crop; $('editRotR').hidden = crop;
  $('editNext').textContent = crop ? 'Next' : 'Done';
  const chips = $('editChips'); chips.innerHTML = '';
  const chip = (label, on, fn) => { const b = document.createElement('button'); b.textContent = label; if (on) b.className = 'on'; b.addEventListener('click', fn); chips.appendChild(b); };
  if (crop) {
    chip('Find edges', false, () => { autoCorners(); drawCrop(); });
    chip('Whole photo', false, () => { ed.quad = IMG.fullQuad(ed.srcCanvas.width, ed.srcCanvas.height); drawCrop(); });
    requestAnimationFrame(drawCrop);
  } else {
    for (const [k, l] of [['color', 'Color'], ['gray', 'Gray'], ['bw', 'Black & white'], ['photo', 'Photo']]) chip(l, ed.filter === k, () => { ed.filter = k; renderEdit(); });
    requestAnimationFrame(drawFilter);
  }
}
function autoCorners() { const det = IMG.detectQuad(ed.srcCanvas); ed.quad = det ? IMG.insetQuad(det.quad, 0.012) : IMG.fullQuad(ed.srcCanvas.width, ed.srcCanvas.height); }
function fitCanvas(cv, iw, ih) {
  const stage = cv.parentElement.getBoundingClientRect();
  const s = Math.min((stage.width - 28) / iw, (stage.height - 28) / ih);
  cv.width = Math.max(1, Math.round(iw * s)); cv.height = Math.max(1, Math.round(ih * s));
  cv.style.width = cv.width + 'px'; cv.style.height = cv.height + 'px';
  return s;
}
function drawCrop() {
  if (!ed || ed.step !== 'crop') return;
  const cv = $('cropCanvas'), src = ed.srcCanvas, s = ed.scale = fitCanvas(cv, src.width, src.height);
  const cx = cv.getContext('2d'); cx.clearRect(0, 0, cv.width, cv.height); cx.drawImage(src, 0, 0, cv.width, cv.height);
  const qd = ed.quad;
  cx.save(); cx.fillStyle = 'rgba(0,0,0,.45)'; cx.beginPath(); cx.rect(0, 0, cv.width, cv.height);
  cx.moveTo(qd[0][0] * s, qd[0][1] * s); for (let i = 3; i >= 1; i--) cx.lineTo(qd[i][0] * s, qd[i][1] * s); cx.closePath(); cx.fill('evenodd'); cx.restore();
  cx.beginPath(); qd.forEach((p, i) => cx[i ? 'lineTo' : 'moveTo'](p[0] * s, p[1] * s)); cx.closePath(); cx.lineWidth = 2; cx.strokeStyle = '#2dd4bf'; cx.stroke();
  qd.forEach((p, i) => { cx.beginPath(); cx.arc(p[0] * s, p[1] * s, i === dragIdx ? 16 : 12, 0, Math.PI * 2); cx.fillStyle = i === dragIdx ? '#2dd4bf' : 'rgba(255,255,255,.92)'; cx.fill(); cx.lineWidth = 2; cx.strokeStyle = '#0f766e'; cx.stroke(); });
  if (dragIdx >= 0) {             // magnifier, away from the finger
    const p = qd[dragIdx], R = 58, Z = 2.5, lx = p[0] * s < cv.width / 2 ? cv.width - R - 8 : R + 8, ly = p[1] * s < cv.height / 2 ? cv.height - R - 8 : R + 8, half = R / Z / s;
    cx.save(); cx.beginPath(); cx.arc(lx, ly, R, 0, Math.PI * 2); cx.clip(); cx.fillStyle = '#000'; cx.fillRect(lx - R, ly - R, 2 * R, 2 * R);
    cx.drawImage(src, p[0] - half, p[1] - half, 2 * half, 2 * half, lx - R, ly - R, 2 * R, 2 * R);
    cx.strokeStyle = '#2dd4bf'; cx.lineWidth = 1.5; cx.beginPath(); cx.moveTo(lx - R, ly); cx.lineTo(lx + R, ly); cx.moveTo(lx, ly - R); cx.lineTo(lx, ly + R); cx.stroke();
    cx.restore(); cx.beginPath(); cx.arc(lx, ly, R, 0, Math.PI * 2); cx.lineWidth = 3; cx.strokeStyle = '#fff'; cx.stroke();
  }
}
function cropPoint(e) { const r = $('cropCanvas').getBoundingClientRect(); return [(e.clientX - r.left) / ed.scale, (e.clientY - r.top) / ed.scale]; }
$('cropCanvas').addEventListener('pointerdown', e => {
  if (!ed || ed.step !== 'crop') return;
  const [x, y] = cropPoint(e); let best = -1, bd = 48 / ed.scale;
  ed.quad.forEach((c, i) => { const dist = Math.hypot(c[0] - x, c[1] - y); if (dist < bd) { bd = dist; best = i; } });
  if (best < 0) return;
  dragIdx = best; e.preventDefault(); try { $('cropCanvas').setPointerCapture(e.pointerId); } catch (err) {} drawCrop();
});
$('cropCanvas').addEventListener('pointermove', e => {
  if (dragIdx < 0 || !ed) return; e.preventDefault();
  const [x, y] = cropPoint(e), W = ed.srcCanvas.width, H = ed.srcCanvas.height;
  ed.quad[dragIdx] = [Math.min(W, Math.max(0, x)), Math.min(H, Math.max(0, y))]; drawCrop();
});
const endDrag = () => { if (dragIdx >= 0) { dragIdx = -1; drawCrop(); } };
$('cropCanvas').addEventListener('pointerup', endDrag);
$('cropCanvas').addEventListener('pointercancel', endDrag);
window.addEventListener('resize', () => { if (ed) { if (ed.step === 'crop') drawCrop(); else drawFilter(); } });
function drawFilter() {
  if (!ed || ed.step !== 'filter') return;
  if (!ed.warped) ed.warped = IMG.warp(ed.srcCanvas, ed.quad, { maxSide: 800 });
  let c = IMG.makeCanvas(ed.warped.width, ed.warped.height); c.getContext('2d', { willReadFrequently: true }).drawImage(ed.warped, 0, 0);
  c = IMG.rotate(IMG.enhance(c, ed.filter), ed.rot);
  const cv = $('filterCanvas'); fitCanvas(cv, c.width, c.height);
  cv.getContext('2d').drawImage(c, 0, 0, cv.width, cv.height);
}
$('editCancel').addEventListener('click', back);
$('editAuto').addEventListener('click', () => { if (ed) { autoCorners(); drawCrop(); } });
$('editBack').addEventListener('click', () => { if (ed) { ed.step = 'crop'; ed.warped = null; renderEdit(); } });
$('editRotL').addEventListener('click', () => { if (ed) { ed.rot = (ed.rot + 270) % 360; drawFilter(); } });
$('editRotR').addEventListener('click', () => { if (ed) { ed.rot = (ed.rot + 90) % 360; drawFilter(); } });
$('editNext').addEventListener('click', async () => {
  if (!ed) return;
  if (ed.step === 'crop') { ed.step = 'filter'; ed.warped = null; renderEdit(); return; }
  const e0 = ed, d = curDoc;
  if (!d || JSON.stringify([e0.quad, e0.filter, e0.rot]) === e0.start) { back(); return; }
  busy(true); $('editNext').disabled = true;
  try {
    const r = await task({ cmd: 'process', blob: e0.blob, quad: e0.quad, filter: e0.filter, rot: e0.rot, keepOrig: false, maxOrig: 2800, maxOut: 2400 });
    const meta = { w: r.w, h: r.h, thumb: r.thumb };
    if (e0.hasOrig) Object.assign(meta, { quad: e0.quad, filter: e0.filter, rot: e0.rot });
    await pagePut(e0.page.id, d.id, { jpeg: r.jpeg, prev: r.prev, meta });
    Object.assign(e0.page, { w: r.w, h: r.h, size: r.jpeg.size }); dropPrev(e0.page.id);
    touchContent(d); save(); back();
  } catch (e) { toast('Could not apply: ' + (e.message || e)); } finally { busy(false); $('editNext').disabled = false; }
});
