'use strict';
/* Snapdoc folder copies: optional, on a desktop browser. The user picks a folder once (for example
   the folder that Proton Drive, OneDrive or Dropbox keeps in sync), and from then on every
   document is kept there as a plain PDF: written after a scan or a change, renamed after a rename,
   removed after a delete. The sync app of that folder does the upload; Snapdoc never talks to that
   service and holds no account of it. Phones cannot do this (no folder access for web apps), so the
   PC that has the folder does it for every document that reaches it through the encrypted sync.

   The folder's handle is kept in the database as the browser hands it out (it is a capability, not
   a secret: it opens that one folder for this app only). After a restart the browser may ask for a
   tap before the folder may be written again; the status line says so. */
const FOLDER = typeof self.showDirectoryPicker === 'function';
let folder = null;                // { handle, name } once chosen; stored in meta 'folder'
let folderTimer = null, folderBusy = false, folderAgain = false, folderState = '', folderMsg = '';
const folderFail = new Map();     // document id -> { rev, name, n, until, why }

async function loadFolder() {
  folder = null;
  if (!FOLDER) return;
  try { const r = await idb.get('meta', 'folder'); if (r && r.handle) folder = { handle: r.handle, name: r.name || r.handle.name || 'folder' }; } catch (e) { folder = null; }
}
async function storeFolder() {
  if (folder) await idb.put('meta', { id: 'folder', handle: folder.handle, name: folder.name }); else await idb.del('meta', 'folder');
}
// documents whose copy in the folder is missing, out of date, misnamed, or has to go
function folderPending() {
  return docs.filter(d => d.deleted ? !!d.fcopy : hasContent(d) && d.pages.some(p => !p.status) && (!d.fcopy || d.fcopy.rev < d.rev || d.fcopy.name !== folderName(d)));
}
// the file name in the folder: the document's name, kept apart from another document with the same name
function folderName(d) {
  const base = fileName(d).replace(/\.pdf$/i, '');
  let name = base + '.pdf', n = 2;
  while (docs.some(o => o !== d && !o.deleted && o.fcopy && o.fcopy.name === name)) name = base + ' (' + n++ + ').pdf';
  return d.fcopy && d.fcopy.name && d.fcopy.name.replace(/ \(\d+\)\.pdf$/, '.pdf') === base + '.pdf' ? d.fcopy.name : name;
}
// 'granted', 'prompt' (a tap is needed) or 'denied'
async function folderPermission(ask) {
  if (!folder) return 'denied';
  try { let p = await folder.handle.queryPermission({ mode: 'readwrite' }); if (p !== 'granted' && ask) p = await folder.handle.requestPermission({ mode: 'readwrite' }); return p; } catch (e) { return 'denied'; }
}
// the user picks the folder (a tap is needed: the browser shows its own chooser)
async function folderChoose() {
  if (!FOLDER || passive) return;
  let h; try { h = await self.showDirectoryPicker({ mode: 'readwrite', id: 'snapdoc-copies', startIn: 'documents' }); } catch (e) { if (e && e.name === 'AbortError') return; toast('The folder could not be chosen: ' + errText(e)); return; }
  folder = { handle: h, name: h.name || 'folder' }; folderState = ''; folderMsg = ''; folderFail.clear();
  for (const d of docs) delete d.fcopy;                               // a new folder: every document is copied there
  await storeFolder(); persist(); renderFolderBox(); renderSyncLine();
  scheduleFolder(0);
}
async function folderStop() {
  folder = null; folderState = ''; folderMsg = ''; folderFail.clear();
  for (const d of docs) delete d.fcopy;
  await storeFolder(); persist(); renderFolderBox(); renderSyncLine();
}
async function folderWrite(d) {
  const name = folderName(d), blob = await getPdf(d);
  const fh = await folder.handle.getFileHandle(name, { create: true });
  const w = await fh.createWritable(); await w.write(blob); await w.close();
  if (d.fcopy && d.fcopy.name && d.fcopy.name !== name) { try { await folder.handle.removeEntry(d.fcopy.name); } catch (e) {} }      // renamed: the old file goes
  d.fcopy = { name, rev: d.rev }; persist();
}
async function folderRemove(d) {
  try { await folder.handle.removeEntry(d.fcopy.name); } catch (e) { if (!e || e.name !== 'NotFoundError') throw e; }
  delete d.fcopy; persist();
}
function scheduleFolder(ms) { if (!FOLDER || !folder || passive) return; clearTimeout(folderTimer); folderTimer = setTimeout(folderNow, ms == null ? 2500 : ms); }
async function folderNow() {
  if (!FOLDER || !folder || passive || locked || !Vault.isOpen() || !docsLoaded) return;
  if (folderBusy) { folderAgain = true; return; }
  const todo = folderPending(); if (!todo.length) { if (folderState === 'busy') setFolderState('', ''); return; }
  if ((await folderPermission(false)) !== 'granted') { setFolderState('reconnect', ''); return; }      // the browser wants a tap first
  folderBusy = true; folderAgain = false; let failed = 0, why = '';
  try {
    for (const d of todo) {                                            // one document that cannot be written does not hold up the others
      if (passive || locked || !folder) break;
      const f = folderFail.get(d.id);
      if (f && f.rev === d.rev && Date.now() < f.until) { failed++; why = f.why; continue; }
      setFolderState('busy', 'Folder: ' + (d.deleted ? 'removing' : 'writing') + ' ' + docLabel(d));
      try { if (d.deleted) await folderRemove(d); else await folderWrite(d); folderFail.delete(d.id); }
      catch (e) {
        if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) { setFolderState('reconnect', ''); return; }
        if (e && e.name === 'NotFoundError') { setFolderState('error', 'The folder "' + folder.name + '" is gone. Choose it again in the menu.'); return; }
        failed++; why = '"' + docLabel(d) + '": ' + errText(e);
        const k = (f && f.rev === d.rev ? f.n : 0) + 1;
        folderFail.set(d.id, { rev: d.rev, n: k, why, until: Date.now() + Math.min(3600000, 60000 * Math.pow(4, k - 1)) });
      }
    }
    if (failed) setFolderState('error', failed === 1 ? why : failed + ' documents could not be written. Last reason: ' + why); else setFolderState('', '');
  } catch (e) { setFolderState('error', errText(e)); }
  finally { folderBusy = false; }
  if (folderAgain) scheduleFolder(500);
}
function setFolderState(s, msg) { folderState = s; folderMsg = msg; renderSyncLine(); renderFolderBox(); }
function folderSummary() {
  const live = docs.filter(d => !d.deleted && hasContent(d) && d.pages.some(p => !p.status)), done = live.filter(d => d.fcopy && d.fcopy.rev >= d.rev && d.fcopy.name === folderName(d)).length;
  return { total: live.length, done };
}
// "tap here" on the status line: the browser's permission question needs a tap
async function folderTap() { if (!folder) return; if ((await folderPermission(true)) === 'granted') { setFolderState('', ''); folderFail.clear(); folderNow(); } }
function renderFolderBox() {
  const box = $('folderBox'); if (!box) return;
  if (!FOLDER) { box.innerHTML = '<p>On a PC, Snapdoc can keep a plain PDF of every document in a folder of your choice, for example the folder that Proton Drive keeps in sync. Open Snapdoc in Chrome or Edge on the PC to set it up; the phone then only needs the encrypted sync.</p>'; return; }
  if (!folder) {
    box.innerHTML = '<p>Keep a plain PDF of every document in a folder on this PC, written right after each scan or change. Pick the folder that Proton Drive (or another sync app) keeps in sync, and the PDFs land in that drive by themselves.</p>' +
      '<button id="folderOn" class="btn primary">Choose a folder</button>';
    $('folderOn').addEventListener('click', folderChoose);
    return;
  }
  const s = folderSummary(), err = folderState === 'error' || folderState === 'reconnect';
  const line = folderState === 'busy' ? folderMsg + '…' : folderState === 'reconnect' ? 'The browser wants a tap before the folder may be written again.' : folderState === 'error' ? folderMsg : s.done + ' of ' + s.total + ' documents in the folder';
  box.innerHTML = '<div class="statecard' + (err ? ' err' : '') + '"><div class="t">PDF copies in "' + esc(folder.name) + '"</div><div class="s">' + esc(line) + '</div></div>' +
    (folderState === 'reconnect' ? '<button id="folderRe" class="btn primary">Allow again</button>' : '<button id="folderNowBtn" class="btn">Write now</button>') +
    '<button id="folderOff" class="btn quiet">Stop the copies</button>';
  if ($('folderRe')) $('folderRe').addEventListener('click', folderTap);
  if ($('folderNowBtn')) $('folderNowBtn').addEventListener('click', () => { folderFail.clear(); folderNow(); });
  $('folderOff').addEventListener('click', () => popup('Stop the folder copies?', 'The PDFs already in the folder stay there. New scans are no longer written to it.', [{ label: 'Stop', cls: 'danger', fn: folderStop }, { label: 'Keep them', cls: 'quiet' }]));
}
