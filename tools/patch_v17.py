import io, re
P = 'C:/Users/gross/Claude_Projects/Scan_App/'
def patch(f, pairs):
    s = io.open(P + f, encoding='utf-8').read()
    for a, b in pairs:
        assert s.count(a) == 1, (f, s.count(a), a[:90])
        s = s.replace(a, b)
    io.open(P + f, 'w', encoding='utf-8', newline='\n').write(s)

# ---------- app-boot.js: the set-up screen at every start while no lock is set
patch('app-boot.js', [
 ("""  if (state === 'locked') { showLock(false); await whenUnlocked(); if (!isOwner()) { instanceLost(); return; } }""",
  """  if (state === 'locked') { showLock(false); await whenUnlocked(); if (!isOwner()) { instanceLost(); return; } }
  else if (!Vault.lockType() && !tokens && !driveQp) { await offerLock(); if (!isOwner()) { instanceLost(); return; } }      // no lock yet: asked before anything is scanned, and at every start until one is set (a link that is being handled goes first)"""),
])

# ---------- index.html: the set-up screen and its styles
s = io.open(P + 'index.html', encoding='utf-8').read()
for sel in ['#lock {', '#lock .logo {', '#lock h2 {', '#lock p {', '#lock .btn {', '#lock input {', '#lock .quiet {']:
    assert s.count('  ' + sel) == 1, sel
    s = s.replace('  ' + sel, '  ' + sel.replace('#lock', '#lock, #setup'), 1)
a = """  #lockErr { color: var(--danger); font-size: 14px; min-height: 18px; }"""
assert s.count(a) == 1
s = s.replace(a, a + """
  #setup { z-index: 41; overflow-y: auto; justify-content: flex-start; padding-top: max(env(safe-area-inset-top), 40px); }
  #setup .btn.second { background: var(--card); color: var(--ink); border: 1px solid var(--line); }
  #setupHint { color: var(--danger); font-size: 14px; min-height: 18px; max-width: 320px; }
  #setupPinForm { width: 100%; max-width: 320px; display: flex; flex-direction: column; gap: 10px; }""")
a = """<div id="away" hidden>"""
assert s.count(a) == 1
s = s.replace(a, """<div id="setup" hidden>
  <div class="logo">🔒</div>
  <h2>Lock your scans first</h2>
  <p>Whoever can open this phone must not be able to read your scans. With a lock, the key to them is released only by your fingerprint or screen lock, or by a password or long PIN.</p>
  <button id="setupBio" class="btn">Use fingerprint / screen lock</button>
  <button id="setupGateOk" class="btn second" hidden>Keep the screen lock anyway</button>
  <button id="setupPinBtn" class="btn second">Use a password or long PIN</button>
  <div id="setupPinForm" hidden>
    <input id="setupPin1" type="password" autocomplete="new-password" placeholder="Password or long PIN">
    <input id="setupPin2" type="password" autocomplete="new-password" placeholder="Repeat">
    <button id="setupPinSave" class="btn">Turn the lock on</button>
    <p>8 characters or more with at least 4 letters, or a PIN of 12 digits or more. It cannot be recovered.</p>
  </div>
  <div id="setupHint"></div>
  <button id="setupSkip" class="quiet">Not now (asked again next time)</button>
</div>
<div id="away" hidden>""")
io.open(P + 'index.html', 'w', encoding='utf-8', newline='\n').write(s)

# ---------- app-core.js: new installs lock as soon as the app leaves the screen
patch('app-core.js', [
 ("""let settings = { filter: 'photo', pageSize: 'A4', lockAfter: 60, batch: false, auto: true };
const LOCK_AFTER = [5, 60, 300, 1800];""",
  """let settings = { filter: 'photo', pageSize: 'A4', lockAfter: 0, batch: false, auto: true };      // lockAfter: 0 = lock as soon as the app leaves the screen (installs from before v17 keep their stored value)
const LOCK_AFTER = [0, 5, 60, 300, 1800];"""),
 ("""if (!LOCK_AFTER.includes(+settings.lockAfter)) settings.lockAfter = 60;      // only the offered values: nothing in plain storage can switch the lock off""",
  """if (!LOCK_AFTER.includes(+settings.lockAfter)) settings.lockAfter = 0;       // only the offered values: nothing in plain storage can lengthen the delay beyond what the menu offers"""),
])

