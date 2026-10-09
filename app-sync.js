'use strict';
/* Snapdoc cloud sync: local-first, optional. Sign-in by e-mail link (no password), then an
   encryption password that never leaves the device. The cloud only ever receives ciphertext:
   one encrypted PDF per document and one row whose name and details are encrypted too. */
const SYNCUID_KEY = 'snapdoc.syncUid';
let session = null, syncTimer = null, syncing = false, syncAgain = false, syncState = '', syncMsg = '';
let keyNeed = '', keyEnv = null, keyBusy = false;      // keyNeed: '' | 'create' | 'enter' | 'change'

const jwtPayload = t => JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
const cursorKey = () => 'snapdoc.cursor.' + (session ? session.uid : '');
const okKey = () => 'snapdoc.lastOk.' + (session ? session.uid : '');
const docLabel = d => (d.name || '').trim() || 'a document';
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
function sessionFrom(t) { const p = jwtPayload(t.access_token); return { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: p.exp, email: p.email, uid: p.sub }; }
async function adoptSession(t) {
  session = sessionFrom(t); await storeSession();
  if (localStorage.getItem(SYNCUID_KEY) !== session.uid) {       // first sign-in, or another account: this cloud knows nothing from here yet
    for (const d of docs) { d.srv = 0; d.pushed_rev = 0; d.cloudPurged = false; }
    localStorage.removeItem(cursorKey()); localStorage.setItem(SYNCUID_KEY, session.uid);
    await Vault.dropCloudKey(); persist();
  }
  await Vault.loadCloudKey(session.uid).catch(() => {});
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
    session = sessionFrom(await r.json()); await storeSession();
    return true;
  } catch (e) { return false; }
}
const api = (method, path, opts) => fetch(SYNC.url + path, { method, credentials: 'omit', cache: 'no-store',
  headers: Object.assign({ apikey: SYNC.key, Authorization: 'Bearer ' + session.access_token }, (opts && opts.headers) || {}), body: opts && opts.body });
async function httpError(what, r) {
  let t = ''; try { t = await r.text(); } catch (e) {}
  if (/PGRST205|Bucket not found|schema cache|does not exist/i.test(t) || (r.status === 404 && /rest\/v1/.test(r.url || '')))
    return new Error('The cloud is not set up yet. Run supabase-schema.sql once in the Supabase SQL editor.');
  return new Error(what + ' failed (' + r.status + ') ' + t.slice(0, 100));
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
  } catch (e) { hint.textContent = e.message || String(e); }
  finally { keyBusy = false; }
}

