'use strict';
/* Snapdoc cloud sync: local-first, optional. Sign-in by e-mail link (no password), then an
   encryption password that never leaves the device. The cloud only ever receives ciphertext:
   one encrypted PDF per document and one entry whose name and details are encrypted too.

   What the server cannot do: read anything, change an entry (every entry is sealed with the
   cloud key together with its revision, change time and delete flag), delete a document on a
   device by forging a delete marker, or hand out an older file for a newer entry (the file
   carries its revision inside the encryption). */
const SYNCUID_KEY = 'snapdoc.syncUid', LINK_KEY = 'snapdoc.linkAsked', FMT_KEY = 'snapdoc.syncFmt', SYNC_FMT = '4', MAX_FILE = 52428800;
let session = null, syncTimer = null, syncing = false, syncAgain = false, syncState = '', syncMsg = '';
let keyNeed = '', keyEnv = null, keyBusy = false;      // keyNeed: '' | 'create' | 'enter' | 'change'

const jwtPayload = t => JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
const cursorKey = () => 'snapdoc.cursor.' + (session ? session.uid : '');
const okKey = () => 'snapdoc.lastOk.' + (session ? session.uid : '');
const docLabel = d => (d.name || '').trim() || 'a document';
const newTag = () => uid().replace(/-/g, '').slice(0, 12);
const tick = () => { try { localStorage.setItem(TICK_KEY, Date.now() + '.' + Math.random()); } catch (e) {} };

// ---------- session (stored encrypted like everything else) ----------
async function loadSession() {
  session = null;
  try { const r = await idb.get('meta', 'session'); if (r) session = await Vault.openJson(r.data, 'sd|session'); } catch (e) { session = null; }
  if (session) await Vault.loadCloudKey(session.uid).catch(() => {});
}
async function storeSession() {
  if (session) await idb.put('meta', { id: 'session', data: await Vault.sealJson(session, 'sd|session') }); else await idb.del('meta', 'session');
  tick();
}
// Tokens from a sign-in link. Accepted only when this browser asked for a link within the last
// hour, nobody is signed in, and the cloud confirms the token. Returns '' or the reason it was refused.
async function adoptLink(t) {
  let asked = 0; try { asked = +localStorage.getItem(LINK_KEY) || 0; localStorage.removeItem(LINK_KEY); } catch (e) {}
  if (!SYNC) return 'Cloud sync is not switched on in this version.';
  if (session) return 'A sign-in link was opened, but this device is already signed in. Sign out first to use another account.';
  if (!asked || Date.now() - asked > 3600000) return 'This sign-in link was not requested from this browser, or it is older than an hour. Request a new one in the menu.';
  let u, p;
  try {
    p = jwtPayload(t.access_token);
    const r = await fetch(SYNC.url + '/auth/v1/user', { credentials: 'omit', cache: 'no-store', headers: { apikey: SYNC.key, Authorization: 'Bearer ' + t.access_token } });
    if (!r.ok) return 'The sign-in link could not be confirmed. Request a new one in the menu.';
    u = await r.json();
  } catch (e) { return 'The sign-in link could not be confirmed (no connection). Request a new one in the menu.'; }
  if (!u || !u.id || u.id !== p.sub) return 'The sign-in link could not be confirmed. Request a new one in the menu.';
  session = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: p.exp, email: u.email || '', uid: u.id };
  await storeSession();
  if (localStorage.getItem(SYNCUID_KEY) !== session.uid) {       // first sign-in, or another account: this cloud knows nothing from here yet
    for (const d of docs) { d.srv = 0; d.pushed_rev = 0; d.pushed_tag = ''; d.up_rev = 0; d.up_tag = ''; d.row_rev = 0; d.seen = 0; d.cloudPurged = false; }
    cursors[session.uid] = 0; localStorage.removeItem(cursorKey()); localStorage.setItem(SYNCUID_KEY, session.uid);
    await Vault.dropCloudKey(); persist();
  }
  await Vault.loadCloudKey(session.uid).catch(() => {});
  return '';
}
async function signOut() {
  session = null; keyNeed = ''; keyEnv = null;
  await storeSession(); await Vault.dropCloudKey();
  setSyncState(''); renderAll();
}
async function ensureSession() {
  if (!SYNC || !session) return false;
  if (Date.now() / 1000 < session.expires_at - 60) return true;
  try {
    const r = await fetch(SYNC.url + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', credentials: 'omit', headers: { apikey: SYNC.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: session.refresh_token }) });
    if (!r.ok) {                                                  // another tab may have refreshed already; never sign out silently
      const mine = session.access_token; await loadSession();
      if (session && session.access_token !== mine && Date.now() / 1000 < session.expires_at - 60) return true;
      setSyncState('error', 'The sign-in has expired. Sign out and sign in again.'); return false;
    }
    const t = await r.json(), p = jwtPayload(t.access_token);
    if (!session || p.sub !== session.uid) return false;
    session = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: p.exp, email: session.email, uid: session.uid };
    await storeSession();
    return true;
  } catch (e) { return false; }
}
const api = (method, path, opts) => fetch(SYNC.url + path, { method, credentials: 'omit', cache: 'no-store',
  headers: Object.assign({ apikey: SYNC.key, Authorization: 'Bearer ' + session.access_token }, (opts && opts.headers) || {}), body: opts && opts.body });
