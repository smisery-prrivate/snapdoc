'use strict';
/* Snapdoc core: helpers, settings, encrypted storage, the document model, the processing
   queue, screens and the back button. The app is several plain script files that share one
   scope (no build step); index.html loads them in order. */
const VERSION = 'v2';
const $ = id => document.getElementById(id);
const IMG = self.SnapdocImaging;
const CFG = self.APP_CONFIG || {};
const SYNC = CFG.supabaseUrl && CFG.supabaseKey ? { url: String(CFG.supabaseUrl).replace(/\/$/, ''), key: CFG.supabaseKey } : null;
const SET_KEY = 'snapdoc.settings', TICK_KEY = 'snapdoc.tick', RESUME_KEY = 'snapdoc.resume';
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const dateStamp = t => { const d = t ? new Date(t) : new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const fmtSize = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
const fmtDate = t => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const utf8 = s => new TextEncoder().encode(s);
// thumbnails are only ever accepted as a plain base64 image
const safeThumb = t => typeof t === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(t) ? t : '';

// ---------- settings (not sensitive, plain) ----------
let settings = { filter: 'color', pageSize: 'A4', lockAfter: 60, batch: false, auto: true };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SET_KEY) || '{}')); } catch (e) {}
const saveSettings = () => { try { localStorage.setItem(SET_KEY, JSON.stringify(settings)); } catch (e) {} };

