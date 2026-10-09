'use strict';
/* Snapdoc vault — all cryptography in one place. WebCrypto only, no libraries.

   LK  local key   random AES-256-GCM key, one per device. Encrypts everything this app stores
                   on the device. It is kept in "slots":
                     device  wrapped by a non-extractable key that lives next to the data
                             (used while no lock is set, and by the "gate" lock)
                     prf     wrapped by a key the phone's screen lock / fingerprint releases
                             (WebAuthn PRF). Without the authenticator the data cannot be opened.
                     pin     wrapped by a key derived from a PIN or password (PBKDF2)
   CK  cloud key   random AES-256-GCM key shared by the user's devices. Encrypts everything that
                   is uploaded. It travels between devices only inside an "envelope" that is
                   wrapped with the user's encryption password; the server never sees CK. */
const Vault = (() => {
  const te = new TextEncoder(), td = new TextDecoder();
  const KEYS_ID = 'keys', CK_ID = 'ck', PBKDF_ITER = 600000;
  let kv = null, rec = null, LK = null, LKraw = null, CK = null, CKraw = null, ckUid = null;

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

  // ---------- local key slots ----------
  async function deviceSlot() {
    const wk = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    return { wk, box: await sealWith(wk, LKraw, 'sd|lk|device') };
  }
  async function openDevice() {
    if (!rec.device) throw new Error('The key for this device is missing.');
    await setLK(await openWith(rec.device.wk, rec.device.box, 'sd|lk|device'));
  }
  // returns 'open' (no lock set, key loaded) or 'locked' (call unlock)
  async function load(store) {
    kv = store; rec = await kv.get(KEYS_ID);
    if (!rec) {
      await setLK(rand(32));
      rec = { id: KEYS_ID, v: 1, device: await deviceSlot(), lock: null };
      await kv.put(rec);
      return 'open';
    }
    if (!rec.lock) { await openDevice(); return 'open'; }
    return 'locked';
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
  // 'gate' when this browser cannot do that and the lock only guards the app screen.
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
    if (!out && ext.prf && ext.prf.enabled) {           // most phones release the secret only on a second confirmation
      L.type = 'prf'; L.prfSalt = b64(prfSalt);
      try { out = prfOut(await navigator.credentials.get({ publicKey: getOptions(L, rand(32)) })); } catch (e) { out = null; }
    }
    if (out) {
      L.type = 'prf'; L.prfSalt = b64(prfSalt); L.box = await sealWith(await hkdfKey(out), LKraw, 'sd|lk|prf');
      rec.lock = L; rec.device = null;
    } else {
      L.type = 'gate'; delete L.prfSalt;
      rec.lock = L; if (!rec.device) rec.device = await deviceSlot();
    }
    await kv.put(rec);
    return L.type;
  }
  async function setPin(pin) {
    need(LK);
    const salt = rand(16), k = await pbkdfKey(pin, salt, PBKDF_ITER);
    rec.lock = { type: 'pin', salt: b64(salt), iter: PBKDF_ITER, numeric: /^\d+$/.test(pin), box: await sealWith(k, LKraw, 'sd|lk|pin') };
    rec.device = null;
    await kv.put(rec);
  }
  async function clearLock() {
    need(LK);
    rec.device = await deviceSlot(); rec.lock = null;
    await kv.put(rec);
  }
  async function unlock(secret, signal) {
    const L = rec.lock;
    if (!L) { await openDevice(); return; }
    if (L.type === 'pin') {
      const k = await pbkdfKey(secret || '', unb64(L.salt), L.iter);
      let raw; try { raw = await openWith(k, L.box, 'sd|lk|pin'); } catch (e) { throw new Error('Wrong PIN'); }
      await setLK(raw); return;
    }
    const challenge = rand(32);
    const a = await navigator.credentials.get({ publicKey: getOptions(L, challenge), signal });
    if (L.type === 'prf') {
      const out = prfOut(a); if (!out) throw new Error('The screen lock did not release the key.');
      let raw; try { raw = await openWith(await hkdfKey(out), L.box, 'sd|lk|prf'); } catch (e) { throw new Error('This screen lock does not match the one that locked the app.'); }
      await setLK(raw); return;
    }
    await verifyAssertion(a, challenge, L);
    await openDevice();
  }

  // ---------- cloud key and its password envelope ----------
  async function loadCloudKey(uid) {
    CK = CKraw = null; ckUid = null;
    const r = await kv.get(CK_ID); if (!r || r.uid !== uid) return false;
    CKraw = new Uint8Array(await openWith(need(LK), r.box, 'sd|ck|local|' + uid)); CK = await importAes(CKraw); ckUid = uid;
    return true;
  }
  async function keepCloudKey(raw, uid) {
    CKraw = new Uint8Array(raw); CK = await importAes(CKraw); ckUid = uid;
    await kv.put({ id: CK_ID, uid, box: await sealWith(need(LK), CKraw, 'sd|ck|local|' + uid) });
  }
  async function wrapEnvelope(raw, password, uid) {
    const salt = rand(16), kek = await pbkdfKey(password, salt, PBKDF_ITER);
    return { salt: b64(salt), iter: PBKDF_ITER, wrapped: b64(await sealWith(kek, raw, 'sd|ck|env|' + uid)) };
  }
  // First device: make a key and its envelope. The key is only kept once commit() is called,
  // which the caller does after the envelope is safely stored in the cloud.
  async function newEnvelope(password, uid) {
    const raw = rand(32);
    return { env: await wrapEnvelope(raw, password, uid), commit: () => keepCloudKey(raw, uid) };
  }
  async function openEnvelope(env, password, uid) {
    const iter = Math.min(5000000, Math.max(100000, +env.iter || 0));
    const kek = await pbkdfKey(password, unb64(env.salt), iter);
    let raw; try { raw = await openWith(kek, unb64(env.wrapped), 'sd|ck|env|' + uid); } catch (e) { throw new Error('Wrong encryption password'); }
    await keepCloudKey(raw, uid);
  }
  const rewrapEnvelope = (password, uid) => wrapEnvelope(need(CKraw), password, uid);
  async function dropCloudKey() { CK = CKraw = null; ckUid = null; if (kv) await kv.del(CK_ID); }
  function suggestPassword() {
    const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', r = rand(20); let s = '';      // 31 symbols, about 99 bits
    for (let i = 0; i < 20; i++) { if (i && i % 5 === 0) s += '-'; s += abc[r[i] % abc.length]; }
    return s;
  }

  return {
    load, unlock, setBiometric, setPin, clearLock, biometricAvailable, suggestPassword,
    isOpen: () => !!LK, lockType: () => rec && rec.lock ? rec.lock.type : null, pinIsNumeric: () => !!(rec && rec.lock && rec.lock.numeric),
    seal: (data, aad) => sealWith(need(LK), data, aad), open: (buf, aad) => openWith(need(LK), buf, aad),
    sealBlob: async (blob, aad) => sealWith(need(LK), await blob.arrayBuffer(), aad),
    openBlob: async (buf, aad, type) => new Blob([await openWith(need(LK), buf, aad)], { type: type || 'application/octet-stream' }),
    sealJson: (obj, aad) => sealWith(need(LK), te.encode(JSON.stringify(obj)), aad),
    openJson: async (buf, aad) => JSON.parse(td.decode(await openWith(need(LK), buf, aad))),
    hasCloudKey: uid => !!CK && ckUid === uid, loadCloudKey, newEnvelope, openEnvelope, rewrapEnvelope, dropCloudKey,
    cseal: (data, aad) => sealWith(need(CK), data, aad), copen: (buf, aad) => openWith(need(CK), buf, aad),
    csealJson: async (obj, aad) => b64(await sealWith(need(CK), te.encode(JSON.stringify(obj)), aad)),
    copenJson: async (s, aad) => JSON.parse(td.decode(await openWith(need(CK), unb64(s), aad)))
  };
})();