# ---------- app-lock.js: the set-up at the first start, the gate warning, the delay
patch('app-lock.js', [
 ("""document.addEventListener('visibilitychange', () => {
  clearTimeout(hideTimer);
  if (document.hidden) {
    hiddenAt = Date.now();
    if (Vault.lockType() && !locked) hideTimer = setTimeout(() => { if (document.hidden) relock(); }, (settings.lockAfter || 60) * 1000 + 500);   // also while it stays in the background
    return;
  }
  const away = hiddenAt ? Date.now() - hiddenAt : 0; hiddenAt = 0;
  if (passive || restarting) return;
  if (pickerOpen) setTimeout(() => { pickerOpen = false; }, 3000);      // back without a choice (a browser without the cancel event): the hold ends
  if (Vault.lockType() && !locked && away > (settings.lockAfter || 60) * 1000) relock();""",
  """const lockAfterMs = () => (+settings.lockAfter || 0) * 1000;      // 0: as soon as the app leaves the screen
document.addEventListener('visibilitychange', () => {
  clearTimeout(hideTimer);
  if (document.hidden) {
    hiddenAt = Date.now();
    // the photo picker is part of the app's own flow (its button was tapped a moment ago): it does not count as leaving
    if (Vault.lockType() && !locked && !pickerOpen) hideTimer = setTimeout(() => { if (document.hidden && !pickerOpen) relock(); }, lockAfterMs() + 500);   // also while it stays in the background
    return;
  }
  const away = hiddenAt ? Date.now() - hiddenAt : 0; hiddenAt = 0;
  if (passive || restarting) return;
  const fromPicker = pickerOpen;
  if (pickerOpen) setTimeout(() => { pickerOpen = false; }, 3000);      // back without a choice (a browser without the cancel event): the hold ends
  if (Vault.lockType() && !locked && !fromPicker && away >= lockAfterMs()) relock();"""),
 ("""  gate: ['🔒 Locked with fingerprint / screen lock (screen only)', 'This browser cannot tie the key itself to the screen lock, so the lock guards the app screen but not a copy of the stored data. A long password ties the key to itself.'],""",
  """  gate: ['⚠ Fingerprint / screen lock guards the screen only', 'This browser cannot tie the key itself to the screen lock: whoever can read this phone\\'s storage can read the scans. Turn the lock off and use a password or long PIN instead, which ties the key.'],"""),
 ("""<select id="lockAfter"><option value="5">5 seconds away</option>""",
  """<select id="lockAfter"><option value="0">as soon as the app leaves the screen</option><option value="5">5 seconds away</option>"""),
 ("""    $('lockAfter').value = String(settings.lockAfter || 60);""",
  """    $('lockAfter').value = String(+settings.lockAfter || 0);"""),
 ("""      const t = await Vault.setBiometric();
      toast(t === 'gate' ? 'Lock is on. On this browser it guards the screen only.' : 'Lock is on'); renderLockBox(); resealAll();""",
  """      const t = await Vault.setBiometric();
      if (t === 'gate') gatePopup(); else toast('Lock is on');
      renderLockBox(); resealAll();"""),
 ("""// ---------- menu sheet ----------""",
  """// ---------- the lock is set up at the first start, before anything is scanned ----------
// Whoever can open this phone must not be able to read the scans: the app asks for the lock before
// the first scan, with the fingerprint as the first choice. "Not now" asks again at the next start
// (installs from before v17 are asked at their next start too); nothing is stored without a lock
// unless the owner decides so every time.
function offerLock() {
  return new Promise(resolve => {
    const box = $('setup'), hint = $('setupHint'); box.hidden = false;
    for (const id of COVERED) $(id).inert = true;
    const done = msg => { box.hidden = true; for (const id of COVERED) $(id).inert = false; if (msg) setTimeout(() => toast(msg), 300); resolve(); };
    let busy = false;
    $('setupBio').addEventListener('click', async () => {
      if (busy) return; busy = true;
      try {
        if (!(await Vault.biometricAvailable())) { hint.textContent = 'This device or browser offers no fingerprint or screen lock here. Use a password or long PIN instead.'; return; }
        hint.textContent = 'Confirm with your fingerprint or screen lock. Your phone may ask twice.';
        const t = await Vault.setBiometric();
        if (t === 'gate') { hint.textContent = 'This browser can only guard the screen, not the key itself. Better: a password or long PIN.'; $('setupBio').hidden = true; $('setupGateOk').hidden = false; return; }
        done('Lock is on');
      } catch (e) { hint.textContent = e && e.name === 'NotAllowedError' ? 'Not set up: it was cancelled. Tap again to retry.' : 'Not set up: ' + errText(e); if (Vault.lockType()) done(); }
      finally { busy = false; }
    });
    $('setupGateOk').addEventListener('click', () => done('Lock is on. On this browser it guards the screen only.'));
    $('setupPinBtn').addEventListener('click', () => { $('setupPinForm').hidden = false; $('setupPinBtn').hidden = true; setTimeout(() => $('setupPin1').focus(), 50); });
    $('setupPinSave').addEventListener('click', async () => {
      const a = $('setupPin1').value, b = $('setupPin2').value; if (busy) return;
      const prob = pinProblem(a); if (prob) { hint.textContent = prob; return; }
      if (a !== b) { hint.textContent = 'The two entries differ.'; return; }
      busy = true; hint.textContent = 'Setting up…';
      try { if (Vault.lockType() === 'gate') await Vault.clearLock(); await Vault.setPin(a); done('Lock is on'); } catch (e) { hint.textContent = 'Not set up: ' + errText(e); if (Vault.lockType()) done(); } finally { busy = false; }
    });
    $('setupSkip').addEventListener('click', () => done(''));
  });
}
// a lock that only guards the screen (the browser cannot tie the key): said at once, the PIN offered
function gatePopup() {
  popup('Only the screen is guarded', 'This browser cannot tie the key to your fingerprint or screen lock, so a copy of this phone\\'s storage would still open your scans. A password or long PIN ties the key. Use that instead?',
    [{ label: 'Use a password or PIN', cls: 'primary', fn: async () => { try { await Vault.clearLock(); } catch (e) {} pinStep = true; openSheet(); } }, { label: 'Keep the screen lock', cls: 'quiet' }]);
}

// ---------- menu sheet ----------"""),
])