async function httpError(what, r) {
  let t = ''; try { t = await r.text(); } catch (e) {}
  if (/PGRST205|Bucket not found|schema cache|does not exist/i.test(t) || (r.status === 404 && /rest\/v1/.test(r.url || '')))
    return new Error('The cloud is not set up yet. Run supabase-schema.sql once in the Supabase SQL editor.');
  if (r.status === 413) return new Error(what + ' failed: the file is too large for the cloud.');
  return new Error(what + ' failed (' + r.status + ') ' + t.slice(0, 100));
}
// One-time step when the sync format changes: everything this device holds is sent again in the new
// form. What the device agreed on with the cloud (pushed_rev/pushed_tag) is kept, so the other
// devices recognise the re-sent versions as the ones they hold and do not fork copies. A version
// from before tags gets the same tag on every device.
function syncFormatCheck() {
  let f = ''; try { f = localStorage.getItem(FMT_KEY) || ''; } catch (e) {}
  if (f === SYNC_FMT) return;
  for (const d of docs) {
    if (d.srv > 0) d.srv = -1;
    d.row_rev = 0; d.seen = 0;
    if (!d.rtag) { d.rtag = 'v2'; if (d.pushed_rev === d.rev && !d.pushed_tag) d.pushed_tag = 'v2'; }
    if (!d.deleted && d.rev_have === d.rev && d.pages.length) { d.up_rev = 0; d.up_tag = ''; }
  }
  try { localStorage.setItem(FMT_KEY, SYNC_FMT); } catch (e) {}
  if (docs.length) persist();
}

// ---------- the encryption password ----------
async function ensureCloudKey() {
  if (Vault.hasCloudKey(session.uid)) return true;
  if (keyNeed) return false;                                      // waiting for the user
  const r = await api('GET', '/rest/v1/sd_keys?select=salt,iter,wrapped&user_id=eq.' + session.uid);
  if (!r.ok) throw await httpError('Checking the cloud', r);
  const rows = await r.json();
  keyEnv = rows[0] || null; keyNeed = keyEnv ? 'enter' : 'create';
  setSyncState('needkey');
  return false;
}
async function submitKey(pw, pw2, hint) {
  if (keyBusy) return;
  if (keyNeed !== 'enter') {
    if (pw.length < 10) { hint.textContent = 'Use at least 10 characters. A few random words work well.'; return; }
    if (pw !== pw2) { hint.textContent = 'The two entries differ.'; return; }
  } else if (!pw) return;
  keyBusy = true; hint.textContent = 'Working…';
  try {
    if (!(await ensureSession())) throw new Error('Not signed in.');
    const json = { 'Content-Type': 'application/json', Prefer: 'return=minimal' };
    if (keyNeed === 'create') {
      const ne = await Vault.newEnvelope(pw, session.uid);
      const r = await api('POST', '/rest/v1/sd_keys', { headers: json, body: JSON.stringify(Object.assign({ user_id: session.uid, created_at: Date.now() }, ne.env)) });
      if (r.status === 409) { keyNeed = ''; keyEnv = null; await ensureCloudKey(); toast('Another device set the password meanwhile. Enter that one.'); return; }
      if (!r.ok) throw await httpError('Saving the key', r);
      await ne.commit();                                          // kept only now that the cloud holds the envelope
    } else if (keyNeed === 'change') {
      const env = await Vault.rewrapEnvelope(pw, session.uid);
      const r = await api('PATCH', '/rest/v1/sd_keys?user_id=eq.' + session.uid, { headers: json, body: JSON.stringify(env) });
      if (!r.ok) throw await httpError('Saving the key', r);
      keyNeed = ''; toast('Encryption password changed'); renderSyncBox(); return;
    } else await Vault.openEnvelope(keyEnv, pw, session.uid);
    keyNeed = ''; keyEnv = null; setSyncState(''); toast('Encrypted sync is on'); renderAll(); syncNow();
  } catch (e) { hint.textContent = errText(e); }
  finally { keyBusy = false; }
}

