'use strict';
/* Snapdoc Google Drive copies: optional. Once the user has connected a Google account, every
   document is kept as a plain PDF in a folder "Snapdoc" of that account, uploaded from the device
   right after a scan and updated after a rename or a page change; a deleted document goes to the
   Drive bin. The PDFs are readable in Drive (that is their purpose); the way there is HTTPS.

   The app asks Google only for the right to see and change files it created itself
   (scope drive.file). No Google script is loaded: the sign-in is a plain redirect to Google and
   back, and the uploads are requests to the Drive interface. The access token lives one hour and
   is stored encrypted like everything else; when it has run out and there is something to upload,
   the app reconnects by itself (a redirect without any screen), or asks for a tap when a lock is on. */
const DRIVE = CFG.googleClientId ? { clientId: String(CFG.googleClientId), api: 'https://www.googleapis.com', auth: 'https://accounts.google.com/o/oauth2/v2/auth', revoke: 'https://oauth2.googleapis.com/revoke', scope: 'https://www.googleapis.com/auth/drive.file', folder: 'Snapdoc' } : null;
const DRIVE_STATE = 'snapdoc-drive', DRIVE_NONCE_KEY = 'snapdoc.driveNonce', DRIVE_SILENT_KEY = 'snapdoc.driveSilent', DRIVE_SILENT_N = 'snapdoc.driveSilentN', DRIVE_MULTIPART_MAX = 5 * 1024 * 1024;
let drive = null;                 // { email, token, exp, folderId } once connected; stored encrypted in meta 'drive'
let driveTimer = null, driveBusy = false, driveAgain = false, driveState = '', driveMsg = '', driveTried = false;
const driveFail = new Map();      // document id -> { rev, name, n, until, why }: a document Google refused is tried again later, not on every pass
let driveGo = url => location.assign(url);           // the redirect to Google (replaced in tests)

