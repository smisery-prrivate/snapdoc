'use strict';
/* Snapdoc start-up: become the one active instance, open the vault (asking for the lock if one is
   set), load the documents, continue a sign-in link, start sync, keep the app up to date. */
function fatal(msg) { $('list').innerHTML = '<div class="empty"><b>Snapdoc cannot start</b>' + esc(msg) + '</div>'; }

// ---------- one active instance (see app-core.js for the write guard) ----------
const INSTANCE_LOCK = 'snapdoc-instance', TAKE_KEY = 'snapdoc.take';
let instanceRelease = null;
const bc = 'BroadcastChannel' in self ? new BroadcastChannel('snapdoc') : null;
function holdInstance(opts) {                       // resolves true once this instance holds the lock
  return new Promise(resolve => {
    let held = false;
    navigator.locks.request(INSTANCE_LOCK, opts, lock => {
      if (!lock) { resolve(false); return; }
      held = true;
      try { localStorage.setItem(OWNER_KEY, INSTANCE_ID); } catch (e) {}
      resolve(true);
      return new Promise(rel => { instanceRelease = rel; });
    }).catch(() => { if (held) instanceLost(); else resolve(false); });      // taken over by another window, or never granted
  });
}
function askHolder() {                              // is the instance that holds the lock in front of the user? true / false / null (no answer)
  return new Promise(res => {
    if (!bc) { res(null); return; }
    const on = e => { if (e.data && e.data.t === 'here') { clearTimeout(t); bc.removeEventListener('message', on); res(!!e.data.visible); } };
    const t = setTimeout(() => { bc.removeEventListener('message', on); res(null); }, 500);
    bc.addEventListener('message', on); bc.postMessage({ t: 'who', from: INSTANCE_ID });
  });
}
async function acquireInstance(force) {
  if (!navigator.locks) { try { localStorage.setItem(OWNER_KEY, INSTANCE_ID); } catch (e) {} return true; }     // older browsers: the newest window simply takes over
  if (await holdInstance({ ifAvailable: true })) return true;
  if (!force && (await askHolder()) === true) return false;                 // another window is in use right now: let the user choose
  if (bc) bc.postMessage({ t: 'yield', from: INSTANCE_ID });                // ask it to finish and let go…
  // …while it still has shots to finish it says "busy" once a second, and is given the time (a minute
  // at most). A frozen background tab says nothing: after four silent seconds it is taken over.
  const ctl = new AbortController(), t0 = Date.now(); let timer = setTimeout(() => ctl.abort(), 4000);
  const onBusy = e => { if (e.data && e.data.t === 'busy' && Date.now() - t0 < 60000) { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), 4000); } };
  if (bc) bc.addEventListener('message', onBusy);
  const got = await holdInstance({ signal: ctl.signal }); clearTimeout(timer);
  if (bc) bc.removeEventListener('message', onBusy);
  return got || holdInstance({ steal: true });
}
function showAway() {
  for (const id of COVERED) $(id).inert = true;
  $('toast').classList.remove('show'); $('away').hidden = false;
}
function stopEverything() { try { stopCamera(); } catch (e) {} clearTimeout(syncTimer); }
function instanceLost() { if (passive) return; passive = true; showAway(); stopEverything(); }
async function yieldInstance() {                    // another window takes over: finish what is in flight, then let go
  showAway();
  const t0 = Date.now(); let said = 0;
  if (curDoc) { try { commitName(); } catch (e) {} }
  try { stopCamera(); } catch (e) {}                 // no new shot from here on; one that is under way still lands in its document
  // Shots that already flashed are finished first, however long that takes (up to the minute the
  // other window grants): a page must not be thrown away because a second window was opened.
  // Syncing and saving get three seconds, as before.
  const shotsLeft = () => qLen > 0 || shotsPending > 0;
  while ((shotsLeft() && Date.now() - t0 < 55000) || ((syncing || persistQueued) && Date.now() - t0 < 3000)) {
    if (bc && shotsLeft() && Date.now() - said > 900) { said = Date.now(); bc.postMessage({ t: 'busy', from: INSTANCE_ID }); }
    await new Promise(r => setTimeout(r, 100));
  }
  try { await persistChain; } catch (e) {}
  passive = true; stopEverything();
  if (instanceRelease) { instanceRelease(); instanceRelease = null; }
}
if (bc) bc.addEventListener('message', e => {
  const m = e.data || {}; if (m.from === INSTANCE_ID || passive || !instanceRelease) return;
  if (m.t === 'who') bc.postMessage({ t: 'here', visible: !document.hidden, from: INSTANCE_ID });
  if (m.t === 'yield') yieldInstance();
});
$('awayBtn').addEventListener('click', () => { try { sessionStorage.setItem(TAKE_KEY, '1'); } catch (e) {} location.reload(); });