// ---------- sync loop ----------
// Rules (version 4 of the format):
// - Every version of a document's pages is its own file in the cloud, named after the document and
//   the version's tag. A file is never replaced, so an entry can never point at a file another
//   device wrote over.
// - The entry is the only commit point. It is written with a condition on the server stamp the
//   device last saw; if another device wrote in between, the write fails, the entry is pulled and
//   the usual "both changed" rule decides (fork into a copy, never overwrite).
// - A file upload alone proves nothing: pushed_rev/pushed_tag mean "the cloud accepted an entry for
//   this version", up_rev/up_tag mean "this version's file is up".
// - The pull bookmark lives inside the encrypted document list and is stored together with it, so
//   it can never be ahead of the list.
function setSyncState(s, msg) { syncState = s; syncMsg = msg || ''; renderSyncLine(); renderSyncBox(); }
function scheduleSync() { if (!SYNC || !session || passive) return; clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 1500); }
let syncCtl = null; const upFail = new Map();           // upFail: document id -> { rev, tag, n, until } for uploads the cloud refused
function abortSync() { if (syncCtl) syncCtl.abort(); }
function syncRetry() { upFail.clear(); if (syncState === 'error') setSyncState(''); syncNow(); }      // "Sync now": refused uploads are tried again at once
const objName = (u, d, tag) => u + '/' + d.id + (tag ? '.' + tag : '');
const adoptCloud = (d, rev, tag, m) => { d.rev = rev; d.rtag = tag; d.pushed_rev = rev; d.pushed_tag = tag; d.up_rev = rev; d.up_tag = tag; d.pageCount = +m.pages || 0; d.size = +m.size || 0; };
// Both this device and another one changed the pages since they last agreed. Nothing is
// overwritten: the version of this device lives on as a copy of its own.
function forkLocal(d) {
  const mine = d.pages.filter(p => !p.status && !p.local); if (!mine.length) return;
  const now = Date.now(), name = (d.name || '').trim() || dateStamp(d.created_at);
  const c = migrate({ id: uid(), name: name + ' (copy from this device)', created_at: d.created_at, updated_at: now, srv: 0, pages: mine, pageCount: mine.length,
    size: mine.reduce((a, p) => a + (p.size || 0), 0), rev: now, rtag: newTag(), rev_have: now, pushed_rev: 0, up_rev: 0, deleted: false });
  docs.push(c); snap[c.id] = sigOf(c);
  d.pages = d.pages.filter(p => p.status || p.local);
  for (const p of mine) dropPrev(p.id);
  idb.del('pdfs', d.id).catch(() => {});
  thumbGet(d.id).then(t => thumbPut(c.id, t)).catch(() => {});
  toast('"' + name + '" was changed on another device too. Your version is kept as a copy.');
}
// One entry from the cloud. Returns 'legacy' for entries written before they were sealed.
async function applyRow(row) {
  const id = String(row.id), rev = +row.rev || 0, upd = +row.updated_at || 0, del = !!row.deleted, stamp = +row.synced_at || 0;
  const d0 = byId(id);
  if (!d0 && del) return 'skip';                                  // a delete marker for something this device never had
  if (!row.meta) return 'legacy';
  const m = await Vault.copenJson(row.meta, 'sd|meta|' + id);     // throws unless it was sealed with our cloud key for this document
  if (m.u === undefined) return 'legacy';
  if (!!m.del !== del || +m.u !== upd || (!del && +m.rev !== rev)) throw new Error('entry does not match its seal');
  const tag = del ? '' : String(m.tag || '');
  if (!d0) {
    const n = migrate({ id, name: String(m.name || ''), created_at: +m.created_at || upd, updated_at: upd, srv: upd, pages: [], pageCount: +m.pages || 0, size: +m.size || 0,
      rev, rtag: tag, rev_have: -1, pushed_rev: rev, pushed_tag: tag, up_rev: rev, up_tag: tag, row_rev: rev, seen: stamp, deleted: false });
    docs.push(n); snap[id] = sigOf(n); return 'new';
  }
  const d = d0, before = sigOf(d), wasDeleted = d.deleted;
  d.row_rev = rev; d.seen = stamp;
  if (!del) {
    if (wasDeleted && upd > d.updated_at) {                       // it comes back: its pages were removed here, there is nothing local to keep
      adoptCloud(d, rev, tag, m); d.rev_have = -1; d.cloudPurged = false;
    } else {                                                      // pages: has the cloud moved on from what this device last agreed with?
      const cloudNew = rev > d.pushed_rev || (rev === d.pushed_rev && !!tag && !!d.pushed_tag && tag !== d.pushed_tag);
      if (cloudNew) {
        const inSync = d.rev === d.pushed_rev && (d.rtag || '') === (d.pushed_tag || '');
        if (!inSync && !wasDeleted && d.rev_have === d.rev && !(d.rev === rev && (d.rtag || '') === tag)) forkLocal(d);
        const holdsIt = d.rev_have === rev && (d.rtag || '') === tag && d.rev === rev;
        adoptCloud(d, rev, tag, m);
        if (!holdsIt) d.rev_have = -1;                            // the pages here are not that version: download
      } else if (rev < d.pushed_rev && !wasDeleted) {             // the cloud went back to older pages (a device that never saw ours brought it back)
        if (d.rev_have === d.rev && d.pages.some(p => !p.status)) { d.pushed_rev = rev; d.pushed_tag = tag; d.up_rev = 0; d.up_tag = ''; }   // ours is newer: file and entry go up again
        else { adoptCloud(d, rev, tag, m); d.rev_have = -1; }
      }
    }
  }
  if (upd > d.updated_at) {                                       // name and deletion: the later change wins
    if (!del) { d.name = String(m.name || ''); d.created_at = +m.created_at || d.created_at; }
    d.deleted = del; d.updated_at = upd; d.srv = upd;
    if (del && !wasDeleted) await deletedElsewhere(d);
  } else if (upd === d.updated_at) d.srv = upd;
  else if (del && !d.deleted) {                                   // our later change keeps the document, but the other device removed the file
    if (d.pages.some(p => !p.status)) {                           // the pages here are the only ones left: they are the newest version and go up again
      if (d.rev_have !== d.rev) { d.rev = Math.max(Date.now(), d.rev + 1); d.rtag = newTag(); d.rev_have = d.rev; d.pageCount = d.pages.filter(p => !p.status).length; }
      d.pushed_rev = 0; d.pushed_tag = ''; d.up_rev = 0; d.up_tag = ''; d.srv = -1;
    } else { d.deleted = true; d.updated_at = upd; d.srv = upd; await deletedElsewhere(d); }
  } else { d.srv = -1; if (d.deleted) d.cloudPurged = false; }    // the cloud holds an older entry than ours (a late write replaced it): send ours again
  if (snap[id] === before) snap[id] = sigOf(d);                   // a local change that is not saved yet is never swallowed
  return 'ok';
}
// A delete from another device is applied here. Pages that only this device has (being scanned
// right now, or waiting to join a download) are never thrown away: they live on in a new document,
// the camera continues there, and the user is told. The view of the deleted document closes.
async function deletedElsewhere(d) {
  const keep = d.pages.filter(p => p.status || p.local), gone = d.pages.filter(p => !p.status && !p.local), wasCam = camDoc === d;
  d.pages = [];
  let n = null;
  if (keep.length) {
    const now = Date.now();
    n = migrate({ id: uid(), name: '', created_at: now, updated_at: now, srv: 0, pages: keep.map(p => { const q = Object.assign({}, p); delete q.local; return q; }), rev: now, rtag: newTag(), rev_have: now, pushed_rev: 0, up_rev: 0, deleted: false });
    docs.unshift(n); snap[n.id] = sigOf(n); touchContent(n);
    if (camDoc === d) { camDoc = n; camFromDoc = false; camCount = keep.length; }
  } else if (camDoc === d) camDoc = null;                         // the next shot starts a new document
  const onIt = curDoc === d && stack.includes('doc'), onCam = camDoc === n && n && stack.includes('cam');
  if (onIt) {
    if (n) { curDoc = n; if (current() === 'doc') renderDoc(); }
    else if (!navPending) { navPending++; history.go(-(stack.length - stack.indexOf('doc'))); }
  }
  if (onIt || wasCam) toast(n ? 'This document was deleted on another device. The pages scanned here are kept in a new document.' : wasCam && !onIt ? 'This document was deleted on another device. New pages go into a new document.' : 'This document was deleted on another device.');
  await purgeDocData(d, gone);
}
const sealedMeta = d => Vault.csealJson(d.deleted ? { del: true, u: d.updated_at }
  : { name: d.name, pages: d.pages.filter(p => !p.status && !p.local).length || d.pageCount || 0, size: d.size || 0, created_at: d.created_at, rev: d.up_rev || 0, tag: d.up_tag || '', u: d.updated_at, del: false }, 'sd|meta|' + d.id);
