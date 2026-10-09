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
const DRIVE_STATE = 'snapdoc-drive', DRIVE_NONCE_KEY = 'snapdoc.driveNonce', DRIVE_SILENT_KEY = 'snapdoc.driveSilent';
let drive = null;                 // { email, token, exp, folderId } once connected; stored encrypted in meta 'drive'
let driveTimer = null, driveBusy = false, driveAgain = false, driveState = '', driveMsg = '', driveTried = false;
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
  if (qp.get('error')) {
    const silent = qp.get('error') === 'interaction_required' || qp.get('error') === 'login_required' || qp.get('error') === 'consent_required';
    if (silent) { driveState = 'reconnect'; return ''; }                                // the quiet attempt did not do: the menu offers a tap
    return 'Google Drive was not connected' + (qp.get('error') === 'access_denied' ? ': the request was cancelled.' : ' (' + qp.get('error') + ').');
  }
  if (!nonce || qp.get('state') !== DRIVE_STATE + '.' + nonce) return 'This Google reply does not belong to a request from this app.';     // a reply this browser did not ask for is ignored
  const token = qp.get('access_token'), ttl = +qp.get('expires_in') || 3600;
  if (!token || !/^[\w.\-]+$/.test(token)) return 'Google sent no usable token.';
  const nd = { email: drive ? drive.email : '', token, exp: Date.now() + ttl * 1000, folderId: drive ? drive.folderId : '' };
  try {
    const r = await driveApi('GET', '/drive/v3/about?fields=user(emailAddress)', null, nd);
    nd.email = r.user && r.user.emailAddress || nd.email;
  } catch (e) { return 'Google Drive did not accept the connection: ' + errText(e); }
  drive = nd; driveState = ''; driveMsg = ''; await storeDrive();
  try { sessionStorage.removeItem(DRIVE_SILENT_KEY); } catch (e) {}
  scheduleDrive(0);
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
async function driveFolder() {
  if (drive.folderId) { try { const f = await driveApi('GET', '/drive/v3/files/' + drive.folderId + '?fields=id,trashed'); if (f && !f.trashed) return drive.folderId; } catch (e) { if (e.reconnect) throw e; } }
  const found = await driveApi('GET', '/drive/v3/files?spaces=drive&fields=files(id)&q=' + driveQ("name='" + DRIVE.folder + "' and mimeType='application/vnd.google-apps.folder' and trashed=false"));
  let id = found.files && found.files[0] && found.files[0].id;
  if (!id) id = (await driveApi('POST', '/drive/v3/files?fields=id', { name: DRIVE.folder, mimeType: 'application/vnd.google-apps.folder' })).id;
  drive.folderId = id; await storeDrive(); return id;
}
function multipart(meta, blob) {
  const b = 'snapdoc' + uid().replace(/-/g, '');
  return new Blob(['--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n--' + b + '\r\nContent-Type: application/pdf\r\n\r\n', blob, '\r\n--' + b + '--'], { type: 'multipart/related; boundary=' + b });
}
// one document to Drive: new file, or new content and name of the file that stands for it
async function driveUpload(d) {
  const name = fileName(d);
  let id = d.drive && d.drive.id;
  if (!id) {                                           // another device may have uploaded it already: the file carries the document id
    const r = await driveApi('GET', '/drive/v3/files?spaces=drive&fields=files(id)&q=' + driveQ("appProperties has { key='snapdoc' and value='" + d.id + "' } and trashed=false"));
    id = r.files && r.files[0] && r.files[0].id;
  }
  if (d.drive && d.drive.id === id && d.drive.rev >= d.rev) {       // only the name changed
    await driveApi('PATCH', '/drive/v3/files/' + id + '?fields=id', { name });
  } else {
    const blob = await getPdf(d);
    if (id) await driveApi('PATCH', '/upload/drive/v3/files/' + id + '?uploadType=multipart&fields=id', multipart({ name }, blob));
    else id = (await driveApi('POST', '/upload/drive/v3/files?uploadType=multipart&fields=id', multipart({ name, parents: [await driveFolder()], appProperties: { snapdoc: d.id } }, blob))).id;
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
    // the hour is over: once, quietly, back to Google and on; with a lock the user taps instead
    let tried = ''; try { tried = sessionStorage.getItem(DRIVE_SILENT_KEY) || ''; } catch (e) {}
    if (!Vault.lockType() && !driveTried && !workInFlight() && current() === 'home' && Date.now() - (+tried || 0) > 600000 && navigator.onLine !== false) {
      driveTried = true; try { sessionStorage.setItem(DRIVE_SILENT_KEY, String(Date.now())); } catch (e) {}
      driveConnect(true); return;
    }
    setDriveState('reconnect', ''); return;
  }
  driveBusy = true; driveAgain = false; let n = 0;
  try {
    for (const d of todo) {
      if (passive || locked || !drive) break;
      setDriveState('busy', 'Google Drive: ' + (d.deleted ? 'removing' : 'uploading') + ' ' + docLabel(d));
      if (d.deleted) await driveTrash(d); else await driveUpload(d); n++;
    }
    setDriveState('', '');
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
  if ($('driveNowBtn')) $('driveNowBtn').addEventListener('click', () => { driveTried = false; driveNow(); });
  $('driveOff').addEventListener('click', () => popup('Disconnect Google Drive?', 'The PDFs already in Drive stay there. New scans are no longer copied.', [{ label: 'Disconnect', cls: 'danger', fn: driveDisconnect }, { label: 'Keep it', cls: 'quiet' }]));
}