// ---------- IndexedDB ----------
const idb = (() => {
  const STORES = ['pages', 'pdfs', 'meta', 'thumbs'];
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('snapdoc', 1);
    r.onupgradeneeded = () => { const d = r.result; for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (store, mode, fn) => { const d = await open(); return new Promise((res, rej) => { const t = d.transaction(store, mode); const rq = fn(t.objectStore(store)); t.oncomplete = () => res(rq && rq.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); };
  return {
    get: (s, k) => tx(s, 'readonly', o => o.get(k)), put: (s, v) => tx(s, 'readwrite', o => o.put(v)), del: (s, k) => tx(s, 'readwrite', o => o.delete(k)),
    async wipe() { for (const s of STORES) await tx(s, 'readwrite', o => o.clear()).catch(() => {}); }
  };
})();
const metaStore = { get: id => idb.get('meta', id), put: rec => idb.put('meta', rec), del: id => idb.del('meta', id) };

// ---------- encrypted records: nothing readable is written to the device ----------
const pLabel = (id, part) => 'sd|p|' + id + '|' + part;
// fields: jpeg / prev / orig (Blob or null) and meta (small object, merged into what is there)
async function pagePut(id, docId, fields) {
  const rec = (await idb.get('pages', id)) || { id, doc: docId };
  for (const k of ['jpeg', 'prev', 'orig']) if (k in fields) rec[k] = fields[k] ? await Vault.sealBlob(fields[k], pLabel(id, k)) : null;
  if (fields.meta) {
    const cur = rec.m ? await Vault.openJson(rec.m, pLabel(id, 'm')) : {};
    rec.m = await Vault.sealJson(Object.assign(cur, fields.meta), pLabel(id, 'm'));
  }
  await idb.put('pages', rec);
}
// want: which blobs to decrypt, e.g. ['prev']; the small meta object always comes along
async function pageGet(id, want) {
  const rec = await idb.get('pages', id); if (!rec) return null;
  const out = rec.m ? await Vault.openJson(rec.m, pLabel(id, 'm')) : {};
  out.hasOrig = !!rec.orig;
  for (const k of want || []) out[k] = rec[k] ? await Vault.openBlob(rec[k], pLabel(id, k), 'image/jpeg') : null;
  return out;
}
async function pdfPut(id, sig, blob) { await idb.put('pdfs', { id, s: await Vault.seal(utf8(sig), 'sd|pdf|' + id + '|s'), data: await Vault.sealBlob(blob, 'sd|pdf|' + id) }); }
async function pdfGet(id) {
  const r = await idb.get('pdfs', id); if (!r) return null;
  return { sig: new TextDecoder().decode(await Vault.open(r.s, 'sd|pdf|' + id + '|s')), blob: await Vault.openBlob(r.data, 'sd|pdf|' + id, 'application/pdf') };
}
const thumbCache = new Map();
async function thumbPut(id, t) {
  t = safeThumb(t); thumbCache.set(id, t);
  if (t) await idb.put('thumbs', { id, t: await Vault.seal(utf8(t), 'sd|t|' + id) }); else await idb.del('thumbs', id);
}
async function thumbGet(id) {
  if (thumbCache.has(id)) return thumbCache.get(id);
  let t = '';
  try { const r = await idb.get('thumbs', id); if (r) t = safeThumb(new TextDecoder().decode(await Vault.open(r.t, 'sd|t|' + id))); } catch (e) {}
  thumbCache.set(id, t); return t;
}

// ---------- documents: one encrypted list; page images live in their own records ----------
let docs = [], snap = {}, foreignDirty = false;
let curDoc = null, camDoc = null;
const sigOf = d => JSON.stringify([d.name, !!d.deleted, d.rev || 0]);
function migrate(d) {
  d.pages = Array.isArray(d.pages) ? d.pages : []; d.rev = d.rev || 0; d.rev_have = d.rev_have == null ? d.rev : d.rev_have; d.pushed_rev = d.pushed_rev || 0;
  d.created_at = d.created_at || Date.now(); d.updated_at = d.updated_at || d.created_at; d.srv = d.srv || 0; d.size = d.size || 0; d.name = d.name == null ? '' : String(d.name);
  return d;
}
const isBusy = d => d === curDoc || d === camDoc || d.pages.some(p => p.status);
async function loadDocs() {
  const r = await idb.get('meta', 'docs'); let arr = [];
  if (r) arr = await Vault.openJson(r.data, 'sd|docs');
  docs = Array.isArray(arr) ? arr.map(migrate) : []; snap = {};
  for (const d of docs) snap[d.id] = sigOf(d);
}
async function mergeStored() {           // another tab wrote meanwhile: adopt what is newer there
  let stored; try { const r = await idb.get('meta', 'docs'); if (!r) return; stored = await Vault.openJson(r.data, 'sd|docs'); } catch (e) { return; }
  if (!Array.isArray(stored)) return;
  for (const s of stored) {
    migrate(s); const d = docs.find(x => x.id === s.id);
    if (!d) { docs.push(s); snap[s.id] = sigOf(s); }
    else if (s.updated_at > d.updated_at && !isBusy(d)) { Object.assign(d, s); snap[s.id] = sigOf(s); }   // in place: running tasks keep their reference
  }
}
let persistChain = Promise.resolve(), persistQueued = false;
function persist() {
  if (persistQueued) return persistChain;
  persistQueued = true;
  persistChain = persistChain.then(async () => {
    persistQueued = false;
    if (foreignDirty) { foreignDirty = false; await mergeStored(); }
    await idb.put('meta', { id: 'docs', data: await Vault.sealJson(docs, 'sd|docs') });
    try { localStorage.setItem(TICK_KEY, Date.now() + '.' + Math.random()); } catch (e) {}
  }).catch(e => { persistQueued = false; toast('Saving failed: ' + (e.message || e)); });
  return persistChain;
}
function save(opts) {
  const now = Date.now();
  for (const d of docs) { const s = sigOf(d); if (snap[d.id] !== s) { d.updated_at = Math.max(now, d.updated_at + 1); snap[d.id] = s; } }
  docs = docs.filter(d => !(d.deleted && now - d.updated_at > 60 * 864e5));
  persist();
  if (!opts || opts.sync !== false) scheduleSync();
}
const alive = () => docs.filter(d => !d.deleted).sort((a, b) => b.created_at - a.created_at);
const byId = id => docs.find(d => d.id === id);
function newDoc() {
  const now = Date.now();
  const d = migrate({ id: uid(), name: dateStamp(now) + ' ', created_at: now, updated_at: now, pages: [], rev: 0, rev_have: 0, pushed_rev: 0, srv: 0, size: 0, deleted: false });
  docs.unshift(d); snap[d.id] = sigOf(d);
  return d;
}
function touchContent(d) {               // the pages changed: new revision, new thumbnail, PDF rebuilt in the background
  d.rev = Math.max(Date.now(), d.rev + 1); d.rev_have = d.rev;
  d.size = d.pages.reduce((a, p) => a + (p.size || 0), 0);
  refreshThumb(d); schedulePdf(d);
}
async function refreshThumb(d) {
  const p = d.pages.find(x => !x.status); let t = '';
  if (p) { try { const rec = await pageGet(p.id); t = rec ? rec.thumb : ''; } catch (e) {} }
  if (thumbCache.get(d.id) === t) return;
  await thumbPut(d.id, t).catch(() => {});
  renderHome();
}
const fileName = d => ((d.name || '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-') || dateStamp(d.created_at)) + '.pdf';
async function purgeDocData(d) {
  for (const p of d.pages) await idb.del('pages', p.id).catch(() => {});
  await idb.del('pdfs', d.id).catch(() => {}); await idb.del('thumbs', d.id).catch(() => {});
  thumbCache.delete(d.id); d.pages = [];
}

// ---------- worker: processing off the main thread, inline fallback ----------
let worker = null, seq = 0; const pending = new Map();
function startWorker() {
  if (!self.Worker || !self.OffscreenCanvas) return;
  try {
    worker = new Worker('worker.js');
    worker.onmessage = e => { const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id); e.data.ok ? p.res(e.data) : p.rej(new Error(e.data.error)); };
    worker.onerror = () => { for (const p of pending.values()) p.rej(new Error('worker failed')); pending.clear(); worker = null; };
  } catch (e) { worker = null; }
}
function task(msg) {
  if (!worker) return IMG.tasks[msg.cmd](msg);
  return new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); worker.postMessage(Object.assign({ id }, msg)); });
}
let q = Promise.resolve(), qLen = 0, busyN = 0;
function queue(fn) { qLen++; busy(true); q = q.then(fn).catch(e => toast('Processing failed: ' + (e.message || e))).then(() => { qLen--; busy(false); }); return q; }
function busy(on) { busyN = Math.max(0, busyN + (on ? 1 : -1)); $('busy').classList.toggle('on', busyN > 0); }

