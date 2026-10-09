'use strict';
/* Snapdoc lock screen and the menu sheet (cloud sync, app lock, scanning options). */
let locked = false, unlocking = false, hiddenAt = 0, holdReloadUntil = 0, pinStep = false;
const unlockWaiters = [];

// ---------- lock screen ----------
function showLock() {
  locked = true;
  const pin = Vault.lockType() === 'pin', num = Vault.pinIsNumeric(), inp = $('pinInput');
  $('lock').hidden = false; $('lockErr').textContent = '';
  inp.hidden = !pin; inp.value = ''; inp.inputMode = num ? 'numeric' : 'text'; inp.placeholder = num ? 'PIN' : 'Password';
  $('lockText').textContent = pin ? 'Enter your ' + (num ? 'PIN' : 'password') + ' to open your scans.' : 'Unlock with your fingerprint or screen lock.';
  if (pin) setTimeout(() => inp.focus(), 100); else setTimeout(tryUnlock, 300);
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
    locked = false; unlockCtl = null; $('lock').hidden = true; $('pinInput').value = ''; $('lockErr').textContent = '';
    while (unlockWaiters.length) unlockWaiters.shift()();
  } catch (e) {
    if (my === unlockSeq) $('lockErr').textContent = e && (e.name === 'NotAllowedError' || e.name === 'AbortError') ? 'Not unlocked. Tap Unlock to try again.' : (e && e.message) || 'Not unlocked.';
  } finally { if (unlockRun === run) unlockRun = null; if (my === unlockSeq) unlocking = false; }
}
const whenUnlocked = () => locked ? new Promise(r => unlockWaiters.push(r)) : Promise.resolve();
$('unlockBtn').addEventListener('click', tryUnlock);
$('pinInput').addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); });
$('lockReset').addEventListener('click', () => popup('Reset Snapdoc on this device?',
  'Everything stored here is erased: scans, lock and sign-in. Scans that were synced come back after you sign in and enter your encryption password again. Scans that were never synced are lost.',
  [{ label: 'Erase and reset', cls: 'danger', fn: () => wipeEverything().then(() => location.reload()) }, { label: 'Cancel', cls: 'quiet' }]));
async function wipeEverything() {
  await idb.wipe();
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('snapdoc.')) localStorage.removeItem(k); sessionStorage.removeItem(RESUME_KEY); } catch (e) {}
}
// Away longer than the chosen time: lock again. When nothing is in flight the page restarts,
// which also clears the key and every decrypted image from memory.
function relock(force) {
  if (!Vault.lockType() || locked) return;
  const inFlight = qLen > 0 || syncing || Date.now() < holdReloadUntil || current() === 'edit' || (current() === 'cam' && camCount > 0);
  if (inFlight && !force) { showLock(); return; }
  try { sessionStorage.setItem(RESUME_KEY, curDoc ? curDoc.id : ''); } catch (e) {}
  location.reload();
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  const away = hiddenAt ? Date.now() - hiddenAt : 0; hiddenAt = 0;
  if (Vault.lockType() && !locked && away > (settings.lockAfter || 60) * 1000) relock();
  if (locked || !Vault.isOpen()) return;
  if (current() === 'cam') { if (!track || track.readyState !== 'live') startStream(); else keepAwake(); }
  syncNow();
});

