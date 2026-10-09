'use strict';
/* Snapdoc start-up: open the vault (asking for the lock if one is set), load the documents,
   continue a sign-in link, start sync, register the service worker. */
function fatal(msg) { $('list').innerHTML = '<div class="empty"><b>Snapdoc cannot start</b>' + esc(msg) + '</div>'; }

async function boot() {
  // a sign-in link returns with tokens in the URL fragment; take them and clean the address at once
  let tokens = null;
  if (location.hash.includes('access_token=')) {
    try { const qp = new URLSearchParams(location.hash.slice(1)); if (qp.get('access_token') && qp.get('refresh_token')) tokens = { access_token: qp.get('access_token'), refresh_token: qp.get('refresh_token') }; } catch (e) {}
  }
  history.replaceState({ n: 1 }, '', location.pathname + location.search);
  applyStack(); startWorker();
  let state;
  try { state = await Vault.load(metaStore); } catch (e) { fatal('The storage of this browser could not be opened (' + (e.message || e) + '). Private windows and blocked site data prevent it.'); return; }
  if (state === 'locked') { showLock(); await whenUnlocked(); }
  try { await loadDocs(); } catch (e) { fatal('The stored documents could not be read (' + (e.message || e) + ').'); return; }
  await loadSession();
  if (tokens) { try { await adoptSession(tokens); } catch (e) { toast('The sign-in link could not be used.'); } }

  // captures that never finished (app closed while processing) leave nothing behind
  let changed = false;
  for (const d of docs.slice()) {
    if (d.pages.some(p => p.status)) { d.pages = d.pages.filter(p => !p.status); changed = true; }
    if (!d.deleted && !d.pages.length && !d.rev) { docs.splice(docs.indexOf(d), 1); delete snap[d.id]; changed = true; }
  }
  if (changed) persist();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  renderAll();

  let resume = ''; try { resume = sessionStorage.getItem(RESUME_KEY) || ''; sessionStorage.removeItem(RESUME_KEY); } catch (e) {}
  const rd = resume && byId(resume); if (rd && !rd.deleted) openDoc(rd);

  if (session) syncNow().then(() => { if (tokens && (keyNeed === 'create' || keyNeed === 'enter')) openSheet(); });
  for (const d of docs) if (!d.deleted && d.pages.length && d.rev_have === d.rev && d.pushed_rev < d.rev) schedulePdf(d);
  setTimeout(housekeeping, 8000);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
// Original photos are kept for 30 days so a page can be re-cropped; after that only the scan stays.
async function housekeeping() {
  if (!Vault.isOpen() || locked) return;
  const cutoff = Date.now() - 30 * 864e5; let n = 0;
  for (const d of docs) {
    if (Math.max(d.created_at, d.rev) > cutoff) continue;
    for (const p of d.pages) if (p.o) { try { await pagePut(p.id, d.id, { orig: null }); delete p.o; n++; } catch (e) {} }
  }
  if (n) persist();
}
// another tab of the app changed something
window.addEventListener('storage', e => {
  if (e.key !== TICK_KEY || !Vault.isOpen() || locked) return;
  foreignDirty = true;
  mergeStored().then(() => { foreignDirty = false; return syncing ? null : loadSession(); }).then(renderAll).catch(() => {});
});
window.addEventListener('online', () => syncNow());
setInterval(() => { renderSyncLine(); syncNow(); }, 60000);

window.snapdocDebug = { get docs() { return docs; }, get session() { return session; }, get keyNeed() { return keyNeed; }, get syncState() { return syncState + (syncMsg ? ': ' + syncMsg : ''); }, get busy() { return syncing || qLen > 0; },
  syncNow, getPdf, idb, pageGet, Vault, adoptSession, relock };
boot();