// ---------- sync loop ----------
function setSyncState(s, msg) { syncState = s; syncMsg = msg || ''; renderSyncLine(); renderSyncBox(); }
function scheduleSync() { if (!SYNC || !session) return; clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 1500); }
// One row from the cloud. Pages follow the higher revision; name and deletion follow the later change.
async function applyRow(row) {
  const id = String(row.id), rev = +row.rev || 0, upd = +row.updated_at || 0, del = !!row.deleted;
  let m = null;
  if (!del) m = await Vault.copenJson(row.meta, 'sd|meta|' + id);
  let d = byId(id);
  if (!d) {
    if (del) return;
    d = migrate({ id, name: String(m.name || ''), created_at: +m.created_at || upd, updated_at: upd, srv: upd, pages: [], pageCount: +m.pages || 0, size: +m.size || 0, rev, rev_have: 0, pushed_rev: rev, deleted: false });
    docs.push(d); snap[id] = sigOf(d); return;
  }
  if (rev > d.rev) { d.rev = rev; d.pushed_rev = rev; if (m) { d.pageCount = +m.pages || 0; d.size = +m.size || 0; } }
  else if (rev === d.rev && rev > d.pushed_rev) d.pushed_rev = rev;
  if (upd > d.updated_at) {
    if (m) { d.name = String(m.name || ''); d.created_at = +m.created_at || d.created_at; }
    d.deleted = del; d.updated_at = upd; d.srv = upd;
    if (del) { await purgeDocData(d); if (curDoc === d && current() === 'doc') { toast('This document was deleted on another device.'); back(); } }
  } else if (upd === d.updated_at) d.srv = upd;
  snap[id] = sigOf(d);
}
async function syncNow() {
  if (!SYNC || !session || !Vault.isOpen() || locked) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  try {
    if (!(await ensureSession())) return;
    if (!(await ensureCloudKey())) return;
    const u = session.uid, cursor = +localStorage.getItem(cursorKey()) || 0, from = Math.max(0, cursor - 3000);
    let maxSeen = cursor, unreadable = 0;
    for (let off = 0; ; off += 500) {                             // pull what changed since the last visit (small overlap: rows are idempotent)
      const r = await api('GET', '/rest/v1/sd_documents?select=id,meta,rev,updated_at,deleted,synced_at&synced_at=gt.' + from + '&order=synced_at.asc,id.asc&limit=500&offset=' + off);
      if (!r.ok) throw await httpError('Loading the list', r);
      const rows = await r.json();
      for (const row of rows) { maxSeen = Math.max(maxSeen, +row.synced_at || 0); try { await applyRow(row); } catch (e) { unreadable++; } }
      if (rows.length < 500) break;
    }
    for (const d of docs.slice()) {                               // upload PDFs whose pages changed here
      if (d.deleted || d.rev <= d.pushed_rev || d.rev_have !== d.rev || !d.pages.length || d.pages.some(p => p.status)) continue;
      setSyncState('busy', 'Uploading ' + docLabel(d));
      const rev = d.rev, pdf = await getPdf(d);
      const body = await Vault.cseal(await pdf.arrayBuffer(), 'sd|file|' + d.id);
      const r = await api('POST', '/storage/v1/object/sd/' + u + '/' + d.id, { headers: { 'Content-Type': 'application/octet-stream', 'x-upsert': 'true' }, body });
      if (!r.ok) throw await httpError('Uploading', r);
      d.pushed_rev = rev;
    }
    const dirty = docs.filter(d => d.updated_at !== d.srv && (d.deleted ? (d.srv > 0 || d.pushed_rev > 0) : d.pushed_rev > 0));
    for (let i = 0; i < dirty.length; i += 100) {                 // push rows that changed here
      const part = dirty.slice(i, i + 100), rows = [];
      for (const d of part) rows.push({ id: d.id, user_id: u, rev: d.pushed_rev || 0, updated_at: d.updated_at, deleted: !!d.deleted,
        meta: d.deleted ? '' : await Vault.csealJson({ name: d.name, pages: d.pages.filter(p => !p.status).length || d.pageCount || 0, size: d.size || 0, created_at: d.created_at }, 'sd|meta|' + d.id) });
      const r = await api('POST', '/rest/v1/sd_documents?on_conflict=user_id,id', { headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
      if (!r.ok) throw await httpError('Saving the list', r);
      part.forEach((d, k) => { if (d.updated_at === rows[k].updated_at) d.srv = d.updated_at; });
    }
    for (const d of docs) if (d.deleted && !d.cloudPurged && d.srv === d.updated_at) {     // the file of a deleted document goes too
      try { await api('DELETE', '/storage/v1/object/sd/' + u + '/' + d.id); } catch (e) {}
      d.cloudPurged = true;
    }
    localStorage.setItem(cursorKey(), String(maxSeen)); localStorage.setItem(okKey(), String(Date.now()));
    persist(); renderAll();
    let failed = 0, why = '';
    for (const d of docs.slice()) {                               // download what is newer in the cloud
      if (d.deleted || d.rev_have >= d.rev || d.pushed_rev < d.rev) continue;
      try { await downloadDoc(d, u); } catch (e) { failed++; why = e.message || String(e); }
    }
    if (unreadable) throw new Error(unreadable + (unreadable === 1 ? ' document' : ' documents') + ' in the cloud cannot be decrypted with the key on this device.');
    if (failed) throw new Error('Could not download ' + failed + (failed === 1 ? ' document: ' : ' documents: ') + why);
    setSyncState('ok');
  } catch (e) {
    setSyncState(navigator.onLine === false ? 'offline' : 'error', e.message || String(e));
  } finally { syncing = false; if (syncAgain) { syncAgain = false; scheduleSync(); } }
}
async function downloadDoc(d, u) {
  if (ed && curDoc === d) return;                                 // being edited right now: next round
  setSyncState('busy', 'Downloading ' + docLabel(d));
  const rev = d.rev;
  const r = await api('GET', '/storage/v1/object/authenticated/sd/' + u + '/' + d.id);
  if (!r.ok) throw await httpError('Downloading', r);
  let pdf; try { pdf = new Blob([await Vault.copen(await r.arrayBuffer(), 'sd|file|' + d.id)], { type: 'application/pdf' }); } catch (e) { throw new Error('the file cannot be decrypted'); }
  const res = await task({ cmd: 'ingest', blob: pdf });
  if (!res.pages.length) throw new Error('the file holds no pages');
  const pages = [];
  for (const pg of res.pages) { const id = uid(); await pagePut(id, d.id, { jpeg: pg.jpeg, prev: pg.prev, orig: null, meta: { w: pg.w, h: pg.h, thumb: pg.thumb } }); pages.push({ id, w: pg.w, h: pg.h, size: pg.jpeg.size }); }
  if (d.deleted || d.rev !== rev) { for (const p of pages) await idb.del('pages', p.id).catch(() => {}); return; }      // changed meanwhile
  const old = d.pages;
  d.pages = pages; d.pageCount = pages.length; d.size = pages.reduce((a, p) => a + p.size, 0); d.rev_have = rev;
  for (const p of old) { await idb.del('pages', p.id).catch(() => {}); dropPrev(p.id); }
  await thumbPut(d.id, res.pages[0].thumb);
  await pdfPut(d.id, rev + '|' + settings.pageSize + '|' + (d.name || '').trim(), pdf);
  persist(); renderAll();
}
async function sendMagicLink(email) {
  const redirect = encodeURIComponent(location.origin + location.pathname);
  const r = await fetch(SYNC.url + '/auth/v1/otp?redirect_to=' + redirect, { method: 'POST', credentials: 'omit', headers: { apikey: SYNC.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, create_user: true }) });
  if (r.ok) return { ok: true };
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
    $('sendLink').addEventListener('click', async () => {
      const email = $('email').value.trim(), hint = $('authHint');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { hint.textContent = 'Please enter a valid e-mail address.'; return; }
      hint.textContent = 'Sending…';
      const r = await sendMagicLink(email);
      hint.textContent = r.ok ? 'The mail is on its way. Open the link in it on this phone; the app continues by itself.' : r.msg;
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
    const waiting = docs.filter(d => !d.deleted && (d.pushed_rev < d.rev || d.rev_have < d.rev || d.updated_at !== d.srv)).length;
    box.innerHTML = '<div class="statecard' + (err ? ' err' : '') + '"><div class="t">' + (err ? '⚠ Sync has a problem' : off ? '⏸ Offline' : syncState === 'busy' ? '↻ ' + esc(syncMsg) : '✓ Encrypted sync on') + '</div>' +
      '<div class="s">Signed in as ' + esc(session.email || '') + '<br>Last synced ' + lastOkLabel() + (waiting ? ' · ' + waiting + ' waiting' : '') + (err && syncMsg ? '<br>' + esc(syncMsg) : '') + '</div></div>' +
      '<button id="syncBtn" class="btn">Sync now</button><button id="pwChange" class="btn quiet">Change encryption password</button>' + signOutBtn;
    $('pwChange').addEventListener('click', () => { keyNeed = 'change'; renderSyncBox(); });
  }
  if ($('syncBtn')) $('syncBtn').addEventListener('click', () => { if (syncState === 'error') setSyncState(''); syncNow(); });
  if ($('signOut')) $('signOut').addEventListener('click', () => popup('Sign out on this device?', 'Your scans stay on this phone. They stop syncing until you sign in and enter your encryption password again.', [{ label: 'Sign out', fn: signOut }, { label: 'Stay signed in', cls: 'quiet' }]));
}