// ---------- updates ----------
// The service worker holds one complete release. When a new one has taken over, the page restarts
// at a quiet moment so that it never runs a mix of two versions.
let swReg = null, updateReady = false, lastUpdateCheck = 0;
function registerSW() {
  let allow = location.protocol === 'https:'; try { allow = allow || localStorage.getItem('snapdoc.sw') === '1'; } catch (e) {}
  if (!('serviceWorker' in navigator) || !allow) return;
  const had = !!navigator.serviceWorker.controller; let changes = 0;
  navigator.serviceWorker.addEventListener('controllerchange', () => { changes++; if (had || changes > 1) { updateReady = true; afterNav(); } });
  navigator.serviceWorker.register('sw.js').then(r => { swReg = r; }).catch(() => {});
}
function checkForUpdate() {
  if (!swReg || Date.now() - lastUpdateCheck < 3600000) return;
  lastUpdateCheck = Date.now(); swReg.update().catch(() => {});
}
// called after navigation and after background work: apply a waiting update when nothing is going on
function afterNav() {
  if (!updateReady || locked || passive || !Vault.isOpen()) return;
  if (current() !== 'home' || stack.length > 1 || workInFlight() || Vault.lockType()) return;      // with a lock it arrives at the next unlock instead
  location.reload();
}