// does the cloud entry of this document have to be written?
const entryDue = d => d.deleted ? ((d.srv !== 0 || d.pushed_rev > 0) && d.srv !== d.updated_at)
  : d.up_rev > 0 && (d.up_rev !== d.pushed_rev || (d.up_tag || '') !== (d.pushed_tag || '') || d.updated_at !== d.srv);
// One conditional write of the entry. true: accepted. false: another device wrote first (the entry is pulled again).
async function writeEntry(d, u) {
  const row = { id: d.id, user_id: u, rev: d.deleted ? 0 : (d.up_rev || 0), updated_at: d.updated_at, deleted: !!d.deleted, meta: await sealedMeta(d) };
  const headers = { 'Content-Type': 'application/json', Prefer: 'return=representation' };
  const r = d.seen ? await api('PATCH', '/rest/v1/sd_documents?select=synced_at&user_id=eq.' + u + '&id=eq.' + encodeURIComponent(d.id) + '&synced_at=eq.' + d.seen, { headers, body: JSON.stringify(row) })
    : await api('POST', '/rest/v1/sd_documents?select=synced_at', { headers, body: JSON.stringify(row) });
  if (r.status === 409) return false;
  if (!r.ok) throw await httpError('Saving the list', r);
  const out = await r.json(); if (!Array.isArray(out) || !out.length) return false;
  d.seen = +out[0].synced_at || d.seen; d.row_rev = row.rev;
  if (d.updated_at === row.updated_at) d.srv = d.updated_at;
  if (!d.deleted) { d.pushed_rev = row.rev; d.pushed_tag = d.up_tag || ''; }
  return true;
}
async function pullOne(d, u) {                                    // the cloud's entry for one document, applied here
  const r = await api('GET', '/rest/v1/sd_documents?select=id,meta,rev,updated_at,deleted,synced_at&user_id=eq.' + u + '&id=eq.' + encodeURIComponent(d.id));
  if (!r.ok) throw await httpError('Loading the entry', r);
  const rows = await r.json(); if (rows.length) await applyRow(rows[0]); else d.seen = 0;
}
async function syncNow() {
  if (!SYNC || !session || !Vault.isOpen() || locked || passive) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true; syncCtl = new AbortController();
  const ctl = syncCtl;
  try {
    if (!(await ensureSession())) return;
    if (!(await ensureCloudKey())) return;
    const u = session.uid, stop = () => !session || session.uid !== u || passive || locked || !isOwner() || ctl.signal.aborted;
    if (cursors[u] == null) { let old = 0; try { old = +localStorage.getItem(cursorKey()) || 0; localStorage.removeItem(cursorKey()); } catch (e) {} cursors[u] = old; }      // from a version that kept it outside the list
    const cursor = cursors[u] || 0, from = Math.max(0, cursor - 3000);
    let maxSeen = cursor, unreadable = 0;
    for (let off = 0; ; off += 500) {                             // pull what changed since the last visit (small overlap: entries are idempotent)
      const r = await api('GET', '/rest/v1/sd_documents?select=id,meta,rev,updated_at,deleted,synced_at&synced_at=gt.' + from + '&order=synced_at.asc,id.asc&limit=500&offset=' + off);
      if (!r.ok) throw await httpError('Loading the list', r);
      const rows = await r.json();
      for (const row of rows) { maxSeen = Math.max(maxSeen, +row.synced_at || 0); try { await applyRow(row); } catch (e) { unreadable++; } }
      if (rows.length < 500) break;
    }
    if (stop()) return;
    if (maxSeen > cursor) { cursors[u] = maxSeen; if (!(await persist())) { cursors[u] = cursor; throw new Error('The document list could not be saved.'); } }   // the bookmark moves only with the list
    let upFailed = 0, upWhy = '';
    for (const d of docs.slice()) {                               // upload the files of versions made here; one failing document does not hold up the rest
      if (stop()) return;
      if (d.deleted || d.rev_have !== d.rev || !d.pages.length || d.pages.some(p => p.status || p.local)) continue;
      if (!d.rtag) d.rtag = newTag();
      if (d.rev === d.up_rev && d.rtag === (d.up_tag || '')) continue;
      const f = upFail.get(d.id);
      if (f && f.rev === d.rev && f.tag === d.rtag && Date.now() < f.until) { upFailed++; upWhy = f.why; continue; }      // refused before: tried again later, not on every pass
      const rev = d.rev, tag = d.rtag;
      try {
        if ((d.size || 0) + 4096 > MAX_FILE) throw new Error('"' + docLabel(d) + '" is larger than 50 MB and cannot be synced. Split it into smaller documents.');
        if (!(await ensureSession())) return;
        setSyncState('busy', 'Uploading ' + docLabel(d));
        const pdf = await getPdf(d);
        if (stop()) return;
        if (d.rev !== rev || d.rtag !== tag) continue;            // changed while the PDF was built: next pass
        const head = utf8(JSON.stringify({ rev, tag }));
        if (4 + head.length + pdf.size + 28 > MAX_FILE) throw new Error('"' + docLabel(d) + '" is larger than 50 MB and cannot be synced. Split it into smaller documents.');
        const plain = new Uint8Array(4 + head.length + pdf.size);
        new DataView(plain.buffer).setUint32(0, head.length); plain.set(head, 4); plain.set(new Uint8Array(await pdf.arrayBuffer()), 4 + head.length);
        const body = await Vault.cseal(plain, 'sd|file2|' + d.id);
        if (stop()) return;
        const r = await api('POST', '/storage/v1/object/sd/' + objName(u, d, tag), { headers: { 'Content-Type': 'application/octet-stream' }, body });
        let ok = r.ok;
        if (!ok && (r.status === 409 || r.status === 400)) { const t = await r.text().catch(() => ''); ok = /exist|duplicate/i.test(t); }      // this version is up already (an earlier pass, or another window)
        if (!ok) throw await httpError('Uploading "' + docLabel(d) + '"', r);
        if (d.rev === rev && d.rtag === tag) { d.up_rev = rev; d.up_tag = tag; }
        upFail.delete(d.id); persist();                           // progress survives the app being closed
      } catch (e) {
        upFailed++; upWhy = errText(e);
        if (e instanceof TypeError || navigator.onLine === false || ctl.signal.aborted) break;      // no connection: do not try the others now
        const n = (f && f.rev === rev && f.tag === tag ? f.n : 0) + 1;
        upFail.set(d.id, { rev, tag, n, why: upWhy, until: Date.now() + Math.min(3600000, 60000 * Math.pow(4, n - 1)) });
      }
    }
    if (stop()) return;
    let entryFailed = 0, entryWhy = '';
    for (const d of docs.slice()) {                               // write the entries that changed here, each one conditionally; one entry that cannot be read does not hold up the rest
      if (!entryDue(d)) continue;
      if (stop()) return;
      const wasTag = d.pushed_tag || '', wasRev = d.pushed_rev || 0, upTag = d.up_tag || '', upRev = d.up_rev || 0;
      try {
        let done = await writeEntry(d, u);
        if (!done) {                                              // another device was first: take its entry, then try once more
          await pullOne(d, u); if (stop()) return;
          if (!d.deleted && upRev && (d.up_rev !== upRev || (d.up_tag || '') !== upTag) && !(upRev === d.pushed_rev && upTag === (d.pushed_tag || ''))) {
            try { await api('DELETE', '/storage/v1/object/sd/' + objName(u, d, upTag)); } catch (e) {}      // the file this device sent belongs to the version that lost; its pages live on in the copy
          }
          if (entryDue(d)) done = await writeEntry(d, u);
        }
        if (done && !d.deleted && wasRev && (wasTag !== (d.pushed_tag || '') || wasRev !== d.pushed_rev)) {       // the file of the version before is no longer referenced
          try { await api('DELETE', '/storage/v1/object/sd/' + objName(u, d, wasTag)); } catch (e) {}
        }
      } catch (e) {
        entryFailed++; entryWhy = errText(e);
        if (e instanceof TypeError || navigator.onLine === false || ctl.signal.aborted) break;
      }
    }
    for (const d of docs) if (d.deleted && !d.cloudPurged && d.srv === d.updated_at) {     // the file of a deleted document goes too; counted as done only when the cloud confirms
      if (stop()) return;
      try {
        const c = await api('GET', '/rest/v1/sd_documents?select=updated_at,deleted&user_id=eq.' + u + '&id=eq.' + encodeURIComponent(d.id));
        if (!c.ok) continue;
        const cur = (await c.json())[0];
        if (cur && (!cur.deleted || +cur.updated_at !== d.updated_at)) continue;      // the cloud moved on meanwhile: not ours to remove
        let gone = true;
        const names = [objName(u, d, d.pushed_tag || ''), objName(u, d, '')]; if (d.up_tag && d.up_tag !== d.pushed_tag) names.push(objName(u, d, d.up_tag));      // a file this device sent for a version that never got its entry
        for (const name of names) {
          if (stop()) return;
          const r = await api('DELETE', '/storage/v1/object/sd/' + name);
          let ok = r.ok || r.status === 404;
          if (!ok && r.status === 400) ok = /not.?found/i.test(await r.text().catch(() => ''));
          if (!ok) gone = false;
        }
        if (gone) d.cloudPurged = true;
      } catch (e) {}
    }
    if (stop()) return;
    try { localStorage.setItem(okKey(), String(Date.now())); } catch (e) {}
    if (!(await persist())) throw new Error('The document list could not be saved.');
    renderAll();
    let failed = 0, why = '';
    for (const d of docs.slice()) {                               // download what is newer in the cloud
      if (stop()) return;
      if (d.deleted || hasContent(d) || d.pushed_rev < d.rev) continue;
      try { if (!(await ensureSession())) return; await downloadDoc(d, u); } catch (e) { failed++; why = errText(e); }
    }
    if (unreadable) throw new Error(unreadable + (unreadable === 1 ? ' entry' : ' entries') + ' in the cloud cannot be opened with the key on this device.');
    if (upFailed) throw new Error(upFailed === 1 ? upWhy : upFailed + ' documents could not be uploaded. Last reason: ' + upWhy);
    if (entryFailed) throw new Error(entryFailed === 1 ? entryWhy : entryFailed + ' entries could not be saved. Last reason: ' + entryWhy);
    if (failed) throw new Error('Could not download ' + failed + (failed === 1 ? ' document: ' : ' documents: ') + why);
    setSyncState('ok');
  } catch (e) {
    if (session && !passive && !ctl.signal.aborted) setSyncState(navigator.onLine === false ? 'offline' : 'error', errText(e));
  } finally { syncing = false; if (syncCtl === ctl) syncCtl = null; if (syncAgain) { syncAgain = false; scheduleSync(); } afterNav(); }
}
async function downloadDoc(d, u) {
  if (ed && ed.doc === d) return;                                 // being edited right now: next round
  setSyncState('busy', 'Downloading ' + docLabel(d));
  const rev = d.rev, tag = d.rtag || '';
  let r = await api('GET', '/storage/v1/object/authenticated/sd/' + objName(u, d, tag));
  if (r.status === 404 && tag) r = await api('GET', '/storage/v1/object/authenticated/sd/' + objName(u, d, ''));      // written before version 4 of the format
  if (!r.ok) throw await httpError('Downloading "' + docLabel(d) + '"', r);
  const buf = await r.arrayBuffer();
  let plain, fileRev = rev, fileTag = tag;
  try {
    const p = new Uint8Array(await Vault.copen(buf, 'sd|file2|' + d.id)), hl = new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(0);
    const h = JSON.parse(new TextDecoder().decode(p.subarray(4, 4 + hl)));
    fileRev = +h.rev || 0; fileTag = String(h.tag || ''); plain = p.subarray(4 + hl);
  } catch (e) {
    try { plain = new Uint8Array(await Vault.copen(buf, 'sd|file|' + d.id)); } catch (e2) { throw new Error('the file cannot be decrypted'); }     // written before version 3
  }
  if (fileRev < rev) throw new Error('the cloud holds an older file than its entry says');      // refused; tried again next round
  const res = await task({ cmd: 'ingest', blob: new Blob([plain], { type: 'application/pdf' }) });
  if (!res.pages.length) throw new Error('the file holds no pages');
  const pages = [];
  for (const pg of res.pages) { const id = uid(); await pagePut(id, d.id, { jpeg: pg.jpeg, prev: pg.prev, orig: null, meta: { w: pg.w, h: pg.h, thumb: pg.thumb } }); pages.push({ id, w: pg.w, h: pg.h, size: pg.jpeg.size }); }
  if (d.deleted || d.rev !== rev || (d.rtag || '') !== tag || !docs.includes(d) || passive) { for (const p of pages) await idb.del('pages', p.id).catch(() => {}); return; }      // changed meanwhile
  // decided in one step, before anything is awaited: which pages stay (being scanned here right now) and which records go
  const old = d.pages, keep = old.filter(p => p.status || p.local), gone = old.filter(p => !p.status && !p.local), before = sigOf(d);
  d.pages = pages.concat(keep); d.pageCount = pages.length; d.size = pages.reduce((a, p) => a + p.size, 0);
  d.rev = fileRev; d.rtag = fileTag; d.rev_have = fileRev; d.pushed_rev = fileRev; d.pushed_tag = fileTag; d.up_rev = fileRev; d.up_tag = fileTag;
  if (snap[d.id] === before) snap[d.id] = sigOf(d);               // a version change nobody made here is not a change to send
  for (const p of gone) { await idb.del('pages', p.id).catch(() => {}); dropPrev(p.id); }
  await thumbPut(d.id, res.pages[0].thumb);
  await idb.del('pdfs', d.id).catch(() => {});                    // the PDF is rebuilt here with this device's page size and the current name
  if (keep.some(p => p.local && !p.status)) { for (const p of d.pages) delete p.local; touchContent(d); save(); }
  else persist();
  renderAll();
}
async function sendMagicLink(email) {
  const redirect = encodeURIComponent(location.origin + location.pathname);
  let r;
  try { r = await fetch(SYNC.url + '/auth/v1/otp?redirect_to=' + redirect, { method: 'POST', credentials: 'omit', headers: { apikey: SYNC.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, create_user: true }) }); }
  catch (e) { return { ok: false, msg: navigator.onLine === false ? 'No internet connection. Try again when you are online.' : 'The cloud could not be reached. Try again later.' }; }
  if (r.ok) { try { localStorage.setItem(LINK_KEY, String(Date.now())); } catch (e) {} return { ok: true }; }
  let msg = 'Sending failed. Try again later.';
  if (r.status === 429) msg = 'Too many sign-in mails in a short time. Try again in about an hour.';
  else { try { const j = await r.json(); if (j.msg || j.error_description) msg = 'Sending failed: ' + (j.msg || j.error_description); } catch (e) {} }
  return { ok: false, msg };
}

