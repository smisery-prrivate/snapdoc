'use strict';
/* Snapdoc lock screen and the menu sheet (cloud sync, app lock, scanning options). */
let locked = false, softLock = false, unlocking = false, hiddenAt = 0, holdReloadUntil = 0, pinStep = false, hideTimer = null, softTimer = null, storageAtRisk = false;
const unlockWaiters = [];
const COVERED = ['home', 'doc', 'edit', 'cam', 'sheet'];
// shotsPending: the shutter has fired and the photo is not there yet. That shot is work in flight too.
const workInFlight = () => shotsPending > 0 || selBusy || driveBusy || qLen > 0 || syncing || Date.now() < holdReloadUntil || current() === 'edit' || (current() === 'cam' && camCount > 0) || edApplying || pdfBuilding;

// ---------- lock screen ----------
// soft = shown over a running app because work is still in flight; the page restarts (and the key
// leaves memory) as soon as that work is done. Either way nothing under the lock can be operated.
function showLock(soft) {
  let n = 0; for (let i = stack.length - 1; i > 0 && (stack[i] === 'popup' || stack[i] === 'sheet'); i--) n++;
  if (n) { if (popupState) popupState.after = null; history.go(-n); }          // popups and the menu close without acting
  locked = true; softLock = !!soft;
  for (const id of COVERED) $(id).inert = true;
  $('toast').classList.remove('show');
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  const pin = Vault.lockType() === 'pin', num = Vault.pinIsNumeric(), inp = $('pinInput');
  $('lock').hidden = false; $('lockErr').textContent = '';
  inp.hidden = !pin; inp.value = ''; inp.inputMode = num ? 'numeric' : 'text'; inp.placeholder = num ? 'PIN' : 'Password';
  $('lockText').textContent = pin ? 'Enter your ' + (num ? 'PIN' : 'password') + ' to open your scans.' : 'Unlock with your fingerprint or screen lock.';
  if (pin) setTimeout(() => inp.focus(), 100); else if (!document.hidden) setTimeout(tryUnlock, 300);
  clearInterval(softTimer);
  if (soft) softTimer = setInterval(() => { if (!locked || !softLock) { clearInterval(softTimer); return; } if (!workInFlight()) { clearInterval(softTimer); restartLocked(); } }, 1500);
}
let unlockCtl = null, unlockRun = null, unlockSeq = 0;
async function tryUnlock() {
  if (!locked) return;
  const pin = Vault.lockType() === 'pin', secret = $('pinInput').value;
  if (pin && (!secret || unlocking)) return;
  const my = ++unlockSeq;
  if (unlockCtl) { unlockCtl.abort(); unlockCtl = null; }      // a request whose prompt never showed must not block the button…
  if (unlockRun) { try { await unlockRun; } catch (e) {} }     // …and it has to be gone before the next one starts
  if (my !== unlockSeq || !locked) return;
  const ctl = unlockCtl = pin ? null : new AbortController();
  unlocking = true; $('lockErr').textContent = pin ? 'Checking…' : '';
  const run = unlockRun = Vault.unlock(secret, ctl ? ctl.signal : undefined);
  try {
    await run;
    locked = false; softLock = false; unlockCtl = null; clearInterval(softTimer);
    for (const id of COVERED) $(id).inert = false;
    $('lock').hidden = true; $('pinInput').value = ''; $('lockErr').textContent = '';
    while (unlockWaiters.length) unlockWaiters.shift()();
    resumeCam(); syncNow(); resealAll();
  } catch (e) {
    if (my === unlockSeq) $('lockErr').textContent = e && (e.name === 'NotAllowedError' || e.name === 'AbortError') ? 'Not unlocked. Tap Unlock to try again.' : (e && e.message) || 'Not unlocked.';
  } finally { if (unlockRun === run) unlockRun = null; if (my === unlockSeq) unlocking = false; }
}
const whenUnlocked = () => locked ? new Promise(r => unlockWaiters.push(r)) : Promise.resolve();
$('unlockBtn').addEventListener('click', tryUnlock);
$('pinInput').addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); });
$('lockReset').addEventListener('click', () => popup('Reset Snapdoc on this device?',
  'Everything stored here is erased: scans, lock and sign-in. Scans that were synced come back after you sign in and enter your encryption password again. Scans that were never synced are lost.',
  [{ label: 'Erase and reset', cls: 'danger', fn: () => wipeEverything().then(() => location.reload()) }, { label: 'Cancel', cls: 'quiet' }], { lockOk: true }));
