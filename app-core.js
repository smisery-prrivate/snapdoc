'use strict';
/* Snapdoc core: helpers, settings, encrypted storage, the document model, the processing
   queue, screens and the back button. The app is several plain script files that share one
   scope (no build step); index.html loads them in order. */
const VERSION = 'v9';
const $ = id => document.getElementById(id);
const IMG = self.SnapdocImaging;
const CFG = self.APP_CONFIG || {};
const SYNC = CFG.supabaseUrl && CFG.supabaseKey ? { url: String(CFG.supabaseUrl).replace(/\/$/, ''), key: CFG.supabaseKey } : null;
const SET_KEY = 'snapdoc.settings', TICK_KEY = 'snapdoc.tick', RESUME_KEY = 'snapdoc.resume', OWNER_KEY = 'snapdoc.owner';
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const dateStamp = t => { const d = t ? new Date(t) : new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const fmtSize = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
const fmtDate = t => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const utf8 = s => new TextEncoder().encode(s);
const errText = e => (e && e.message) || String(e);
// thumbnails are only ever accepted as a plain base64 image
const safeThumb = t => typeof t === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(t) ? t : '';

// ---------- one active instance ----------
// Only one tab or window writes at a time. Whoever is active puts its id into localStorage, which
// every tab reads synchronously; every write checks it first, so a tab that was replaced (or was
// frozen in the background and wakes up late) cannot write stale data over newer data.
const INSTANCE_ID = uid(), BOOT_ID = INSTANCE_ID.slice(0, 8);
let passive = false;
const isOwner = () => { try { const o = localStorage.getItem(OWNER_KEY); return !o || o === INSTANCE_ID; } catch (e) { return true; } };
function writeGuard() {
  if (!passive && isOwner()) return;
  if (!passive && typeof instanceLost === 'function') instanceLost();
  throw new Error('Snapdoc is active in another tab or window.');
}

// ---------- settings (not sensitive, plain) ----------
// The looks (Color, Gray, Black & white) are switched off: a scan is the photo as it was taken, cut
// to the page and straightened, and nothing else is done to the picture. The code of the looks
// stays in imaging.js. Setting this to true brings back "Default look" in the menu and the Look
// step when a page is edited.
const LOOKS = false;
const lookOf = f => LOOKS ? (f || 'color') : 'photo';
let settings = { filter: 'photo', pageSize: 'A4', lockAfter: 60, batch: false, auto: true };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SET_KEY) || '{}')); } catch (e) {}
if (!LOOKS) settings.filter = 'photo';              // also for an install that had a look stored from an earlier version
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
  const tx = async (store, mode, fn) => {
    if (mode === 'readwrite') writeGuard();
    const d = await open();
    return new Promise((res, rej) => { const t = d.transaction(store, mode); const rq = fn(t.objectStore(store)); t.oncomplete = () => res(rq && rq.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('storage write was aborted')); });
  };
  return {
    get: (s, k) => tx(s, 'readonly', o => o.get(k)), put: (s, v) => tx(s, 'readwrite', o => o.put(v)), del: (s, k) => tx(s, 'readwrite', o => o.delete(k)),
    keys: s => tx(s, 'readonly', o => o.getAllKeys()),
    // change a record only if it still is what the caller read: fn(current) returns the new record or nothing
    async cas(s, k, fn) {
      writeGuard(); const d = await open();
      return new Promise((res, rej) => {
        const t = d.transaction(s, 'readwrite'), o = t.objectStore(s); let did = false;
        const g = o.get(k); g.onsuccess = () => { const nv = fn(g.result); if (nv) { o.put(nv); did = true; } };
        t.oncomplete = () => res(did); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('storage write was aborted'));
      });
    },
    async wipe() { for (const s of STORES) await tx(s, 'readwrite', o => o.clear()).catch(() => {}); }
  };
})();
const metaStore = { get: id => idb.get('meta', id), put: rec => idb.put('meta', rec), del: id => idb.del('meta', id) };