// ---------- status line and the sync part of the menu ----------
function lastOkLabel() {
  const okAt = +localStorage.getItem(okKey()) || 0; if (!okAt) return 'never';
  const m = Math.floor((Date.now() - okAt) / 60000);
  return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.floor(m / 60) + ' h ago';
}
function renderSyncLine() {
  const el = $('syncline'); el.className = 'subline';
  if (drive && driveState === 'reconnect' && drivePending().length) { el.className = 'subline err'; el.textContent = 'Google Drive needs a tap to reconnect · tap here'; return; }
  if (!SYNC) { el.textContent = 'Encrypted on this device'; return; }
  if (!session) { el.textContent = 'Encrypted on this device · tap to add cloud sync'; return; }
  if (!Vault.hasCloudKey(session.uid)) {
    el.className = 'subline err';
    el.textContent = syncState === 'error' ? '⚠ ' + syncMsg : keyNeed ? 'Cloud sync is waiting for your encryption password · tap here' : 'Connecting to the cloud…';
    return;
  }
  if (syncState === 'error') { el.className = 'subline err'; el.textContent = '⚠ Sync failed · last success ' + lastOkLabel() + ' · tap for details'; return; }
  if (syncState === 'offline') { el.textContent = '⏸ Offline · last synced ' + lastOkLabel(); return; }
  if (syncState === 'busy') { el.textContent = '↻ ' + syncMsg + '…'; return; }
  el.textContent = +localStorage.getItem(okKey()) ? '✓ Encrypted sync on · last synced ' + lastOkLabel() : 'Connecting to the cloud…';
}
$('syncline').addEventListener('click', () => openSheet());
function renderSyncBox() {
  const box = $('syncBox'); if (!box) return;
  const hasKey = !!session && Vault.hasCloudKey(session.uid);
  const mode = !SYNC ? 'none' : !session ? 'signin' : keyNeed === 'change' ? 'change' : hasKey ? 'on' : keyNeed || 'check';
  if (box.dataset.mode === mode && ['signin', 'create', 'enter', 'change'].includes(mode)) return;      // never wipe a form someone is typing in
  box.dataset.mode = mode;
  const signOutBtn = '<button id="signOut" class="btn quiet">Sign out on this device</button>';
  if (mode === 'none') { box.innerHTML = '<p>Cloud sync is not switched on in this version yet. Your scans stay on this device, encrypted.</p>'; return; }
  if (mode === 'signin') {
    box.innerHTML = '<p>Keep an encrypted copy of your PDFs in your cloud account and open them on a second phone or the PC. Sign in by e-mail, without a password.</p>' +
      '<input id="email" type="email" placeholder="you@example.com" autocomplete="email"><button id="sendLink" class="btn primary">Send sign-in link</button><div class="hint" id="authHint"></div>';
    let sending = false;
    $('sendLink').addEventListener('click', async () => {
      const email = $('email').value.trim(), hint = $('authHint');
      if (sending) return;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { hint.textContent = 'Please enter a valid e-mail address.'; return; }
      sending = true; hint.textContent = 'Sending…';
      try { const r = await sendMagicLink(email); hint.textContent = r.ok ? 'The mail is on its way. Open the link in it in this same browser on this device; the app continues by itself.' : r.msg; }
      catch (e) { hint.textContent = 'Sending failed: ' + errText(e); } finally { sending = false; }
    });
    return;
  }
  if (mode === 'check') {
    box.innerHTML = '<div class="statecard' + (syncState === 'error' ? ' err' : '') + '"><div class="t">Signed in as ' + esc(session.email || '') + '</div><div class="s">' + (syncState === 'error' ? esc(syncMsg) : 'Checking the cloud…') + '</div></div>' +
      '<button id="syncBtn" class="btn">Try again</button>' + signOutBtn;
  } else if (mode === 'create' || mode === 'change') {
    box.innerHTML = '<p>' + (mode === 'create' ? '<b>Choose an encryption password.</b> Your PDFs are encrypted on this phone before they are uploaded, so nobody else can read them, not even the cloud provider.' : '<b>New encryption password.</b> Other devices ask for it the next time they set up sync.') +
      ' It is needed once on each new device. It cannot be reset: without it the cloud copies cannot be opened.</p>' +
      '<input id="pw1" type="password" autocomplete="new-password" placeholder="Encryption password"><input id="pw2" type="password" autocomplete="new-password" placeholder="Repeat">' +
      '<button id="pwSuggest" class="btn">Suggest a strong one</button><button id="pwGo" class="btn primary">' + (mode === 'create' ? 'Turn on encrypted sync' : 'Change password') + '</button><div class="hint" id="pwHint"></div>' +
      (mode === 'create' ? signOutBtn : '<button id="pwCancel" class="btn quiet">Cancel</button>');
    $('pwSuggest').addEventListener('click', () => { const s = Vault.suggestPassword(); for (const id of ['pw1', 'pw2']) { $(id).type = 'text'; $(id).value = s; } $('pwHint').textContent = 'Save it in your password manager now, before you continue.'; });
    $('pwGo').addEventListener('click', () => submitKey($('pw1').value, $('pw2').value, $('pwHint')));
    if (mode === 'change') $('pwCancel').addEventListener('click', () => { keyNeed = ''; renderSyncBox(); });
  } else if (mode === 'enter') {
    box.innerHTML = '<p><b>Enter your encryption password.</b> It is the one you chose when you first turned on sync. It unlocks your scans on this device and is never sent anywhere.</p>' +
      '<input id="pw1" type="password" autocomplete="current-password" placeholder="Encryption password"><button id="pwGo" class="btn primary">Unlock sync</button><div class="hint" id="pwHint"></div>' + signOutBtn;
    $('pwGo').addEventListener('click', () => submitKey($('pw1').value, '', $('pwHint')));
    $('pw1').addEventListener('keydown', e => { if (e.key === 'Enter') submitKey($('pw1').value, '', $('pwHint')); });
  } else {
    const err = syncState === 'error', off = syncState === 'offline';
    const waiting = docs.filter(d => !d.deleted && (d.pushed_rev < d.rev || !hasContent(d) || rowBehind(d))).length;
    box.innerHTML = '<div class="statecard' + (err ? ' err' : '') + '"><div class="t">' + (err ? '⚠ Sync has a problem' : off ? '⏸ Offline' : syncState === 'busy' ? '↻ ' + esc(syncMsg) : '✓ Encrypted sync on') + '</div>' +
      '<div class="s">Signed in as ' + esc(session.email || '') + '<br>Last synced ' + lastOkLabel() + (waiting ? ' · ' + waiting + ' waiting' : '') + (err && syncMsg ? '<br>' + esc(syncMsg) : '') + '</div></div>' +
      '<button id="syncBtn" class="btn">Sync now</button><button id="pwChange" class="btn quiet">Change encryption password</button>' + signOutBtn;
    $('pwChange').addEventListener('click', () => { keyNeed = 'change'; renderSyncBox(); });
  }
  if ($('syncBtn')) $('syncBtn').addEventListener('click', syncRetry);
  if ($('signOut')) $('signOut').addEventListener('click', () => popup('Sign out on this device?', 'Your scans stay on this phone. They stop syncing until you sign in and enter your encryption password again.', [{ label: 'Sign out', fn: signOut }, { label: 'Stay signed in', cls: 'quiet' }]));
}