async function wipeEverything() {
  await idb.wipe();
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('snapdoc.')) localStorage.removeItem(k); sessionStorage.removeItem(RESUME_KEY); } catch (e) {}
}
// Lock again. Work in flight is never cut off: the lock screen covers the app at once and the page
// restarts when that work is done. A restart also clears the key and every decrypted image from memory.
function relock() {
  if (!Vault.lockType() || locked || passive) return;
  if (workInFlight()) { showLock(true); return; }
  restartLocked();
}
async function restartLocked() {
  try { sessionStorage.setItem(RESUME_KEY, curDoc ? curDoc.id : ''); } catch (e) {}
  if (current() === 'doc') commitName();
  try { await waitForPages(); await persistChain; } catch (e) {}
  location.reload();
}
document.addEventListener('visibilitychange', () => {
  clearTimeout(hideTimer);
  if (document.hidden) {
    hiddenAt = Date.now();
    if (Vault.lockType() && !locked) hideTimer = setTimeout(() => { if (document.hidden) relock(); }, (settings.lockAfter || 60) * 1000 + 500);   // also while it stays in the background
    return;
  }
  const away = hiddenAt ? Date.now() - hiddenAt : 0; hiddenAt = 0;
  if (passive) return;
  if (Vault.lockType() && !locked && away > (settings.lockAfter || 60) * 1000) relock();
  if (locked) { if (Vault.lockType() !== 'pin' && !unlocking) tryUnlock(); return; }
  if (!Vault.isOpen()) return;
  resumeCam(); syncNow(); checkForUpdate();
});

