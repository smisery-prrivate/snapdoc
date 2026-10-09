'use strict';
/* Snapdoc vault — all cryptography in one place. WebCrypto only, no libraries.

   LK  local key   random AES-256-GCM key, one per device. Encrypts everything this app stores
                   on the device. It is kept in "slots":
                     device  wrapped by a non-extractable key. The wrapped copy ("box") lives in
                             a small private file, not in the database, because a file can really
                             be removed again while database files keep old entries around.
                             Used while no lock is set, and by the "gate" lock.
                     prf     wrapped by a key the phone's screen lock / fingerprint releases
                             (WebAuthn PRF). Without the authenticator the data cannot be opened.
                     pin     wrapped by a key derived from a PIN or password (PBKDF2)
                   When a prf or pin lock is turned on and an older copy of the key may still
                   linger in storage, a NEW local key is made for everything written from then
                   on. The previous key stays reachable only through the new one, and the app
                   re-encrypts older records in the background until the previous key can go.
   CK  cloud key   random AES-256-GCM key shared by the user's devices. Encrypts everything that
                   is uploaded. It travels between devices only inside an "envelope" that is
                   wrapped with the user's encryption password; the server never sees CK. */
const Vault = (() => {
  const te = new TextEncoder(), td = new TextDecoder();
  const KEYS_ID = 'keys', CK_ID = 'ck', PBKDF_ITER = 600000, BOX_FILE = 'snapdoc-devbox';
  let kv = null, rec = null, LK = null, LKraw = null, olds = [], CK = null, CKraw = null, ckUid = null;

  const b64 = buf => { const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const b64url = buf => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const rand = n => crypto.getRandomValues(new Uint8Array(n));
  const view = buf => buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const importAes = raw => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

  // sealed format: 12 byte IV, then ciphertext with the GCM tag. The label (aad) binds a
  // ciphertext to its place, so a record cannot be swapped for another one unnoticed.
  async function sealWith(key, data, aad) {
    const iv = rand(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad || '') }, key, data);
    const out = new Uint8Array(12 + ct.byteLength); out.set(iv); out.set(new Uint8Array(ct), 12);
    return out.buffer;
  }
  async function openWith(key, buf, aad) {
    const u8 = view(buf);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: u8.subarray(0, 12), additionalData: te.encode(aad || '') }, key, u8.subarray(12));
  }
  async function pbkdfKey(secret, salt, iter) {
    const base = await crypto.subtle.importKey('raw', te.encode(String(secret).normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function hkdfKey(ikm) {
    const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode('snapdoc-lk-v1') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  const need = k => { if (!k) throw new Error('The vault is locked.'); return k; };
  async function setLK(raw) { LKraw = new Uint8Array(raw); LK = await importAes(LKraw); }
  // read with the current key; records from before a key change still open with the previous one
  async function openLocal(buf, aad) {
    try { return await openWith(need(LK), buf, aad); }
    catch (e) { for (const o of olds) { try { return await openWith(o.key, buf, aad); } catch (e2) {} } throw e; }
  }

  // ---------- the device box: a private file that can really be deleted ----------
  async function boxDir() { try { return navigator.storage && navigator.storage.getDirectory ? await navigator.storage.getDirectory() : null; } catch (e) { return null; } }
  async function boxRead() {
    const dir = await boxDir(); if (!dir) return null;
    try { return await (await (await dir.getFileHandle(BOX_FILE)).getFile()).arrayBuffer(); } catch (e) { return null; }
  }
  async function boxWrite(buf) {
    const dir = await boxDir(); if (!dir) return false;
    try {
      const fh = await dir.getFileHandle(BOX_FILE, { create: true }); if (!fh.createWritable) return false;
      const w = await fh.createWritable(); await w.write(buf); await w.close();
      const back = await boxRead(); return !!back && back.byteLength === buf.byteLength;
    } catch (e) { return false; }
  }
  // true only when the file is verifiably gone afterwards
  async function boxRemove() {
    const dir = await boxDir(); if (!dir) return false;
    try {
      const fh = await dir.getFileHandle(BOX_FILE);
      try { const n = (await fh.getFile()).size || 60; const w = await fh.createWritable(); await w.write(rand(Math.min(n, 4096))); await w.close(); } catch (e) {}
      await dir.removeEntry(BOX_FILE);
    } catch (e) { if (!e || e.name !== 'NotFoundError') return false; }
    try { await dir.getFileHandle(BOX_FILE); return false; } catch (e) { return !!e && e.name === 'NotFoundError'; }
  }

  // ---------- local key slots ----------
  async function deviceSlot() {
    const wk = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const box = await sealWith(wk, LKraw, 'sd|lk|device');
    if (await boxWrite(box)) return { slot: { wk, opfs: true }, clean: true };
    return { slot: { wk, box }, clean: false };            // this browser has no private files: the box goes into the database
  }
  async function openDevice() {
    const dv = rec.device; if (!dv) throw new Error('The key for this device is missing.');
    const box = dv.box || await boxRead();
    if (!box) throw new Error('The key file for this device is missing.');
    await setLK(await openWith(dv.wk, box, 'sd|lk|device'));
  }
  async function loadOlds() {
    olds = [];
    for (const b of rec.old || []) { try { const raw = new Uint8Array(await openWith(LK, b, 'sd|lk|old')); olds.push({ raw, key: await importAes(raw) }); } catch (e) {} }
  }
  // returns 'open' (no lock set, key loaded) or 'locked' (call unlock)
  async function load(store) {
    kv = store; rec = await kv.get(KEYS_ID);
    if (!rec) {
      await setLK(rand(32));
      const ds = await deviceSlot();
      rec = { id: KEYS_ID, v: 2, device: ds.slot, lock: null, dirty: !ds.clean, old: [] };
      await kv.put(rec);
      return 'open';
    }
    if (rec.v !== 2) { rec.v = 2; rec.dirty = true; rec.old = rec.old || []; }      // older format: its key box sat in the database
    if (!rec.lock) { await openDevice(); await loadOlds(); return 'open'; }
    return 'locked';
  }
  // A new local key for everything written from now on. The previous key is stored only wrapped
  // by the new one, so key material left behind in storage from before cannot open new data.
  // setSlot(rawNew) writes the slot for the new key into rec; everything is saved in one step.
  async function rotate(setSlot) {
    const prev = [{ raw: LKraw, key: LK }].concat(olds);
    const raw = rand(32), key = await importAes(raw), boxes = [];
    for (const o of prev) boxes.push(await sealWith(key, o.raw, 'sd|lk|old'));
    await setSlot(raw);
    rec.old = boxes;
    await kv.put(rec);
    LKraw = raw; LK = key; olds = prev;
  }
  // Turn on a lock whose key (k) only the PIN or the screen lock can produce.
  async function enableKeyLock(lock, k, aad) {
    const hadFile = !!(rec.device && rec.device.opfs);
    if (rec.dirty || !hadFile) {
      await rotate(async raw => { lock.box = await sealWith(k, raw, aad); rec.lock = lock; rec.device = null; rec.dirty = false; });
      if (hadFile) await boxRemove();
      return;
    }
    // clean install: store the lock first (both ways in still work), then remove the file for good
    lock.box = await sealWith(k, LKraw, aad); rec.lock = lock;
    await kv.put(rec);
    if (await boxRemove()) { rec.device = null; await kv.put(rec); }
    else await rotate(async raw => { lock.box = await sealWith(k, raw, aad); rec.device = null; rec.dirty = false; });
  }
  // after a PIN / screen-lock unlock: finish a lock set-up that was interrupted, or renew a key
  // whose older copy may still linger in storage
  async function afterKeyUnlock(k, aad) {
    await loadOlds();
    const L = rec.lock; if (!rec.device && !rec.dirty) return;
    const gone = rec.device && rec.device.opfs ? await boxRemove() : false;
    if (rec.device && gone && !rec.dirty) { rec.device = null; await kv.put(rec); return; }
    await rotate(async raw => { L.box = await sealWith(k, raw, aad); rec.device = null; rec.dirty = false; });
  }

  // ---------- WebAuthn (fingerprint / screen lock) ----------
  const webauthnOk = () => !!(self.PublicKeyCredential && navigator.credentials && navigator.credentials.create && self.isSecureContext);
  async function biometricAvailable() { try { return webauthnOk() && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch (e) { return false; } }
  const prfOut = c => { try { const r = c.getClientExtensionResults().prf; return r && r.results && r.results.first ? r.results.first : null; } catch (e) { return null; } };
  function derToRaw(der) {           // ECDSA DER signature -> r||s (64 bytes)
    let i = 2; if (der[1] & 0x80) i += der[1] & 0x7f;
    const out = new Uint8Array(64);
    for (let k = 0; k < 2; k++) {
      if (der[i++] !== 2) throw new Error('bad signature');
      let len = der[i++], start = i; while (len > 32) { start++; len--; }
      out.set(der.subarray(start, start + len), k * 32 + 32 - len); i = start + len;
    }
    return out;
  }
  async function verifyAssertion(a, challenge, L) {
    const r = a.response, cd = JSON.parse(td.decode(r.clientDataJSON));
    if (cd.type !== 'webauthn.get' || cd.challenge !== b64url(challenge)) throw new Error('challenge mismatch');
    const ad = new Uint8Array(r.authenticatorData);
    if (!(ad[32] & 0x04)) throw new Error('the screen lock was not verified');
    if (!L.pubKey) return;
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', r.clientDataJSON));
    const data = new Uint8Array(ad.length + 32); data.set(ad); data.set(hash, ad.length);
    const spki = unb64(L.pubKey); let ok = false;
    if (L.alg === -7) {
      const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(new Uint8Array(r.signature)), data);
    } else if (L.alg === -257) {
      const key = await crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, r.signature, data);
    } else throw new Error('unknown key type');
    if (!ok) throw new Error('signature invalid');
  }
  function getOptions(L, challenge) {
    const pub = { challenge, rpId: location.hostname, allowCredentials: [{ type: 'public-key', id: unb64(L.credId) }], userVerification: 'required', timeout: 60000 };
    if (L.type === 'prf') pub.extensions = { prf: { eval: { first: unb64(L.prfSalt) } } };
    return pub;
  }
  // Turns the fingerprint / screen lock on. Returns 'prf' when the key is bound to the screen lock,
  // 'gate' when this browser cannot do that and the lock only guards the app screen. A cancelled
  // or failed confirmation throws; it never quietly becomes the weaker lock.
  async function setBiometric() {
    need(LK);
    const prfSalt = rand(32);
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: rand(32), rp: { name: 'Snapdoc', id: location.hostname }, user: { id: rand(16), name: 'Snapdoc', displayName: 'Snapdoc' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      timeout: 60000, attestation: 'none', extensions: { prf: { eval: { first: prfSalt } } } } });
    const L = { credId: b64(cred.rawId), pubKey: null, alg: null };
    try { const pk = cred.response.getPublicKey && cred.response.getPublicKey(); if (pk) { L.pubKey = b64(pk); L.alg = cred.response.getPublicKeyAlgorithm(); } } catch (e) {}
    let ext = {}; try { ext = cred.getClientExtensionResults() || {}; } catch (e) {}
    let out = ext.prf && ext.prf.results && ext.prf.results.first ? ext.prf.results.first : null;
    if (!out && ext.prf && ext.prf.enabled)             // most phones release the secret only on a second confirmation
      out = prfOut(await navigator.credentials.get({ publicKey: getOptions({ type: 'prf', credId: L.credId, prfSalt: b64(prfSalt) }, rand(32)) }));
    if (out) {
      L.type = 'prf'; L.prfSalt = b64(prfSalt);
      await enableKeyLock(L, await hkdfKey(out), 'sd|lk|prf');
      return 'prf';
    }
    L.type = 'gate';
    if (!rec.device) { const ds = await deviceSlot(); rec.device = ds.slot; if (!ds.clean) rec.dirty = true; }
    rec.lock = L; await kv.put(rec);
    return 'gate';
  }
  async function setPin(pin) {
    need(LK);
    const salt = rand(16), k = await pbkdfKey(pin, salt, PBKDF_ITER);
    await enableKeyLock({ type: 'pin', salt: b64(salt), iter: PBKDF_ITER, numeric: /^\d+$/.test(pin) }, k, 'sd|lk|pin');
  }
  async function clearLock() {
    need(LK);
    const ds = await deviceSlot();
    rec.device = ds.slot; rec.lock = null; if (!ds.clean) rec.dirty = true;
    await kv.put(rec);
  }
  async function unlock(secret, signal) {
    const L = rec.lock;
    if (!L) { await openDevice(); await loadOlds(); return; }
    if (L.type === 'pin') {
      const k = await pbkdfKey(secret || '', unb64(L.salt), L.iter);
      let raw; try { raw = await openWith(k, L.box, 'sd|lk|pin'); } catch (e) { throw new Error('Wrong PIN or password'); }
      await setLK(raw); await afterKeyUnlock(k, 'sd|lk|pin'); return;
    }
    const challenge = rand(32);
    const a = await navigator.credentials.get({ publicKey: getOptions(L, challenge), signal });
    if (L.type === 'prf') {
      const out = prfOut(a); if (!out) throw new Error('The screen lock did not release the key.');
      const k = await hkdfKey(out);
      let raw; try { raw = await openWith(k, L.box, 'sd|lk|prf'); } catch (e) { throw new Error('This screen lock does not match the one that locked the app.'); }
      await setLK(raw); await afterKeyUnlock(k, 'sd|lk|prf'); return;
    }
    await verifyAssertion(a, challenge, L);
    await openDevice(); await loadOlds();
  }
  // background re-encryption after a key change: returns a new sealed buffer, or null when the
  // record is already under the current key
  async function reseal(buf, aad) {
    try { await openWith(need(LK), buf, aad); return null; } catch (e) {}
    for (const o of olds) { let plain; try { plain = await openWith(o.key, buf, aad); } catch (e) { continue; } return sealWith(LK, plain, aad); }
    throw new Error('a stored record cannot be opened with any key');
  }
  async function dropOldKeys() { need(LK); rec.old = []; await kv.put(rec); olds = []; }

  // ---------- cloud key and its password envelope ----------
  async function loadCloudKey(uid) {
    CK = CKraw = null; ckUid = null;
    const r = await kv.get(CK_ID); if (!r || r.uid !== uid) return false;
    CKraw = new Uint8Array(await openLocal(r.box, 'sd|ck|local|' + uid)); CK = await importAes(CKraw); ckUid = uid;
    return true;
  }
  async function keepCloudKey(raw, uid) {
    CKraw = new Uint8Array(raw); CK = await importAes(CKraw); ckUid = uid;
    await kv.put({ id: CK_ID, uid, box: await sealWith(need(LK), CKraw, 'sd|ck|local|' + uid) });
  }
  async function resealCloudKey() {
    const r = await kv.get(CK_ID); if (!r) return;
    const nb = await reseal(r.box, 'sd|ck|local|' + r.uid); if (nb) await kv.put({ id: CK_ID, uid: r.uid, box: nb });
  }
  async function wrapEnvelope(raw, password, uid) {
    const salt = rand(16), k = await pbkdfKey(password, salt, PBKDF_ITER);
    return { salt: b64(salt), iter: PBKDF_ITER, wrapped: b64(await sealWith(k, raw, 'sd|ck|env|' + uid)) };
  }
  // First device: make a key and its envelope. The key is only kept once commit() is called,
  // which the caller does after the envelope is safely stored in the cloud.
  async function newEnvelope(password, uid) {
    const raw = rand(32);
    return { env: await wrapEnvelope(raw, password, uid), commit: () => keepCloudKey(raw, uid) };
  }
  async function openEnvelope(env, password, uid) {
    const iter = Math.min(5000000, Math.max(100000, +env.iter || 0));
    const k = await pbkdfKey(password, unb64(env.salt), iter);
    let raw; try { raw = await openWith(k, unb64(env.wrapped), 'sd|ck|env|' + uid); } catch (e) { throw new Error('Wrong encryption password'); }
    await keepCloudKey(raw, uid);
  }
  const rewrapEnvelope = (password, uid) => wrapEnvelope(need(CKraw), password, uid);
  async function dropCloudKey() { CK = CKraw = null; ckUid = null; if (kv) await kv.del(CK_ID); }
  function suggestPassword() {
    const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', out = []; let s = '';      // 31 symbols, about 99 bits, no modulo bias
    while (out.length < 20) for (const b of rand(40)) if (b < 248 && out.length < 20) out.push(abc[b % 31]);
    for (let i = 0; i < 20; i++) { if (i && i % 5 === 0) s += '-'; s += out[i]; }
    return s;
  }

  return {
    load, unlock, setBiometric, setPin, clearLock, biometricAvailable, suggestPassword,
    isOpen: () => !!LK, lockType: () => rec && rec.lock ? rec.lock.type : null, pinIsNumeric: () => !!(rec && rec.lock && rec.lock.numeric),
    hasOldKeys: () => olds.length > 0, reseal, resealCloudKey, dropOldKeys,
    seal: (data, aad) => sealWith(need(LK), data, aad), open: openLocal,
    sealBlob: async (blob, aad) => sealWith(need(LK), await blob.arrayBuffer(), aad),
    openBlob: async (buf, aad, type) => new Blob([await openLocal(buf, aad)], { type: type || 'application/octet-stream' }),
    sealJson: (obj, aad) => sealWith(need(LK), te.encode(JSON.stringify(obj)), aad),
    openJson: async (buf, aad) => JSON.parse(td.decode(await openLocal(buf, aad))),
    hasCloudKey: uid => !!CK && ckUid === uid, loadCloudKey, newEnvelope, openEnvelope, rewrapEnvelope, dropCloudKey,
    cseal: (data, aad) => sealWith(need(CK), data, aad), copen: (buf, aad) => openWith(need(CK), buf, aad),
    csealJson: async (obj, aad) => b64(await sealWith(need(CK), te.encode(JSON.stringify(obj)), aad)),
    copenJson: async (s, aad) => JSON.parse(td.decode(await openWith(need(CK), unb64(s), aad)))
  };
})();