// ---------- screens and the back button ----------
const BASE = ['home', 'doc', 'edit', 'cam'];
const stack = ['home'];
let popupState = null;
function applyStack() {
  const base = current();
  for (const s of BASE) $(s).hidden = s !== base;
  $('sheet').classList.toggle('open', stack.includes('sheet'));
  $('popup').classList.toggle('open', stack.includes('popup'));
}
function current() { return stack.slice().reverse().find(s => BASE.includes(s)) || 'home'; }
function push(name) { stack.push(name); history.pushState({ n: stack.length }, ''); applyStack(); }
function replaceTop(name) { leave(stack.pop()); stack.push(name); history.replaceState({ n: stack.length }, ''); applyStack(); }
function back() { if (stack.length > 1) history.back(); }
function leave(name) {
  if (name === 'cam') stopCamera();
  if (name === 'edit') editCleanup();
  if (name === 'doc') leaveDoc();
  if (name === 'sheet') sheetClosed();
  if (name === 'popup') { const p = popupState; popupState = null; if (p && p.after) setTimeout(p.after, 0); }   // the chosen action runs once the popup has really closed
}
window.addEventListener('popstate', e => {
  const depth = (e.state && e.state.n) || 1;
  while (stack.length > depth && stack.length > 1) leave(stack.pop());
  applyStack(); renderAll();
});
function renderAll() { renderHome(); renderSyncLine(); if (current() === 'doc') renderDoc(); }

// ---------- popups and toasts ----------
function popup(title, text, buttons) {
  const box = $('popupBox');
  box.innerHTML = '<h3>' + esc(title) + '</h3>' + (text ? '<p>' + esc(text) + '</p>' : '');
  for (const b of buttons) {
    const el = document.createElement('button'); el.textContent = b.label; el.className = b.cls || '';
    el.addEventListener('click', () => { if (popupState) popupState.after = b.fn || null; back(); });
    box.appendChild(el);
  }
  popupState = { after: null }; push('popup');
}
$('popup').addEventListener('click', e => { if (e.target === $('popup')) back(); });
let toastTimer = null, toastAction = null;
function toast(msg, action) {
  const t = $('toast'); clearTimeout(toastTimer);
  if (toastAction && toastAction.expire) toastAction.expire();
  toastAction = action || null;
  t.innerHTML = ''; t.appendChild(document.createTextNode(msg));
  if (action) { const b = document.createElement('button'); b.textContent = action.label; b.addEventListener('click', () => { t.classList.remove('show'); clearTimeout(toastTimer); toastAction = null; action.fn(); }); t.appendChild(b); }
  t.classList.add('show');
  toastTimer = setTimeout(() => { t.classList.remove('show'); if (toastAction && toastAction.expire) toastAction.expire(); toastAction = null; }, action ? 6000 : 2800);
}
