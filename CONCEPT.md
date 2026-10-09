# Snapdoc

Scan documents with the phone camera, keep them as PDFs, share them, sync them encrypted to your
own cloud. Modelled on Genius Scan; built the Brain Relieve way (web app, no build step, local
first). Working name, visible in `index.html`, `manifest.json` and `VERSION` in `app-core.js`.

## What it does (v1)

- **Scan.** Big button opens the camera. Edges are found live and drawn on the picture.
  *Single* takes one page and goes straight to the document. *Batch* keeps the camera open and
  counts pages; *Done* closes. *Auto* (on by default) takes the picture by itself once all four
  edges hold still for about a second, and waits for the page to leave before it arms again.
  The picture button imports photos from the library instead.
- **Name.** A new document is called `YYYY-MM-DD ` with the cursor behind the space, keyboard open.
- **Document view.** All pages one below the other. Tap a page for its tools: move up, move
  down, rotate, crop (drag the four corners under a magnifier, then pick the look), delete with
  undo. Looks: Color, Gray, Black & white, Photo. `+ Pages` adds more.
- **Share PDF.** One PDF per document through the Android share sheet; on a PC it is saved as a
  file. `⋯` also offers save, rename and delete.
- **Sync.** Optional. Sign in by e-mail link, choose an encryption password once, and every
  document appears on every device that signs in and knows the password.
- **Lock.** Optional. Fingerprint or screen lock, or a PIN/password.

## Encryption

Everything is encrypted with AES-256-GCM, all in `vault.js` (WebCrypto, no libraries).

- **On the device.** One random *local key* per device encrypts every page image, every PDF,
  every thumbnail, the document list and the sign-in token. Nothing readable is written to
  browser storage. Without a lock the key is stored next to the data in a form scripts cannot
  export. With the **fingerprint / screen lock** the key is wrapped by a secret that only the
  phone's authenticator releases (WebAuthn PRF), and the stored copy is removed: a copy of the
  app's storage is useless without the phone's screen lock. Browsers that cannot do this fall
  back to a *gate* (the lock guards the screen only) and the menu says so. With a **PIN or
  password** the key is derived from it (PBKDF2, 600,000 rounds).
- **In the cloud.** A second random key, the *cloud key*, encrypts each PDF and each
  document's name, page count and size before upload. The cloud key travels between devices
  only inside an envelope wrapped with the **encryption password** (PBKDF2, 600,000 rounds).
  The password never leaves the device. The server stores ciphertext plus three technical
  numbers per document (revision, change time, deleted flag).
- **Consequences.** The files in the cloud bucket are not PDFs; they become PDFs again inside
  the app, on any device or browser, after sign-in plus password. A lost password cannot be
  reset; a device that is still set up can set a new one (Menu, Change encryption password).
  A lost fingerprint lock or PIN means *Reset this app* on that device; synced documents come
  back from the cloud, unsynced ones are gone.
- **Nothing else leaves the device.** No cookies, no analytics, no third-party scripts or
  fonts. A Content-Security-Policy in `index.html` allows connections to the app's own origin
  and the one Supabase project only.

## Files

| File | Role |
| --- | --- |
| `index.html` | Layout and styles, no inline script (the CSP forbids it) |
| `imaging.js` | Edge detection, perspective correction, looks, PDF writer and reader |
| `worker.js` | Runs `imaging.js` off the main thread |
| `vault.js` | All cryptography and the lock methods |
| `app-core.js` | Helpers, encrypted storage, document model, processing queue, screens |
| `app-docs.js` | Document list, document view, PDF and sharing, page editor |
| `app-cam.js` | Camera, automatic capture, photo import |
| `app-lock.js` | Lock screen and the menu |
| `app-sync.js` | Sign-in, encryption password, sync loop |
| `app-boot.js` | Start-up order, housekeeping |
| `supabase-schema.sql` | Tables, policies and the private bucket (run once) |

The script files share one scope and load in the order above. There is no build step.

## Sync rules

- Local first. The app works fully without an account.
- One row per document (`sd_documents`) and one encrypted file (`sd/<user>/<document id>`).
- Pages follow the **higher revision**; name and deletion follow the **later change**. A new
  revision is made whenever pages change; the whole PDF is uploaded again.
- The server stamps each write (`synced_at`); devices pull everything stamped after their last
  visit, with a three-second overlap. Rows are idempotent.
- Deletes are tombstones with an empty `meta`; the file is removed from the bucket.
- Every device downloads every PDF, so all documents are available offline.
- Sync status is always visible on the home screen; failures show their reason in the menu.

## Housekeeping

- The original photo of each page is kept for 30 days so it can be re-cropped without loss;
  after that only the finished scan stays.
- Captures that never finished (app closed mid-processing) leave nothing behind.
- Scans are stored at up to 2400 px on the long side, JPEG quality 0.82: about 200 dpi on A4.

## Set-up (once)

Snapdoc has its **own Supabase project**, not shared with Brain Relieve or Stillzeit (Pat's
decision, 2026-10-09): private documents get their own account list, mail limit and storage, and
new sign-ups can be switched off once the owner has signed in.

1. Create the project (EU region), put its address and publishable key into `config.js`, and
   add the address to `connect-src` in the Content-Security-Policy of `index.html`.
2. Run `supabase-schema.sql` in that project's SQL editor.
3. Authentication, URL Configuration: Site URL and redirect URL = the app's address.
4. After the first sign-in: Authentication, switch off new sign-ups.
5. The folder is published with GitHub Pages (camera and fingerprint need HTTPS).

Free Supabase projects pause after a week without requests; restart in the dashboard.

## Release habit

`VERSION` in `app-core.js`, `CACHE` in `sw.js` and the commit message move together. New
files go into the `ASSETS` list in `sw.js`. A cloud schema change ships the tolerant client
first, then the migration.

## Tested, and not yet

Tested in desktop Chrome with a simulated phone, a fake camera, a simulated fingerprint sensor
and a stand-in for the cloud. The scripts are kept in `_preview/tests` (not published): run
`gen_assets.py` once for the test photos and fake-camera file, install `puppeteer-core`, start
the local server on port 8792, then `node t1-scan.js`, `t2-sync.js`, `t3-lock.js`,
`test-detect.js`. Not yet tested on a real Android phone, against the real cloud, or on an
iPhone.

## Not built (Genius Scan has it)

Text recognition (OCR) and search inside scans, PDF password protection of exported files,
tags and folders, importing existing PDFs, export to Drive/Dropbox, a search field in the list.