// ---------- encrypted records: nothing readable is written to the device ----------
const pLabel = (id, part) => 'sd|p|' + id + '|' + part;
// fields: jpeg / prev / orig (Blob or null) and meta (small object, merged into what is there)
async function pagePut(id, docId, fields) {
  const rec = (await idb.get('pages', id)) || { id, doc: docId };
  rec.ts = Date.now();
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
// returns the cached PDF only when it was built for exactly this signature; the large file is
// decrypted only then
async function pdfGet(id, want) {
  const r = await idb.get('pdfs', id); if (!r) return null;
  const sig = new TextDecoder().decode(await Vault.open(r.s, 'sd|pdf|' + id + '|s'));
  if (sig !== want) return null;
  return { sig, blob: await Vault.openBlob(r.data, 'sd|pdf|' + id, 'application/pdf') };
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
// After the local key was renewed: bring every stored record under the new key, one at a time,
// then let go of the previous key. Safe to interrupt; it continues at the next start.
let resealing = false;
async function resealAll() {
  if (resealing || !docsLoaded || locked || passive || !Vault.isOpen() || !Vault.hasOldKeys()) return;
  resealing = true;
  try {
    const FIELDS = { pages: ['m', 'jpeg', 'prev', 'orig'], pdfs: ['s', 'data'], thumbs: ['t'] };
    const label = (store, id, f) => store === 'pages' ? pLabel(id, f) : store === 'pdfs' ? 'sd|pdf|' + id + (f === 's' ? '|s' : '') : 'sd|t|' + id;
    const same = (a, b) => { if (!a || !b || a.byteLength !== b.byteLength) return false; const x = new Uint8Array(a, 0, 12), y = new Uint8Array(b, 0, 12); return x.every((v, i) => v === y[i]); };
    let failed = 0;
    for (const store of Object.keys(FIELDS)) for (const id of await idb.keys(store)) {
      if (passive || locked || !Vault.isOpen()) return;
      try {
        const r = await idb.get(store, id); if (!r) continue;
        const upd = {};
        for (const f of FIELDS[store]) if (r[f]) { const nb = await Vault.reseal(r[f], label(store, id, f)); if (nb) upd[f] = { was: r[f], nb }; }
        if (Object.keys(upd).length) await idb.cas(store, id, cur => {           // skip fields someone changed meanwhile: those are under the new key already
          if (!cur) return; let ch = false;
          for (const f in upd) if (same(cur[f], upd[f].was)) { cur[f] = upd[f].nb; ch = true; }
          return ch ? cur : undefined;
        });
      } catch (e) { failed++; }
    }
    await persist(); if (session) await storeSession();
    await Vault.resealCloudKey();
    if (!failed && !passive) await Vault.dropOldKeys();
  } catch (e) {} finally { resealing = false; }
}

// ---------- documents: one encrypted list; page images live in their own records ----------
let docs = [], snap = {}, foreignDirty = false, docsLoaded = false;
let curDoc = null, camDoc = null;
const sigOf = d => JSON.stringify([d.name, !!d.deleted, d.rev || 0]);
function migrate(d) {
  d.pages = Array.isArray(d.pages) ? d.pages : []; d.rev = d.rev || 0; d.rev_have = d.rev_have == null ? d.rev : d.rev_have; d.pushed_rev = d.pushed_rev || 0;
  d.created_at = d.created_at || Date.now(); d.updated_at = d.updated_at || d.created_at; d.srv = d.srv || 0; d.size = d.size || 0; d.name = d.name == null ? '' : String(d.name);
  return d;
}
// placeholders count as "in use" only while this instance is really processing something
const isBusy = d => d === curDoc || d === camDoc || (qLen > 0 && d.pages.some(p => p.status));
// this device holds the newest pages of the document (false while a newer version is still downloading)
const hasContent = d => d.rev_have >= d.rev;
async function loadDocs() {
  const r = await idb.get('meta', 'docs'); let arr = [];
  if (r) arr = await Vault.openJson(r.data, 'sd|docs');
  docs = Array.isArray(arr) ? arr.map(migrate) : []; snap = {};
  for (const d of docs) snap[d.id] = sigOf(d);
  docsLoaded = true;
}
async function mergeStored() {           // another tab wrote meanwhile: adopt what is newer there
  let stored; try { const r = await idb.get('meta', 'docs'); if (!r) return; stored = await Vault.openJson(r.data, 'sd|docs'); } catch (e) { return; }
  if (!Array.isArray(stored)) return;
  for (const s of stored) {
    migrate(s); const d = docs.find(x => x.id === s.id);
    if (!d || !isBusy(d)) s.pages = s.pages.filter(p => !p.status);              // never take over someone else's unfinished captures
    if (!d) { if (s.deleted || s.pages.length || s.rev) { docs.push(s); snap[s.id] = sigOf(s); } }
    else if (s.updated_at > d.updated_at && !isBusy(d)) { Object.assign(d, s); snap[s.id] = sigOf(s); }   // in place: running tasks keep their reference
  }
}
let persistChain = Promise.resolve(), persistQueued = false;
function persist() {
  if (passive || persistQueued || !docsLoaded) return persistChain;      // never before the stored list has been read: an empty list must not replace it
  persistQueued = true;
  persistChain = persistChain.then(async () => {
    persistQueued = false;
    if (passive) return;
    if (foreignDirty) { foreignDirty = false; await mergeStored(); }
    await idb.put('meta', { id: 'docs', data: await Vault.sealJson(docs, 'sd|docs') });
    try { localStorage.setItem(TICK_KEY, Date.now() + '.' + Math.random()); } catch (e) {}
  }).catch(e => { persistQueued = false; if (!passive) toast('Saving failed: ' + errText(e)); });
  return persistChain;
}
function save(opts) {
  const now = Date.now();
  for (const d of docs) { const s = sigOf(d); if (snap[d.id] !== s) { d.updated_at = Math.max(now, d.updated_at + 1); snap[d.id] = s; } }
  docs = docs.filter(d => !(d.deleted && now - d.updated_at > 60 * 864e5));
  persist();
  if (!opts || opts.sync !== false) { scheduleSync(); scheduleDrive(); }
}
const alive = () => docs.filter(d => !d.deleted).sort((a, b) => b.created_at - a.created_at);
const byId = id => docs.find(d => d.id === id);
function newDoc() {
  const now = Date.now();
  const d = migrate({ id: uid(), name: dateStamp(now) + ' ', created_at: now, updated_at: now, pages: [], rev: 0, rev_have: 0, pushed_rev: 0, srv: 0, size: 0, deleted: false });
  docs.unshift(d); snap[d.id] = sigOf(d);
  return d;
}
// The pages changed: new revision, new thumbnail, PDF rebuilt in the background. Only ever called
// for a document whose newest pages are on this device (callers check hasContent first).
function touchContent(d) {
  d.rev = Math.max(Date.now(), d.rev + 1); d.rev_have = d.rev; d.rtag = newTag();
  d.size = d.pages.reduce((a, p) => a + (p.size || 0), 0); d.pageCount = d.pages.filter(p => !p.status).length;
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
function queue(fn) { qLen++; busy(true); q = q.then(fn).catch(e => toast('Processing failed: ' + errText(e))).then(() => { qLen--; busy(false); }); return q; }
function busy(on) { busyN = Math.max(0, busyN + (on ? 1 : -1)); $('busy').classList.toggle('on', busyN > 0); }
async function waitForPages() { while (qLen > 0) await q; }

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
// every history entry carries the id of this start: entries left over from before a restart are recognised
const histState = () => ({ n: stack.length, b: BOOT_ID });
function push(name) { stack.push(name); history.pushState(histState(), ''); applyStack(); }
function replaceTop(name) { leave(stack.pop()); stack.push(name); history.replaceState(histState(), ''); applyStack(); }
function back() { if (stack.length > 1) history.back(); }
function leave(name) {
  if (name === 'cam') {                 // the system back button out of a new batch scan still ends on the new document and its name
    const d = camDoc, n = camCount, fromDoc = camFromDoc;
    stopCamera();
    if (d && n && !fromDoc && docs.includes(d)) setTimeout(() => { if (current() === 'home' && !d.deleted) openDoc(d, { fresh: true }); }, 0);
  }
  if (name === 'edit') editCleanup();
  if (name === 'doc') leaveDoc();
  if (name === 'sheet') sheetClosed();
  if (name === 'popup') { const p = popupState; popupState = null; if (p && p.after) setTimeout(p.after, 0); }   // the chosen action runs once the popup has really closed
}
window.addEventListener('popstate', e => {
  const st = e.state;
  if (/[#&](access_token|error|error_code)=/.test(location.hash)) { location.reload(); return; }   // a sign-in link was opened in this very tab: start over so it is handled
  if (!st || st.b !== BOOT_ID) {        // an entry from before a restart: Back still closes exactly one level
    if (stack.length > 1) { leave(stack.pop()); history.replaceState(histState(), ''); applyStack(); renderAll(); }
    else history.back();
    return;
  }
  const depth = st.n || 1;
  while (stack.length > depth && stack.length > 1) leave(stack.pop());
  applyStack(); renderAll(); afterNav();
});
function renderAll() { renderHome(); renderSyncLine(); if (current() === 'doc') renderDoc(); }

// ---------- popups and toasts ----------
// opts.lockOk: this popup belongs to the lock screen itself. Any other popup is refused while locked.
function popup(title, text, buttons, opts) {
  const lockOk = !!(opts && opts.lockOk);
  if ((locked && !lockOk) || passive) return;
  if (stack[stack.length - 1] === 'popup') return;           // one at a time
  const box = $('popupBox');
  box.innerHTML = '<h3>' + esc(title) + '</h3>' + (text ? '<p>' + esc(text) + '</p>' : '');
  for (const b of buttons) {
    const el = document.createElement('button'); el.textContent = b.label; el.className = b.cls || '';
    el.addEventListener('click', () => { if (popupState) popupState.after = (locked && !popupState.lockOk) ? null : (b.fn || null); back(); });
    box.appendChild(el);
  }
  popupState = { after: null, lockOk }; push('popup');
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
