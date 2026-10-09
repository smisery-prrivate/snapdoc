# Snapdoc

Scan documents with the phone camera, keep them as PDFs, share them, sync them encrypted to your
own cloud. Modelled on Genius Scan; built the Brain Relieve way (web app, no build step, local
first). Working name, visible in `index.html`, `manifest.json` and `VERSION` in `app-core.js`.

## What it does

- **Scan.** Big button opens the camera. The page outline is found live and glides along as the
  phone moves. *Single* takes one page and goes straight to the document. *Batch* keeps the camera
  open and counts pages; *Done* closes. *Auto* (on by default) takes the picture by itself once
  all four edges hold still for about a second, and arms again only when that page has really
  gone (the outline vanished, or what lies inside it changed). After every shot the cropped,
  cleaned page pops up for a moment and lands on the Done button, so the crop is seen at once.
  The picture button imports photos from the library instead.
- **Name.** A new document is called `YYYY-MM-DD ` with the cursor behind the space, keyboard open.
  An OK button next to the field saves the name and says so.
- **Document view.** All pages one below the other. Tap a page for its tools: move up, move
  down, rotate, crop (drag the four corners under a magnifier, then pick the look), delete with
  undo. Deleting the only page asks to delete the document. Looks: Color, Gray, Black & white,
  Photo. `+ Pages` adds more.
- **Share PDF.** One PDF per document through the Android share sheet; on a PC it is saved as a
  file. `⋯` also offers save, rename and delete.
- **Sync.** Optional. Sign in by e-mail link, choose an encryption password once, and every
  document appears on every device that signs in and knows the password.
- **Lock.** Optional. Fingerprint or screen lock, or a password or long PIN.

## Encryption

Everything is encrypted with AES-256-GCM, all in `vault.js` (WebCrypto, no libraries).

- **On the device.** One random *local key* per device encrypts every page image, every PDF,
  every thumbnail, the document list and the sign-in token. Nothing readable is written to
  browser storage.
  - Without a lock the key is wrapped by a second key that scripts cannot export. The wrapped
    copy lies in a small private file, not in the database, because a file can really be removed
    again while database files keep overwritten entries around for an unknown time.
  - With the **fingerprint / screen lock** the key is wrapped by a secret that only the phone's
    authenticator releases (WebAuthn PRF). Turning the lock on deletes the private file. A
    cancelled confirmation never quietly becomes a weaker lock. Browsers that cannot bind the key
    fall back to a *gate* (the lock guards the screen only) and the menu says so in its title.
  - With a **password or long PIN** the key is derived from it (PBKDF2, 600,000 rounds). Digit-only
    PINs need 12 digits, because a computer can try all shorter ones against a copy of the storage.
  - If an older copy of the key may still linger in storage (an install from before version 3, or
    a browser without private files), turning a lock on makes a **new key** for everything written
    from then on. The previous key stays reachable only through the new one, older records are
    re-encrypted in the background, and then the previous key is dropped.
  - Honest limit: a web page cannot scrub the browser's storage files. Scans stored before a lock
    was turned on can remain recoverable from a forensic copy of the storage for some time. Turn
    the lock on before scanning anything sensitive.
- **In the cloud.** A second random key, the *cloud key*, encrypts each PDF and each document's
  name, page count and size before upload. The cloud key travels between devices only inside an
  envelope wrapped with the **encryption password** (PBKDF2, 600,000 rounds). The password never
  leaves the device.
- **What the server cannot do.** Read anything. Change an entry: every entry is sealed together
  with its revision, change time and delete flag, and an entry that does not match its seal is
  rejected and reported. Delete a document on a device with a forged delete marker. Hand out an
  older file for a newer entry: the file carries its revision inside the encryption.
- **Consequences.** The files in the cloud bucket are not PDFs; they become PDFs again inside the
  app, on any device or browser, after sign-in plus password. A lost password cannot be reset; a
  device that is still set up can set a new one. A lost lock means *Reset this app* on that
  device; synced documents come back from the cloud, unsynced ones are gone.
- **Nothing else leaves the device.** No cookies, no analytics, no third-party scripts or
  fonts. A Content-Security-Policy in `index.html` allows connections to the app's own origin
  and the one Supabase project only, and no inline script.
- **Shared web address.** All of the owner's GitHub Pages apps live on one origin, which
  browsers treat as one site: a script running in a sibling app could reach Snapdoc's storage.
  With a key-bound lock the key is out of its reach. Full separation needs an address of its own.

## The lock screen

- Away longer than the chosen time, in front or in the background: locked again. When nothing is
  in flight the page restarts, which also clears the key and every decrypted image from memory.