async function boot() {
  const vt = $('vtag'); if (vt) vt.textContent = VERSION;
  // a sign-in link returns with tokens (or an error) in the URL fragment; take them and clean the address at once
  let tokens = null, linkMsg = '';
  const h = location.hash || '';
  try {
    const qp = new URLSearchParams(h.slice(1));
    if (qp.get('access_token') && qp.get('refresh_token')) tokens = { access_token: qp.get('access_token'), refresh_token: qp.get('refresh_token') };
    else if (qp.get('error') || qp.get('error_code')) linkMsg = qp.get('error_code') === 'otp_expired' ? 'This sign-in link has expired or was already used. Request a new one in the menu.'
      : 'The sign-in link could not be used' + (qp.get('error_description') ? ': ' + qp.get('error_description').replace(/\+/g, ' ') : '.');
  } catch (e) {}
  history.replaceState(histState(), '', location.pathname + location.search);
  applyStack(); startWorker();

  let force = false; try { force = sessionStorage.getItem(TAKE_KEY) === '1'; sessionStorage.removeItem(TAKE_KEY); } catch (e) {}
  let mine = true; try { mine = await acquireInstance(force || !!tokens); } catch (e) { mine = true; }
  if (!mine) { passive = true; showAway(); return; }

  let state;
  try { state = await Vault.load(metaStore); } catch (e) { fatal('The storage of this browser could not be opened (' + errText(e) + '). Private windows and blocked site data prevent it.'); return; }
  if (state === 'locked') { showLock(false); await whenUnlocked(); }
  try { await loadDocs(); } catch (e) { fatal('The stored documents could not be read (' + errText(e) + ').'); return; }
  await loadSession(); syncFormatCheck();
  if (tokens) { try { linkMsg = await adoptLink(tokens); } catch (e) { linkMsg = 'The sign-in link could not be used.'; } }

  // captures that never finished (app closed while processing) leave nothing behind
  let changed = false;
  for (const d of docs.slice()) {
    if (d.pages.some(p => p.status)) { d.pages = d.pages.filter(p => !p.status); changed = true; }
    if (!d.deleted && !d.pages.length && !d.rev) { docs.splice(docs.indexOf(d), 1); delete snap[d.id]; changed = true; }
  }
  if (changed) persist();
  // will the browser keep the scans? If it does not promise that, the menu says so while copies exist only here
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().then(ok => { storageAtRisk = !ok; renderInstallBox(); }).catch(() => {});
  else storageAtRisk = true;
  renderAll();
  if (linkMsg) popup('Sign-in link', linkMsg, [{ label: 'OK', cls: 'primary' }]);

  let resume = ''; try { resume = sessionStorage.getItem(RESUME_KEY) || ''; sessionStorage.removeItem(RESUME_KEY); } catch (e) {}
  const rd = resume && byId(resume); if (rd && !rd.deleted && !linkMsg) openDoc(rd);

  if (session) syncNow().then(() => { if (tokens && !linkMsg && (keyNeed === 'create' || keyNeed === 'enter')) openSheet(); });
  setTimeout(resealAll, 3000); setTimeout(housekeeping, 8000);
  registerSW();
}
// Tidying up, only while nothing else is going on.
async function housekeeping() {
  if (!Vault.isOpen() || locked || passive) return;
  if (qLen > 0 || syncing) { setTimeout(housekeeping, 60000); return; }
  const idle = () => qLen === 0 && !syncing && !locked && !passive;
  try {
    // original photos are kept for 30 days so a page can be re-cropped; after that only the scan stays
    const cutoff = Date.now() - 30 * 864e5; let n = 0;
    for (const d of docs) {
      if (Math.max(d.created_at, d.rev) > cutoff || !hasContent(d)) continue;
      for (const p of d.pages) if (p.o && idle()) { try { await pagePut(p.id, d.id, { orig: null }); delete p.o; n++; } catch (e) {} }
    }
    if (n) persist();
    // records that nothing refers to any more (a page deleted just before the app closed, an interrupted download);
    // only ones older than an hour, so nothing that is still being written is touched
    const ref = new Set(); for (const d of docs) for (const p of d.pages) ref.add(p.id);
    const old = Date.now() - 3600000;
    for (const id of await idb.keys('pages')) {
      if (!idle()) return;
      if (ref.has(id) || pendingDel.has(id)) continue;
      const r = await idb.get('pages', id); if (r && (r.ts || 0) < old && idle() && !ref.has(id)) await idb.del('pages', id);
    }
    const live = new Set(docs.filter(d => !d.deleted).map(d => d.id));
    for (const st of ['pdfs', 'thumbs']) for (const id of await idb.keys(st)) { if (!idle()) return; if (!live.has(id)) await idb.del(st, id); }
  } catch (e) {}
}
// another tab of the app changed something (only on browsers without the one-instance lock)
window.addEventListener('storage', e => {
  if (e.key === OWNER_KEY && e.newValue && e.newValue !== INSTANCE_ID && !passive && Vault.isOpen() && !navigator.locks) { instanceLost(); return; }
  if (e.key !== TICK_KEY || !Vault.isOpen() || locked || passive) return;
  foreignDirty = true;
  mergeStored().then(() => { foreignDirty = false; return syncing ? null : loadSession(); }).then(renderAll).catch(() => {});
});
window.addEventListener('online', () => syncNow());
setInterval(() => { if (passive) return; renderSyncLine(); syncNow(); }, 60000);

window.snapdocDebug = { get docs() { return docs; }, get session() { return session; }, get keyNeed() { return keyNeed; }, get syncState() { return syncState + (syncMsg ? ': ' + syncMsg : ''); },
  get busy() { return syncing || qLen > 0 || persistQueued; }, get passive() { return passive; }, get locked() { return locked; }, get updateReady() { return updateReady; },
  syncNow, getPdf, idb, pageGet, Vault, relock, resealAll, housekeeping };
boot().catch(e => fatal('Unexpected error: ' + errText(e)));
