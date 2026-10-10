'use strict';
/* Snapdoc start-up: become the one active instance, open the vault (asking for the lock if one is
   set), load the documents, continue a sign-in link, start sync, keep the app up to date. */
function fatal(msg) { $('list').innerHTML = '<div class="empty"><b>Snapdoc cannot start</b>' + esc(msg) + '</div>'; }

// ---------- one active instance (see app-core.js for the write guard) ----------
const INSTANCE_LOCK = 'snapdoc-instance', TAKE_KEY = 'snapdoc.take', STAY_KEY = 'snapdoc.stay', WIPE_KEY = 'snapdoc.wipe', EDIT_KEY = 'snapdoc.edit', LINKHASH_KEY = 'snapdoc.linkHash';
let instanceRelease = null;
const bc = 'BroadcastChannel' in self ? new BroadcastChannel('snapdoc') : null;
function holdInstance(opts) {                       // resolves true once this instance holds the lock
  return new Promise(resolve => {
    let held = false;
    navigator.locks.request(INSTANCE_LOCK, opts, lock => {
      if (!lock) { resolve(false); return; }
      held = true; lockHeld = true;
      try { localStorage.setItem(OWNER_KEY, INSTANCE_ID); } catch (e) {}
      startAlive(); resolve(true);
      return new Promise(rel => { instanceRelease = rel; });
    }).catch(() => { lockHeld = false; if (held) instanceLost(); else resolve(false); });      // taken over by another window, or never granted
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
const AWAY_TEXT = 'Only one can be active at a time, so that nothing gets overwritten.';
const awayNote = t => { const p = $('away').querySelector('p'); if (p) p.textContent = t; };
let aliveTimer = null;
function startAlive() { clearInterval(aliveTimer); markAlive(); aliveTimer = setInterval(markAlive, 1000); }      // once a second while this window holds the instance
const aliveAge = () => { try { return Date.now() - (+localStorage.getItem(ALIVE_KEY) || 0); } catch (e) { return Infinity; } };
// Waits for the other window to let go. While it still has shots to finish it says "busy" once a
// second and is given that time, however long; the screen says so. A window that says nothing for
// four seconds is frozen or gone. Resolves true once the lock is held.
function waitForRelease() {
  const ctl = new AbortController(); let timer = setTimeout(() => ctl.abort(), 4000), shown = false;
  const onBusy = e => { if (e.data && e.data.t === 'busy') { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), 4000); if (!shown) { shown = true; awayNote('The other window is finishing its scans. Snapdoc opens here as soon as they are stored.'); $('away').hidden = false; } } };
  if (bc) bc.addEventListener('message', onBusy);
  return holdInstance({ signal: ctl.signal }).then(got => { clearTimeout(timer); if (bc) bc.removeEventListener('message', onBusy); if (shown) { $('away').hidden = true; awayNote(AWAY_TEXT); } return got; });
}
// the other window says "busy" while it finishes; without messages its alive stamp (once a second,
// and before a long job on its main thread) still says it is there
let released = false;                                                     // the holder said it let go
const waitBusy = ms => new Promise(r => { if (!bc) { r(); return; } let t = setTimeout(done, ms); const on = e => { if (!e.data) return; if (e.data.t === 'released') { released = true; done(); } else if (e.data.t === 'busy') { clearTimeout(t); t = setTimeout(done, 4000); } }; function done() { bc.removeEventListener('message', on); r(); } bc.addEventListener('message', on); });
async function acquireInstance(force) {
  if (!navigator.locks) {                                                   // older browsers: the same hand-shake over messages, then the mark alone decides
    if (!force && (await askHolder()) === true) return false;
    released = false;
    if (bc) { bc.postMessage({ t: 'yield', from: INSTANCE_ID }); await waitBusy(1500); }
    const t0 = Date.now(); let shown = false;
    while (!released && aliveAge() < 30000 && Date.now() - t0 < 120000) {    // alive but silent: given time, and the screen says so
      if (!shown) { shown = true; awayNote('The other window is finishing its scans. Snapdoc opens here as soon as they are stored.'); $('away').hidden = false; }
      await waitBusy(2000);
    }
    if (shown) { $('away').hidden = true; awayNote(AWAY_TEXT); }
    try { localStorage.setItem(OWNER_KEY, INSTANCE_ID); } catch (e) {}
    instanceRelease = () => {}; lockHeld = true;                           // the hand-shake stays answered from this side too
    startAlive(); return true;
  }
  if (await holdInstance({ ifAvailable: true })) return true;
  if (!bc && !force) return false;                                          // no way to ask: never taken over on its own, the user decides with "Use Snapdoc here"
  if (!force && (await askHolder()) === true) return false;                 // another window is in use right now: let the user choose
  if (bc) bc.postMessage({ t: 'yield', from: INSTANCE_ID });                // ask it to finish and let go
  if (await waitForRelease()) return true;
  const ans = await askHolder();                                            // before taking over: who holds it now?
  if (ans === true) return false;                                           // a window in front of the user took over meanwhile
  if (ans === false) { if (bc) bc.postMessage({ t: 'yield', from: INSTANCE_ID }); if (await waitForRelease()) return true; if ((await askHolder()) != null) return false; }
  const t0 = Date.now();
  while (aliveAge() < 30000 && Date.now() - t0 < 120000) { if (await waitForRelease()) return true; if ((await askHolder()) === true) return false; }      // silent but alive (a busy main thread): given time
  return holdInstance({ steal: true });                                     // nobody answers and nothing stirs: frozen or gone
}
// A window with a lock that has stepped aside restarts without the key, so nothing decrypted stays in its memory.
function stepAside() { if (!Vault.lockType()) return; try { sessionStorage.setItem(STAY_KEY, '1'); } catch (e) {} location.reload(); }
function showAway() {
  for (const id of COVERED) $(id).inert = true;
  $('toast').classList.remove('show'); $('away').hidden = false;
}
function stopEverything() { try { stopCamera(); } catch (e) {} clearTimeout(syncTimer); }
function instanceLost() { if (passive) return; passive = true; lockHeld = false; clearInterval(aliveTimer); try { localStorage.removeItem(ALIVE_KEY); } catch (e) {} showAway(); stopEverything(); abortSync(); stepAside(); }
async function yieldInstance() {                    // another window takes over: finish what is in flight, then let go
  showAway();
  const t0 = Date.now(); let said = 0;
  if (curDoc) { try { commitName(); } catch (e) {} }
  try { stopCamera(); } catch (e) {}                 // no new shot from here on; one that is under way still lands in its document
  // Shots that already flashed are finished first, however long that takes; the other window is
  // told "busy" once a second meanwhile and waits. A page is never thrown away because a second
  // window was opened. Syncing gets three seconds; the next window can redo it.
  const shotsLeft = () => qLen > 0 || shotsPending > 0 || persistQueued || edApplying || busyN > 0 || pdfBuilding;      // a crop, a rotation or a PDF under way finishes too
  while (shotsLeft() || (syncing && Date.now() - t0 < 3000)) {
    if (bc && Date.now() - said > 900) { said = Date.now(); bc.postMessage({ t: 'busy', from: INSTANCE_ID }); }
    await new Promise(r => setTimeout(r, 100));
  }
  try { await persistChain; } catch (e) {}
  passive = true; lockHeld = false; stopEverything(); clearInterval(aliveTimer);
  try { localStorage.removeItem(ALIVE_KEY); } catch (e) {}                 // no stale stamp keeps the other window waiting
  if (instanceRelease) { instanceRelease(); instanceRelease = null; }
  if (bc) bc.postMessage({ t: 'released', from: INSTANCE_ID });
  stepAside();
}
if (bc) bc.addEventListener('message', e => {
  const m = e.data || {}; if (m.from === INSTANCE_ID) return;
  if (m.t === 'who' || m.t === 'yield') markNeeded = true;        // another window exists: the owner mark matters from now on
  if (passive || !instanceRelease) return;
  if (m.t === 'who') bc.postMessage({ t: 'here', visible: !document.hidden, from: INSTANCE_ID });
  if (m.t === 'yield') yieldInstance();
});
$('awayBtn').addEventListener('click', () => { try { sessionStorage.setItem(TAKE_KEY, '1'); } catch (e) {} reloadPage(); });      // a sign-in link that landed here comes along

// ---------- updates ----------
// The service worker holds one complete release. When a new one has taken over, the page restarts
// at a quiet moment so that it never runs a mix of two versions.
// A new release installs and then waits. The page running the old release keeps its complete set
// until it asks for the switch itself, right before it restarts (afterNav at a quiet moment, or the
// restart of the lock), so it never loads a file of the new release. If the switch happens anyway
// (another window asked for it), this page restarts at the next quiet moment and makes no worker meanwhile.
let swReg = null, updateReady = false, swTookOver = false, lastUpdateCheck = 0, swSwitching = false;
const hadController = 'serviceWorker' in navigator && !!navigator.serviceWorker.controller;
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('controllerchange', () => {      // attached at once: a release that takes over during start-up is noticed too
  if (swSwitching) return;
  if (hadController) { swTookOver = true; updateReady = true; afterNav(); }
});
function noteWaiting(r) { if (r && r.waiting && navigator.serviceWorker.controller) { updateReady = true; afterNav(); } }
function registerSW() {
  let allow = location.protocol === 'https:'; try { allow = allow || localStorage.getItem('snapdoc.sw') === '1'; } catch (e) {}
  if (!('serviceWorker' in navigator) || !allow) return;
  navigator.serviceWorker.register('sw.js').then(r => {
    swReg = r; noteWaiting(r);
    r.addEventListener('updatefound', () => { const w = r.installing; if (w) w.addEventListener('statechange', () => { if (w.state === 'installed') noteWaiting(r); }); });
  }).catch(() => {});
}
function checkForUpdate() {
  if (!swReg || Date.now() - lastUpdateCheck < 3600000) return;
  lastUpdateCheck = Date.now(); swReg.update().catch(() => {});
}
// the switch to the waiting release, right before a restart; resolves once it is in control (or after a moment)
function swSwitch() {
  if (!swReg || !swReg.waiting) return Promise.resolve();
  swSwitching = true;
  return new Promise(res => { const t = setTimeout(res, 3000); navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(t); res(); }, { once: true }); try { swReg.waiting.postMessage({ t: 'skip' }); } catch (e) { clearTimeout(t); res(); } });
}
// called after navigation and after background work: apply a waiting update when nothing is going on
function afterNav() {
  if (!updateReady || locked || passive || !Vault.isOpen()) return;
  if (current() !== 'home' || stack.length > 1 || workInFlight() || (Vault.lockType() && !swTookOver) || persistQueued || persistFailed) return;      // with a lock it arrives with the restart of the lock instead, unless another window switched already: then this page runs on a cache that is gone
  persistChain.then(async () => { if (persistFailed || workInFlight() || current() !== 'home') return; await swSwitch(); location.reload(); });
}