// ---------- menu sheet ----------
function openSheet() { if (stack.includes('sheet') || locked || passive) return; pinStep = false; push('sheet'); renderSheet(); }
function sheetClosed() { $('panel').innerHTML = ''; pinStep = false; }
$('sheet').addEventListener('click', e => { if (e.target === $('sheet')) back(); });
let installEvt = null;
// only the install button is redrawn: the rest of the menu may hold a half-typed password
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; renderInstallBox(); });
window.addEventListener('appinstalled', () => { installEvt = null; renderInstallBox(); });
function renderInstallBox() {
  const box = $('installBox'); if (!box) return;
  const unsafe = storageAtRisk && docs.some(d => !d.deleted && d.pages.length && !(session && d.pushed_rev >= d.rev));
  box.innerHTML = (installEvt ? '<button class="btn primary" id="installBtn">Install on this phone</button>' : '') +
    (unsafe ? '<div class="hint warn">This browser may clear stored scans it has not seen for a while. Install the app or turn on cloud sync so nothing is lost.</div>' : '');
  if (installEvt) $('installBtn').addEventListener('click', async () => { const ev = installEvt; installEvt = null; renderInstallBox(); ev.prompt(); try { await ev.userChoice; } catch (e) {} });
}
function renderSheet() {
  if (!stack.includes('sheet')) return;
  $('panel').innerHTML = '<div class="grab"></div><h2>Cloud sync</h2><div id="syncBox"></div><h2>App lock</h2><div id="lockBox"></div>' +
    '<h2>Google Drive</h2><div id="driveBox"></div>' +
    '<h2>Scanning</h2>' +
    (LOOKS ? '<div class="rowopt"><span>Default look</span><select id="setFilter"><option value="color">Color</option><option value="gray">Gray</option><option value="bw">Black &amp; white</option><option value="photo">Photo (no filter)</option></select></div>' : '') +
    '<div class="rowopt"><span>PDF page size</span><select id="setPage"><option value="A4">A4</option><option value="Letter">Letter</option><option value="fit">Fit the scan</option></select></div>' +
    '<h2>App</h2><div id="installBox"></div>' +
    '<div class="hint">Scans are encrypted on this device and encrypted again before they are uploaded. No cookies, no trackers, no third-party scripts.</div>' +
    '<div class="version">Snapdoc · ' + VERSION + '</div>';
  renderSyncBox(); renderDriveBox(); renderLockBox(); renderInstallBox();
  if (LOOKS) { $('setFilter').value = settings.filter; $('setFilter').addEventListener('change', e => { settings.filter = e.target.value; saveSettings(); }); }
  $('setPage').value = settings.pageSize; $('setPage').addEventListener('change', e => { settings.pageSize = e.target.value; saveSettings(); });
}
const LOCK_TEXT = {
  prf: ['🔒 Locked with fingerprint / screen lock', 'The key to your scans is released only by this phone\'s screen lock.'],
  gate: ['🔒 Locked with fingerprint / screen lock (screen only)', 'This browser cannot tie the key itself to the screen lock, so the lock guards the app screen but not a copy of the stored data. A long password ties the key as well.'],
  pin: ['🔒 Locked with a PIN or password', 'The key to your scans is derived from it.']
};
// A short PIN can be tried out by a computer against a copy of the stored data, so it is not offered.
function pinProblem(a) {
  if (/^\d+$/.test(a)) return a.length < 12 ? 'A PIN needs 12 digits or more. Shorter ones can be guessed by a computer. A password of 8 or more characters with letters works too.' : '';
  return a.length < 8 ? 'Use at least 8 characters, or a PIN of 12 digits or more.' : '';
}
function renderLockBox() {
  const box = $('lockBox'); if (!box) return;
  const type = Vault.lockType();
  if (type) {
    box.innerHTML = '<div class="statecard"><div class="t">' + LOCK_TEXT[type][0] + '</div><div class="s">' + LOCK_TEXT[type][1] + (Vault.hasOldKeys() ? '<br>Older scans are being moved under the new key in the background.' : '') + '</div></div>' +
      '<div class="rowopt"><span>Lock again after</span><select id="lockAfter"><option value="5">5 seconds away</option><option value="60">1 minute away</option><option value="300">5 minutes away</option><option value="1800">30 minutes away</option></select></div>' +
      '<button class="btn" id="lockNow">Lock now</button><button class="btn quiet" id="lockOff">Turn the lock off</button>';
    $('lockAfter').value = String(settings.lockAfter || 60);
    $('lockAfter').addEventListener('change', e => { settings.lockAfter = +e.target.value; saveSettings(); });
    $('lockNow').addEventListener('click', () => relock());
    $('lockOff').addEventListener('click', () => popup('Turn the lock off?', 'Anyone who can open this phone can then open your scans.', [
      { label: 'Turn off', cls: 'danger', fn: async () => { try { await Vault.clearLock(); toast('Lock is off'); } catch (e) { toast('Could not turn it off: ' + errText(e)); } renderLockBox(); } },
      { label: 'Keep it on', cls: 'quiet' }]));
    return;
  }
  if (pinStep) {
    box.innerHTML = '<p>Choose a password (8 characters or more) or a long PIN (12 digits or more). It is asked every time the app opens. It cannot be recovered: if you forget it, the app on this device has to be reset.</p>' +
      '<div class="pinform"><input id="pin1" type="password" autocomplete="new-password" placeholder="Password or long PIN"><input id="pin2" type="password" autocomplete="new-password" placeholder="Repeat"></div>' +
      '<button class="btn primary" id="pinSave">Turn the lock on</button><button class="btn quiet" id="pinBack">Back</button><div class="hint" id="lockHint"></div>';
    $('pinBack').addEventListener('click', () => { pinStep = false; renderLockBox(); });
    let saving = false;
    $('pinSave').addEventListener('click', async () => {
      const a = $('pin1').value, b = $('pin2').value, hint = $('lockHint');
      if (saving) return;
      const prob = pinProblem(a); if (prob) { hint.textContent = prob; return; }
      if (a !== b) { hint.textContent = 'The two entries differ.'; return; }
      saving = true; hint.textContent = 'Setting up…';
      try { await Vault.setPin(a); pinStep = false; toast('Lock is on'); renderLockBox(); resealAll(); } catch (e) { hint.textContent = 'Not set up: ' + errText(e); } finally { saving = false; }
    });
    return;
  }
  box.innerHTML = '<p>Your scans are stored encrypted on this phone. With a lock, the key is released only by your fingerprint or screen lock. Turn it on before you scan anything sensitive.</p>' +
    '<button class="btn primary" id="lockOnBio">Use fingerprint / screen lock</button><button class="btn" id="lockOnPin">Use a password or long PIN instead</button><div class="hint" id="lockHint"></div>';
  $('lockOnPin').addEventListener('click', () => { pinStep = true; renderLockBox(); });
  let setting = false;
  $('lockOnBio').addEventListener('click', async () => {
    const hint = $('lockHint'); if (setting) return;
    if (!(await Vault.biometricAvailable())) { hint.textContent = 'This device or browser offers no fingerprint or screen lock here. Use a password or long PIN instead.'; return; }
    setting = true; hint.textContent = 'Confirm with your fingerprint or screen lock. Your phone may ask twice.';
    try {
      const t = await Vault.setBiometric();
      toast(t === 'gate' ? 'Lock is on. On this browser it guards the screen only.' : 'Lock is on'); renderLockBox(); resealAll();
    } catch (e) { hint.textContent = e && e.name === 'NotAllowedError' ? 'Not set up: it was cancelled. Tap again to retry.' : 'Not set up: ' + errText(e); }
    finally { setting = false; }
  });
}