async function loadDrive() {
  drive = null;
  if (!DRIVE) return;
  try { const r = await idb.get('meta', 'drive'); if (r) drive = await Vault.openJson(r.data, 'sd|drive'); } catch (e) { drive = null; }
}
async function storeDrive() {
  if (drive) await idb.put('meta', { id: 'drive', data: await Vault.sealJson(drive, 'sd|drive') }); else await idb.del('meta', 'drive');
}
const driveRedirect = () => location.origin + location.pathname.replace(/index\.html$/, '');
const driveTokenOk = () => !!(drive && drive.token && drive.exp > Date.now() + 60000);
// documents that still have to go to Drive, or whose copy must be renamed, or trashed
function drivePending() {
  return docs.filter(d => d.deleted ? !!d.drive : hasContent(d) && d.pages.some(p => !p.status) && (!d.drive || d.drive.rev < d.rev || d.drive.name !== fileName(d)));
}
// Off to Google. silent: no screen, only works when the user is still signed in to Google in this browser.
function driveConnect(silent) {
  if (!DRIVE || passive) return;
  if (persistQueued || persistFailed) { persistChain.then(ok => { if (ok) driveConnect(silent); else if (!silent) toast('The document list could not be saved; try again.'); }); return; }      // never leave with a write still queued or refused
  const nonce = uid();
  try { sessionStorage.setItem(DRIVE_NONCE_KEY, nonce); } catch (e) { toast('This browser blocks session storage; Google Drive cannot be connected here.'); return; }
  const p = new URLSearchParams({ client_id: DRIVE.clientId, redirect_uri: driveRedirect(), response_type: 'token', scope: DRIVE.scope, state: DRIVE_STATE + '.' + nonce, include_granted_scopes: 'true' });
  if (silent) p.set('prompt', 'none'); if (drive && drive.email) p.set('login_hint', drive.email);
  try { sessionStorage.setItem(RESUME_KEY, curDoc ? curDoc.id : ''); } catch (e) {}
  driveGo(DRIVE.auth + '?' + p.toString());
}
// Back from Google with the token (or an error) in the URL fragment. Returns a message for the user, or ''.
async function driveAdopt(qp) {
  let nonce = ''; try { nonce = sessionStorage.getItem(DRIVE_NONCE_KEY) || ''; sessionStorage.removeItem(DRIVE_NONCE_KEY); } catch (e) {}
  if (!DRIVE) return 'Google Drive is not set up in this version.';
  if (!nonce || qp.get('state') !== DRIVE_STATE + '.' + nonce) return '';          // a reply this browser did not ask for is ignored, whatever it says
  if (qp.get('error')) {                                                              // a few fixed sentences, never the sender's text
    const err = qp.get('error'), silent = err === 'interaction_required' || err === 'login_required' || err === 'consent_required';
    if (silent) { driveState = 'reconnect'; return ''; }                                // the quiet attempt did not do: the menu offers a tap
    return err === 'access_denied' ? 'Google Drive was not connected: the request was cancelled.' : 'Google Drive was not connected. Try again from the menu.';
  }
  const token = qp.get('access_token'), ttl = +qp.get('expires_in') || 3600;
  if (!token || !/^[\w.\-]+$/.test(token)) return 'Google sent no usable token.';
  if (ttl <= 120) { driveState = 'reconnect'; return ''; }                             // a token that is about to run out is not adopted: the menu asks for a tap instead of another round trip
  const nd = { email: drive ? drive.email : '', token, exp: Date.now() + ttl * 1000, folderId: drive ? drive.folderId : '' };
  try {
    const r = await driveApi('GET', '/drive/v3/about?fields=user(emailAddress)', null, nd);
    nd.email = r.user && r.user.emailAddress || nd.email;
  } catch (e) { return 'Google Drive did not accept the connection: ' + errText(e); }
  drive = nd; driveState = ''; driveMsg = ''; driveFail.clear(); await storeDrive();
  scheduleDrive(0);                                                                   // the silent-attempt throttle stays and ages out by itself
  return '';
}
async function driveDisconnect() {
  const t = drive && drive.token; drive = null; driveState = ''; driveMsg = ''; await storeDrive();
  if (t) fetch(DRIVE.revoke + '?token=' + encodeURIComponent(t), { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }).catch(() => {});
  renderDriveBox(); renderSyncLine();
}
// one request to the Drive interface; body: object (JSON) or Blob (multipart upload); d: token holder
async function driveApi(method, path, body, d) {
  const h = { Authorization: 'Bearer ' + (d || drive).token };
  let b = null;
  if (body instanceof Blob) { b = body; h['Content-Type'] = body.type; } else if (body) { b = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  const r = await fetch(DRIVE.api + path, { method, headers: h, body: b, credentials: 'omit', cache: 'no-store' });
  if (r.status === 401) { const e = new Error('reconnect'); e.reconnect = true; throw e; }
  if (!r.ok) { let m = ''; try { m = (await r.json()).error.message; } catch (e) {} throw new Error('Google Drive answered ' + r.status + (m ? ': ' + m : '')); }
  return r.status === 204 ? null : r.json();
}
const driveQ = s => encodeURIComponent(s);
// two devices on one account may create the same thing at the same moment: after creating, the
// search is repeated and everyone keeps the oldest, so both converge on one folder and one file
const oldest = files => files.slice().sort((a, b) => (a.createdTime || '').localeCompare(b.createdTime || '') || a.id.localeCompare(b.id))[0];
async function driveFolder() {
  if (drive.folderId) { try { const f = await driveApi('GET', '/drive/v3/files/' + drive.folderId + '?fields=id,trashed'); if (f && !f.trashed) return drive.folderId; } catch (e) { if (e.reconnect) throw e; } }
  const q = '/drive/v3/files?spaces=drive&fields=files(id,createdTime)&q=' + driveQ("name='" + DRIVE.folder + "' and mimeType='application/vnd.google-apps.folder' and trashed=false");
  const found = await driveApi('GET', q);
  let id = found.files && found.files.length ? oldest(found.files).id : '';
  if (!id) {
    id = (await driveApi('POST', '/drive/v3/files?fields=id', { name: DRIVE.folder, mimeType: 'application/vnd.google-apps.folder' })).id;
    const again = await driveApi('GET', q); if (again.files && again.files.length > 1) { const keep = oldest(again.files).id; if (keep !== id) { try { await driveApi('PATCH', '/drive/v3/files/' + id + '?fields=id', { trashed: true }); } catch (e) {} id = keep; } }
  }
  drive.folderId = id; await storeDrive(); return id;
}
// a PDF larger than the one-request limit goes up in the resumable form: the metadata first, then the body to the address Google names
async function driveUploadBody(method, path, meta, blob) {
  if (blob.size <= DRIVE_MULTIPART_MAX) return driveApi(method, path + '?uploadType=multipart&fields=id', multipart(meta, blob));
  const r = await fetch(DRIVE.api + path + '?uploadType=resumable&fields=id', { method, headers: { Authorization: 'Bearer ' + drive.token, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/pdf', 'X-Upload-Content-Length': String(blob.size) }, body: JSON.stringify(meta), credentials: 'omit', cache: 'no-store' });
  if (r.status === 401) { const e = new Error('reconnect'); e.reconnect = true; throw e; }
  const loc = r.headers.get('Location'); if (!r.ok || !loc) throw new Error('Google Drive answered ' + r.status + ' to the upload request');
  const up = await fetch(loc, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: blob, credentials: 'omit', cache: 'no-store' });
  if (!up.ok) throw new Error('Google Drive answered ' + up.status + ' to the upload');
  return up.json();
}
function multipart(meta, blob) {
  const b = 'snapdoc' + uid().replace(/-/g, '');
  return new Blob(['--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n--' + b + '\r\nContent-Type: application/pdf\r\n\r\n', blob, '\r\n--' + b + '--'], { type: 'multipart/related; boundary=' + b });
}
// one document to Drive: new file, or new content and name of the file that stands for it
async function driveUpload(d) {
  const name = fileName(d), q = '/drive/v3/files?spaces=drive&fields=files(id,createdTime)&q=' + driveQ("appProperties has { key='snapdoc' and value='" + d.id + "' } and trashed=false");
  let id = d.drive && d.drive.id;
  if (!id) {                                           // another device may have uploaded it already: the file carries the document id
    const r = await driveApi('GET', q);
    id = r.files && r.files.length ? oldest(r.files).id : '';
  }
  const gone = e => !e.reconnect && /404/.test(e.message);
  try {
    if (d.drive && d.drive.id === id && d.drive.rev >= d.rev) {       // only the name changed
      await driveApi('PATCH', '/drive/v3/files/' + id + '?fields=id', { name });
    } else {
      const blob = await getPdf(d);
      if (id) await driveUploadBody('PATCH', '/upload/drive/v3/files/' + id, { name }, blob);
      else {
        id = (await driveUploadBody('POST', '/upload/drive/v3/files', { name, parents: [await driveFolder()], appProperties: { snapdoc: d.id } }, blob)).id;
        const again = await driveApi('GET', q);                     // created twice by two devices at once: everyone keeps the oldest
        if (again.files && again.files.length > 1) { const keep = oldest(again.files).id; if (keep !== id) { try { await driveApi('PATCH', '/drive/v3/files/' + id + '?fields=id', { trashed: true }); } catch (e) {} id = keep; } }
      }
    }
  } catch (e) {
    if (gone(e) && d.drive) { delete d.drive; persist(); return driveUpload(d); }      // the file was removed for good in Drive: found or made again
    throw e;
  }
  d.drive = { id, rev: d.rev, name }; persist();
}
async function driveTrash(d) {
  try { await driveApi('PATCH', '/drive/v3/files/' + d.drive.id + '?fields=id', { trashed: true }); }
  catch (e) { if (e.reconnect || !/404/.test(e.message)) throw e; }
  delete d.drive; persist();
}
function scheduleDrive(ms) { if (!DRIVE || !drive || passive) return; clearTimeout(driveTimer); driveTimer = setTimeout(driveNow, ms == null ? 2500 : ms); }
async function driveNow() {
  if (!DRIVE || !drive || passive || locked || !Vault.isOpen() || !docsLoaded) return;
  if (driveBusy) { driveAgain = true; return; }
  const todo = drivePending(); if (!todo.length) { if (driveState === 'busy') setDriveState('', ''); return; }
  if (!driveTokenOk()) {
    // the hour is over: once, quietly, back to Google and on, but only while nothing on the home
    // screen would be lost (typed search, a selection, a pending Undo, a list write under way) and
    // at most twice in ten minutes; otherwise, and with a lock, the user taps instead
    let tried = '', n = 0; try { tried = sessionStorage.getItem(DRIVE_SILENT_KEY) || ''; n = +sessionStorage.getItem(DRIVE_SILENT_N) || 0; } catch (e) {}
    if (Date.now() - (+tried || 0) > 600000) n = 0;
    const quiet = !workInFlight() && current() === 'home' && !homeQuery && !selectMode && !toastAction && !persistQueued && !persistFailed && document.visibilityState === 'visible' && (!document.activeElement || document.activeElement === document.body);
    if (!Vault.lockType() && !driveTried && quiet && n < 2 && navigator.onLine !== false) {
      driveTried = true; try { sessionStorage.setItem(DRIVE_SILENT_KEY, String(Date.now())); sessionStorage.setItem(DRIVE_SILENT_N, String(n + 1)); } catch (e) {}
      driveConnect(true); return;
    }
    setDriveState('reconnect', ''); return;
  }
  driveBusy = true; driveAgain = false; let failed = 0, why = '', done = 0;
  try {
    for (const d of todo) {                               // one document Google refuses does not hold up the others; it is tried again after a growing pause
      if (passive || locked || !drive) break;
      const f = driveFail.get(d.id);
      if (f && f.rev === d.rev && f.name === fileName(d) && Date.now() < f.until) { failed++; why = f.why; continue; }
      setDriveState('busy', 'Google Drive: ' + (d.deleted ? 'removing' : 'uploading') + ' ' + docLabel(d));
      try { if (d.deleted) await driveTrash(d); else await driveUpload(d); driveFail.delete(d.id); done++; }
      catch (e) {
        if (e.reconnect) throw e;
        if (navigator.onLine === false || /Failed to fetch|NetworkError/.test(errText(e))) throw e;
        failed++; why = '"' + docLabel(d) + '": ' + errText(e);
        const k = (f && f.rev === d.rev ? f.n : 0) + 1;
        driveFail.set(d.id, { rev: d.rev, name: fileName(d), n: k, why, until: Date.now() + Math.min(3600000, 60000 * Math.pow(4, k - 1)) });
      }
    }
    if (failed) setDriveState('error', failed === 1 ? why : failed + ' documents could not be copied. Last reason: ' + why); else setDriveState('', '');
  } catch (e) {
    if (e.reconnect) { drive.exp = 0; await storeDrive(); setDriveState('reconnect', ''); }
    else setDriveState(navigator.onLine === false || /Failed to fetch|NetworkError/.test(errText(e)) ? 'offline' : 'error', errText(e));
  } finally { driveBusy = false; }
  if (driveAgain) scheduleDrive(500);
}
function setDriveState(s, msg) { driveState = s; driveMsg = msg; renderSyncLine(); renderDriveBox(); }
function driveSummary() {
  const live = docs.filter(d => !d.deleted && hasContent(d) && d.pages.some(p => !p.status)), done = live.filter(d => d.drive && d.drive.rev >= d.rev && d.drive.name === fileName(d)).length;
  return { total: live.length, done };
}
function renderDriveBox() {
  const box = $('driveBox'); if (!box) return;
  if (!DRIVE) { box.innerHTML = '<p>Google Drive copies are not set up in this version.</p>'; return; }
  if (!drive) {
    box.innerHTML = '<p>Keep a plain PDF of every document in a folder "Snapdoc" of your Google Drive, uploaded from this device right after each scan. The app only ever sees the files it created there.</p>' +
      '<button id="driveOn" class="btn primary">Connect Google Drive</button>';
    $('driveOn').addEventListener('click', () => driveConnect(false));
    return;
  }
  const s = driveSummary(), err = driveState === 'error' || driveState === 'reconnect';
  const line = driveState === 'busy' ? driveMsg + '…' : driveState === 'reconnect' ? 'The connection has run out. Tap Reconnect to continue uploading.' : driveState === 'error' ? driveMsg : driveState === 'offline' ? 'Offline. Uploads continue when the connection is back.' : s.done + ' of ' + s.total + ' documents in Drive';
  box.innerHTML = '<div class="statecard' + (err ? ' err' : '') + '"><div class="t">Google Drive copies · ' + esc(drive.email || '') + '</div><div class="s">Folder "' + esc(DRIVE.folder) + '" · ' + esc(line) + '</div></div>' +
    (driveState === 'reconnect' ? '<button id="driveRe" class="btn primary">Reconnect</button>' : '<button id="driveNowBtn" class="btn">Upload now</button>') +
    '<button id="driveOff" class="btn quiet">Disconnect Google Drive</button>';
  if ($('driveRe')) $('driveRe').addEventListener('click', () => driveConnect(false));
  if ($('driveNowBtn')) $('driveNowBtn').addEventListener('click', () => { driveTried = false; driveFail.clear(); driveNow(); });
  $('driveOff').addEventListener('click', () => popup('Disconnect Google Drive?', 'The PDFs already in Drive stay there. New scans are no longer copied.', [{ label: 'Disconnect', cls: 'danger', fn: driveDisconnect }, { label: 'Keep it', cls: 'quiet' }]));
}