async function boot() {
  const vt = $('vtag'); if (vt) vt.textContent = VERSION;
  // a sign-in link returns with tokens (or an error) in the URL fragment; take them and clean the address at once
  let tokens = null, linkMsg = '', driveQp = null, search = location.search;
  let h = location.hash || ''; if (!h) { try { h = sessionStorage.getItem(LINKHASH_KEY) || ''; sessionStorage.removeItem(LINKHASH_KEY); } catch (e) {} }      // a link that landed in a window which then stepped aside
  try {
    const qs = new URLSearchParams(location.search), code = qs.get('code');
    const sentence = c => c === 'otp_expired' ? 'This sign-in link has expired or was already used. Request a new one in the menu.' : c === 'access_denied' ? 'The sign-in link was refused. Request a new one in the menu.' : 'The sign-in link could not be used. Request a new one in the menu.';      // a few fixed sentences: never the sender's own text
    if (code) tokens = { code };                                                                     // the PKCE form of the sign-in link: a one-time code in the query
    else if (qs.get('error') || qs.get('error_code')) linkMsg = sentence(qs.get('error_code') || qs.get('error'));      // the PKCE form of a refused link
    for (const k of ['code', 'error', 'error_code', 'error_description']) qs.delete(k);
    const rest = qs.toString(); search = rest ? '?' + rest : '';
    const qp = new URLSearchParams(h.slice(1));
    if ((qp.get('state') || '').startsWith(DRIVE_STATE + '.')) driveQp = qp;                       // back from Google (Drive copies)
    else if (!tokens && qp.get('access_token') && qp.get('refresh_token')) tokens = { access_token: qp.get('access_token'), refresh_token: qp.get('refresh_token') };
    else if (!linkMsg && (qp.get('error') || qp.get('error_code'))) linkMsg = sentence(qp.get('error_code') || qp.get('error'));
  } catch (e) {}
  history.replaceState(histState(), '', location.pathname + search);
  applyStack(); startWorker();

  // a link is only accepted when this browser asked for one within the hour: only then may it take the app away from another window
  let asked = 0; try { asked = +localStorage.getItem(LINK_KEY) || 0; } catch (e) {}
  const linkFresh = asked && Math.abs(Date.now() - asked) <= 3600000;
  if (linkMsg && !linkFresh) linkMsg = '';                              // an error link nobody asked for is not shown
  if (tokens && !linkFresh) { tokens = null; linkMsg = 'This sign-in link was not requested from this browser, or it is older than an hour. Request a new one in the menu.'; }
  let force = false, stay = false, wipe = false;
  try { wipe = sessionStorage.getItem(WIPE_KEY) === '1'; force = sessionStorage.getItem(TAKE_KEY) === '1' || wipe; sessionStorage.removeItem(TAKE_KEY); stay = sessionStorage.getItem(STAY_KEY) === '1'; if (force) { sessionStorage.removeItem(STAY_KEY); stay = false; } } catch (e) {}
  if (stay && !tokens && !driveQp) { passive = true; showAway(); return; }          // this window stepped aside with a lock set: it stays key-free until "Use Snapdoc here"
  let mine = true; try { mine = await acquireInstance(force || !!tokens || !!driveQp); } catch (e) { mine = true; }      // a reply this browser asked Google for counts like a sign-in link
  if (!mine) { passive = true; showAway(); return; }
  if (wipe) { try { await wipeNow(); } catch (e) {} try { sessionStorage.removeItem(WIPE_KEY); } catch (e) {} }      // "Reset this app": erased here, before anything else can write; the mark goes only once it ran
  try { if (!(await idb.get('meta', 'keys'))) await idb.wipe(); } catch (e) {}      // no key record: nothing stored can be read; leftovers go before a new key is made

  let state;
  try { state = await Vault.load(metaStore); } catch (e) {
    fatal('The storage of this browser could not be opened (' + errText(e) + '). Private windows and blocked site data prevent it.');
    popup('Snapdoc cannot start', errText(e) + ' You can erase everything stored here and start again.', [{ label: 'Erase and reset', cls: 'danger', fn: () => wipeEverything().then(() => location.reload(), () => {}) }, { label: 'Not now', cls: 'quiet' }]);
    return;
  }
  if (state === 'locked') { showLock(false); await whenUnlocked(); if (!isOwner()) { instanceLost(); return; } }
  try { await loadDocs(); } catch (e) { fatal('The stored documents could not be read (' + errText(e) + ').'); return; }
  await loadSession(); syncFormatCheck(); await loadDrive();
  let driveMsgBoot = ''; if (driveQp) { try { driveMsgBoot = await driveAdopt(driveQp); } catch (e) { driveMsgBoot = 'Google Drive was not connected: ' + errText(e); } }
  if (tokens) { try { linkMsg = await adoptLink(tokens); } catch (e) { linkMsg = 'The sign-in link could not be used.'; } }

  // captures that never finished (app closed while processing) leave nothing behind
  let changed = false;
  for (const d of docs.slice()) {
    if (d.deleted && d.pages.length) { const gone = d.pages; d.pages = []; changed = true; purgeDocData(d, gone).catch(() => {}); continue; }      // a delete that was interrupted
    if (d.pages.some(p => p.status)) { d.pages = d.pages.filter(p => !p.status); changed = true; }
    if (!d.deleted && !d.pages.length && !d.rev) { docs.splice(docs.indexOf(d), 1); delete snap[d.id]; changed = true; }
  }
  if (changed) persist();
  // will the browser keep the scans? If it does not promise that, the menu says so while copies exist only here
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().then(ok => { storageAtRisk = !ok; renderInstallBox(); }).catch(() => {});
  else storageAtRisk = true;
  renderAll();
  if (linkMsg) popup('Sign-in link', linkMsg, [{ label: 'OK', cls: 'primary' }]);
  if (driveMsgBoot) popup('Google Drive', driveMsgBoot, [{ label: 'OK', cls: 'primary' }]);
  else if (driveQp && drive) toast('Google Drive connected as ' + (drive.email || 'your account'));

  let resume = ''; try { resume = sessionStorage.getItem(RESUME_KEY) || ''; sessionStorage.removeItem(RESUME_KEY); } catch (e) {}
  const rd = resume && byId(resume); if (rd && !rd.deleted && !linkMsg) openDoc(rd);
  let es = null; try { es = JSON.parse(sessionStorage.getItem(EDIT_KEY) || 'null'); sessionStorage.removeItem(EDIT_KEY); } catch (e) {}
  if (es && rd && !rd.deleted && !linkMsg && es.doc === rd.id) {         // the corners that were being adjusted when the app restarted
    const p = rd.pages.find(x => x.id === es.page);
    if (p && !p.status) openEdit(p, rd).then(() => { if (ed && ed.page === p && Array.isArray(es.quad) && es.quad.length === 4) { ed.quad = es.quad.map(c => c.slice()); ed.filter = es.filter || ed.filter; ed.rot = es.rot || 0; renderEdit(); } });
  }

  if (session) syncNow().then(() => { if (tokens && !linkMsg && (keyNeed === 'create' || keyNeed === 'enter')) openSheet(); });
  scheduleDrive(driveQp ? 0 : 4000);
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
    const ref = new Set(); for (const d of docs) if (!d.deleted) for (const p of d.pages) ref.add(p.id);
    const inUse = id => pendingDel.has(id) || docs.some(d => !d.deleted && d.pages.some(p => p.id === id));      // the live state, right before a record goes
    const old = Date.now() - 3600000;
    for (const id of await idb.keys('pages')) {
      if (!idle()) return;
      if (ref.has(id) || pendingDel.has(id)) continue;
      const r = await idb.get('pages', id), t = await pageTime(r);
      if (r && (t < old || t > Date.now() + 60000) && idle() && !inUse(id)) await idb.del('pages', id);      // a stamp from a clock that was ahead counts as old
    }
    const live = new Set(docs.filter(d => !d.deleted).map(d => d.id));
    for (const st of ['pdfs', 'thumbs']) for (const id of await idb.keys(st)) { if (!idle()) return; if (!live.has(id)) await idb.del(st, id); }
  } catch (e) {}
}
// another tab of the app changed something (only on browsers without the one-instance lock)
window.addEventListener('storage', e => {
  if (e.key === OWNER_KEY && e.newValue && e.newValue !== INSTANCE_ID) { markNeeded = true; if (!passive && !navigator.locks) { instanceLost(); return; } }      // a locked window steps aside just the same
  if (e.key !== TICK_KEY || !Vault.isOpen() || locked || passive) return;
  foreignDirty = true;
  mergeStored().then(() => { foreignDirty = false; return syncing ? null : loadSession(); }).then(renderAll).catch(() => {});
});
window.addEventListener('online', () => syncNow());
setInterval(() => { if (passive) return; renderSyncLine(); syncNow(); }, 60000);

window.snapdocDebug = { get docs() { return docs; }, get session() { return session; }, get keyNeed() { return keyNeed; }, get syncState() { return syncState + (syncMsg ? ': ' + syncMsg : ''); },
  get busy() { return syncing || qLen > 0 || persistQueued; }, get qLen() { return qLen; }, get passive() { return passive; }, get locked() { return locked; }, get updateReady() { return updateReady; },
  syncNow, syncRetry, getPdf, idb, pageGet, Vault, relock, resealAll, housekeeping, get drive() { return drive; }, get driveState() { return driveState; }, driveNow, drivePending };
boot().catch(e => fatal('Unexpected error: ' + errText(e)));