- While work is in flight (pages processing, a sync, the share sheet) the lock screen covers the
  app at once instead: open popups and the menu close without acting, everything underneath is
  switched off, and the restart follows as soon as the work is done. Nothing is cut off.

## One active window

Only one tab or window is active at a time (Web Locks plus an owner mark that every write checks).
A second window takes over when the first is in the background, or offers "Use Snapdoc here" when
the first is in use. The window that stepped aside can no longer write, so two copies of the app
can never overwrite each other's work.

## Files

| File | Role |
| --- | --- |
| `index.html` | Layout and styles, no inline script (the CSP forbids it) |
| `imaging.js` | Edge detection, perspective correction, looks, PDF writer and reader |
| `worker.js` | Runs `imaging.js` off the main thread (one worker for processing, one for the live outline) |
| `vault.js` | All cryptography and the lock methods |
| `app-core.js` | Helpers, the write guard, encrypted storage, document model, processing queue, screens |
| `app-docs.js` | Document list, document view, PDF and sharing, page editor |
| `app-cam.js` | Camera, live outline, automatic capture, photo import |
| `app-lock.js` | Lock screen and the menu |
| `app-sync.js` | Sign-in, encryption password, sync loop |
| `app-boot.js` | Becoming the active window, start-up order, updates, housekeeping |
| `sw.js` | Offline: holds one complete release |
| `supabase-schema.sql` | Tables, policies and the private bucket (run once) |

The script files share one scope and load in the order above. There is no build step.

## Sync rules

- Local first. The app works fully without an account.
- One entry per document (`sd_documents`) and one encrypted file (`sd/<user>/<document id>`).
- **Pages** have a revision and a random tag. A device uploads when its pages are newer than what
  the cloud last agreed on, and downloads when the cloud has moved on.
- **Both changed the pages** since they last agreed: nothing is overwritten. The device keeps its
  own version as a separate document, "… (copy from this device)", and takes the cloud version.
- **Pages cannot be added or changed while a newer version is still downloading.** A page that is
  being scanned at that moment waits and is added to the downloaded version.
- **Name and deletion** follow the later change. A document deleted on one device and renamed
  later on another comes back whole: the renaming device uploads the file again.
- The server stamps each write (`synced_at`); devices pull everything stamped after their last
  visit, with a three-second overlap. Entries are idempotent.
- Deletes are sealed markers; the file is removed from the bucket and that removal is repeated
  until the cloud confirms it.
- One document that cannot be uploaded (too large, a page missing) is named in the status and
  does not hold up the others.
- A PDF is never built or uploaded with a page left out.
- Every device downloads every PDF, so all documents are available offline.
- Sync status is always visible on the home screen; failures show their reason in the menu.
- A sign-in link is accepted only if this browser asked for one within the last hour, nobody is
  signed in, and the cloud confirms the token.

## Offline and updates

The service worker stores one complete release, fetched past the browser's HTTP cache in one go.
The app starts from that set without waiting for the network. A new release arrives as a new
worker; when it has taken over, the page restarts at a quiet moment (with a lock set: at the next
unlock). A release with a missing file is never activated. The page therefore never runs a mix
of two versions.

## Housekeeping

- The original photo of each page is kept for 30 days so it can be re-cropped without loss;
  after that only the finished scan stays.
- Captures that never finished (app closed mid-processing) leave nothing behind.
- Stored records that nothing refers to any more are removed once they are older than an hour.
- Scans are stored at up to 2400 px on the long side, JPEG quality 0.82: about 200 dpi on A4.
- If the browser does not promise to keep the stored data, the menu says so while scans exist
  only on this device.

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
first, then the migration. A change of the sync format bumps `SYNC_FMT` in `app-sync.js`, which
makes every device send what it holds once more in the new form.

## History

- v1, v2 (2026-10-09): first release; sync switched on with its own cloud project.
- v3: fixes for all 57 findings of an independent review (see `REVIEW.md`), cropped-page preview
  after each shot, OK button for the name, smooth live outline, one active window, releases that
  arrive as one unit.

## Tested, and not yet

Tested in desktop Chrome with a simulated phone, a fake camera, a simulated fingerprint sensor
and a stand-in for the cloud. The scripts are kept in `_preview/tests` (not published): run
`gen_assets.py` once for the test photos and fake-camera file, install `puppeteer-core`, start
the local server on port 8792, then the `t*.js` files and `test-detect.js`. Not yet tested on an
iPhone. The live outline and the automatic capture can only be judged on a real phone.

## Not built (Genius Scan has it)

Text recognition (OCR) and search inside scans, PDF password protection of exported files,
tags and folders, importing existing PDFs, export to Drive/Dropbox, a search field in the list.