// ---------- menu sheet ----------
function openSheet() { if (stack.includes('sheet')) return; pinStep = false; push('sheet'); renderSheet(); }
function sheetClosed() { $('panel').innerHTML = ''; pinStep = false; }
$('sheet').addEventListener('click', e => { if (e.target === $('sheet')) back(); });
let installEvt = null;
// only the install button is redrawn: the rest of the menu may hold a half-typed password
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; renderInstallBox(); });
window.addEventListener('appinstalled', () => { installEvt = null; renderInstallBox(); });
function renderInstallBox() {
  const box = $('installBox'); if (!box) return;
  box.innerHTML = installEvt ? '<button class="btn primary" id="installBtn">Install on this phone</button>' : '';
  if (installEvt) $('installBtn').addEventListener('click', async () => { const ev = installEvt; installEvt = null; renderInstallBox(); ev.prompt(); try { await ev.userChoice; } catch (e) {} });
}
function renderSheet() {
  if (!stack.includes('sheet')) return;
  $('panel').innerHTML = '<div class="grab"></div><h2>Cloud sync</h2><div id="syncBox"></div><h2>App lock</h2><div id="lockBox"></div>' +
    '<h2>Scanning</h2>' +
    '<div class="rowopt"><span>Default look</span><select id="setFilter"><option value="color">Color</option><option value="gray">Gray</option><option value="bw">Black &amp; white</option><option value="photo">Photo (no filter)</option></select></div>' +
    '<div class="rowopt"><span>PDF page size</span><select id="setPage"><option value="A4">A4</option><option value="Letter">Letter</option><option value="fit">Fit the scan</option></select></div>' +
    '<h2>App</h2><div id="installBox"></div>' +
    '<div class="hint">Scans are encrypted on this device and encrypted again before they are uploaded. No cookies, no trackers, no third-party scripts.</div>' +
    '<div class="version">Snapdoc · ' + VERSION + '</div>';
  renderSyncBox(); renderLockBox(); renderInstallBox();
  $('setFilter').value = settings.filter; $('setFilter').addEventListener('change', e => { settings.filter = e.target.value; saveSettings(); });
  $('setPage').value = settings.pageSize; $('setPage').addEventListener('change', e => { settings.pageSize = e.target.value; saveSettings(); });
}
const LOCK_TEXT = {
  prf: ['🔒 Locked with fingerprint / screen lock', 'The key to your scans is released only by this phone\'s screen lock.'],
  gate: ['🔒 Locked with fingerprint / screen lock', 'This browser cannot tie the key itself to the screen lock, so the lock guards the app screen. A PIN or password ties the key as well.'],
  pin: ['🔒 Locked with a PIN or password', 'The key to your scans is derived from it. Longer is stronger.']
};
function renderLockBox() {
  const box = $('lockBox'); if (!box) return;
  const type = Vault.lockType();
  if (type) {
    box.innerHTML = '<div class="statecard"><div class="t">' + LOCK_TEXT[type][0] + '</div><div class="s">' + LOCK_TEXT[type][1] + '</div></div>' +
      '<div class="rowopt"><span>Lock again after</span><select id="lockAfter"><option value="5">5 seconds away</option><option value="60">1 minute away</option><option value="300">5 minutes away</option><option value="1800">30 minutes away</option></select></div>' +
      '<button class="btn" id="lockNow">Lock now</button><button class="btn quiet" id="lockOff">Turn the lock off</button>';
    $('lockAfter').value = String(settings.lockAfter || 60);
    $('lockAfter').addEventListener('change', e => { settings.lockAfter = +e.target.value; saveSettings(); });
    $('lockNow').addEventListener('click', () => relock(true));
    $('lockOff').addEventListener('click', () => popup('Turn the lock off?', 'Anyone who can open this phone can then open your scans.', [
      { label: 'Turn off', cls: 'danger', fn: async () => { try { await Vault.clearLock(); toast('Lock is off'); } catch (e) { toast('Could not turn it off: ' + (e.message || e)); } renderLockBox(); } },
      { label: 'Keep it on', cls: 'quiet' }]));
    return;
  }
  if (pinStep) {
    box.innerHTML = '<p>Choose a PIN (6 digits or more) or a password. It is asked every time the app opens.</p>' +
      '<div class="pinform"><input id="pin1" type="password" autocomplete="new-password" placeholder="PIN or password"><input id="pin2" type="password" autocomplete="new-password" placeholder="Repeat"></div>' +
      '<button class="btn primary" id="pinSave">Turn the lock on</button><button class="btn quiet" id="pinBack">Back</button><div class="hint" id="lockHint"></div>';
    $('pinBack').addEventListener('click', () => { pinStep = false; renderLockBox(); });
    $('pinSave').addEventListener('click', async () => {
      const a = $('pin1').value, b = $('pin2').value, hint = $('lockHint');
      if (a.length < 6) { hint.textContent = 'Use at least 6 characters.'; return; }
      if (a !== b) { hint.textContent = 'The two entries differ.'; return; }
      hint.textContent = 'Setting up…';
      try { await Vault.setPin(a); pinStep = false; toast('Lock is on'); renderLockBox(); } catch (e) { hint.textContent = 'Not set up: ' + (e.message || e); }
    });
    return;
  }
  box.innerHTML = '<p>Your scans are stored encrypted on this phone. With a lock, the key is released only by your fingerprint or screen lock.</p>' +
    '<button class="btn primary" id="lockOnBio">Use fingerprint / screen lock</button><button class="btn" id="lockOnPin">Use a PIN or password instead</button><div class="hint" id="lockHint"></div>';
  $('lockOnPin').addEventListener('click', () => { pinStep = true; renderLockBox(); });
  $('lockOnBio').addEventListener('click', async () => {
    const hint = $('lockHint');
    if (!(await Vault.biometricAvailable())) { hint.textContent = 'This device or browser offers no fingerprint or screen lock here. Use a PIN or password instead.'; return; }
    hint.textContent = 'Confirm with your fingerprint or screen lock. Your phone may ask twice.';
    try { await Vault.setBiometric(); toast('Lock is on'); renderLockBox(); }
    catch (e) { hint.textContent = e && e.name === 'NotAllowedError' ? 'Not set up: it was cancelled.' : 'Not set up: ' + ((e && e.message) || e); }
  });
}