# ---------- CONCEPT.md
s = io.open(P + 'CONCEPT.md', encoding='utf-8').read()
a = "- **Lock.** Optional. Fingerprint or screen lock, or a password or long PIN."
assert s.count(a) == 1
s = s.replace(a, "- **Lock.** Asked for at the first start, before the first scan (since v17): fingerprint or screen\n  lock first, a password or long PIN as the other way; \"Not now\" asks again at the next start, and an\n  install from before v17 without a lock is asked at its next start too. New installs lock as soon as\n  the app leaves the screen (the photo picker does not count as leaving); the delay can be\n  lengthened in the menu.")
s = re.sub(r"away longer than the chosen time", "away longer than the chosen time (new installs: at once)", s, count=1)
a = "- v16: PDF copies in a folder of the PC"
assert s.count(a) == 1
s = s.replace(a, "- v17: the lock is set up at the first start, before the first scan; new installs lock as soon as\n  the app leaves the screen; a browser that can only guard the screen says so at once and offers the\n  password or PIN that ties the key.\n- v16: PDF copies in a folder of the PC")
io.open(P + 'CONCEPT.md', 'w', encoding='utf-8', newline='\n').write(s)

# ---------- the test harness: the set-up screen is skipped unless a test asks for it
patch('_preview/tests/h.js', [
 ("""  await page.evaluateOnNewDocument(s => {
    try { Object.defineProperty(navigator, 'share', { value: undefined }); Object.defineProperty(navigator, 'canShare', { value: undefined }); } catch (e) {}   // headless has no share sheet: exercise the download path
    if (s && !localStorage.getItem('snapdoc.settings')) localStorage.setItem('snapdoc.settings', s);
  }, opts.settings ? JSON.stringify(opts.settings) : '');""",
  """  await page.evaluateOnNewDocument((s, keepSetup) => {
    try { Object.defineProperty(navigator, 'share', { value: undefined }); Object.defineProperty(navigator, 'canShare', { value: undefined }); } catch (e) {}   // headless has no share sheet: exercise the download path
    if (s && !localStorage.getItem('snapdoc.settings')) localStorage.setItem('snapdoc.settings', s);
    if (!keepSetup) { const t = setInterval(() => { const b = document.getElementById('setupSkip'), x = document.getElementById('setup'); if (b && x && !x.hidden) { b.click(); } }, 100); setTimeout(() => clearInterval(t), 60000); }   // the lock set-up at the first start: "Not now", unless a test looks at that screen (opts.setup)
  }, opts.settings ? JSON.stringify(opts.settings) : '', !!opts.setup);"""),
])
print('v17 patch applied')
