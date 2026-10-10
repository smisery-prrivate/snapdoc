# Snapdoc

Scan documents with the phone camera, keep them as PDFs, share them, sync them encrypted to your
own cloud. Modelled on Genius Scan; built the Brain Relieve way (web app, no build step, local
first). Working name, visible in `index.html`, `manifest.json` and `VERSION` in `app-core.js`.

## What it does

- **Scan.** Big button opens the camera. The page outline is found live and glides along as the
  phone moves. *Single* takes one page and goes straight to the document. *Batch* keeps the camera
  open and counts pages; *Done* closes. *Auto* (on by default) takes the picture by itself once
  all four edges hold still for about a second, and arms again only when that page has really
  gone (the outline vanished, or what lies inside it changed). The moment a shot is taken, the
  cropped page pops up large, with an **Adjust crop** button, and then lands on the Done button,
  so the crop is seen at once and can be corrected at once. The pop-up is made from the live
  picture in a fraction of a second; the full-size photo is worked on in the background and takes
  its place when it is ready (if the photo turns out to be cut differently, the stored page is
  shown again). After a single shot the same quick picture stands in for the page in the
  document, marked "Finishing". The picture button imports photos from the library instead.
- **The picture is not changed.** A page is the photo as it was taken, cut to the page and
  straightened. No brightening, no filter. (Looks exist in the code and are switched off, see
  "The look of a page".)
- **Find and pick.** A search field above the list filters by name and date as you type.
  *Select*, or a long press on a document, turns the list into a pick list: a tap picks a
  document instead of opening it, and the bar at the bottom shares, saves or deletes all picked
  documents at once.
- **Name.** A new document is called `YYYY-MM-DD ` with the cursor behind the space, keyboard open.
  An OK button next to the field saves the name and says so.
- **Document view.** All pages one below the other. Every page carries an **Adjust crop**
  button: one tap opens the photo with its four corners, drag them under a magnifier, Done. It
  also works while the page is still marked "Finishing"; the corners then open as soon as the
  page is there. Tap a page for its other tools: move up, move down, rotate, delete with undo.
  Deleting the only page asks to delete the document. `+ Pages` adds more.
- **Share PDF.** One PDF per document through the Android share sheet; on a PC it is saved as a
  file. `⋯` also offers save, rename and delete.
- **Sync.** Optional. Sign in by e-mail link, choose an encryption password once, and every
  document appears on every device that signs in and knows the password.
- **Lock.** Optional. Fingerprint or screen lock, or a password or long PIN.
- **Google Drive copies.** Optional (`app-drive.js`, needs `googleClientId` in `config.js`). Once
  a Google account is connected in the menu, every document is kept as a plain PDF in a folder
  "Snapdoc" of that account: uploaded from the device right after a scan, renamed and replaced
  after a rename or a page change, moved to the Drive bin when the document is deleted. The PDFs
  are readable in Drive on purpose; the way there is HTTPS. The app asks Google only for the files
  it created itself (scope `drive.file`) and loads no Google script: the sign-in is a redirect to
  Google and back, with a one-time token in the address that is cleaned at once. The access token
  lives one hour and is stored encrypted; when it has run out and something is waiting, the app
  reconnects by itself through a redirect without a screen (never with a lock on: then the menu
  and the status line ask for a tap). Each file carries the document id, so a second device that
  is also connected finds the file instead of creating it twice.

## The look of a page

**Switched off since v5** (`LOOKS = false` in `app-core.js`): the owner wants the picture exactly
as taken, options may come later. With the switch off every page is stored with the look
`photo`, the menu has no "Default look" and the editor has no Look step. Turning the switch on
brings both back. A page that was scanned with a look in an earlier version keeps its picture
until it is rotated or cropped again; then it is rendered from its original photo without a look.

What the looks do when they are on: the *Color* look removes only the lighting (`IMG.enhance`
in `imaging.js`):

- It works out what blank paper looks like at every spot of the page: shadows, brightness that
  falls off toward one side, the tint of the lamp. A small copy of the page with everything thin
  and dark closed away (text, lines) gives that picture.
- It does not trust that picture everywhere. A dark header, a photo, a filled table cell, a
  tinted box or a bright spot inside a picture is content, not lighting. There the lighting is
  filled in from the paper around it, so content is never brightened away.
- The page is divided by that lighting. Near-white becomes white, which also removes paper grain
  and sensor noise. The greys below are deepened a little, so pale print (a thermal receipt,
  pencil) reads on white as it did on grey.
- Clearly coloured paper keeps its colour, and light print on a dark sheet stays light. A faint
  tint counts as the lamp and is removed.
- A capture that is out of focus as a whole is recognised (there is content, but no pixel is
  clearly darker than its surroundings) and is not bleached: its weak grey lines are kept.

*Gray* does the same without colour, *Black & white* reduces the page to ink and paper, *Photo*
changes nothing. `t10-look.js` holds this in place on a set of photographed-looking test pages.

## Finding the page

`IMG.detectQuad` in `imaging.js` finds the four corners of the sheet, for the live outline, for
the quick picture after a shot and for the stored page. It works on a small copy of the picture:
the brightness and colour steps give two edge maps, the regions between the edges are outlined,
the outlines are simplified into straight runs, and four runs at a time are tried as the sides
of the page. Every candidate is scored by how much of each side really is an edge and whether
the sides meet at the corners; if none is convincing, nothing is returned (the whole photo is
then kept and the crop can be set by hand). The outline of the frame before is taken as a hint,
which keeps the live outline calm.

It replaced the first detector in v6. On 160 made-up phone photos with known corners (tools and
figures in `_preview/review/detbench`, not published) the first detector found the page in
about one picture out of three, this one in nine out of ten, with no outline shown on pictures
without a page. The figures come from made-up pictures; real photos are the test that counts.

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
    re-encrypted in the background, and then the previous key is dropped. A record write that
    began under the previous key is stored once more under the new one, and the previous key goes
    only after a pass that began under the current key, with nothing in flight, and after the
    list, the sign-in entry and the cloud key were read back under the new key. A second renewal
    during the pass starts the pass over. The pass remembers how far it got, so a restart
    continues behind it; a record that no key opens is lost already, is reported once and does
    not keep the old keys alive.
  - The key record is never changed in memory before it is stored. A refused write (storage full)
    leaves memory and storage alike: no lock exists in memory only, and no unlock can run on such
    a lock. Turning a gate lock off is one record write; the key file is not touched. Key-record
    writes ask for strict durability, so the file is removed only after the record that no longer
    needs it is on disk. One passkey handle per install: a cancelled or repeated set-up replaces
    the earlier passkey instead of adding one.
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
- **The page refuses to run inside another site's frame.** Storage is per origin and modern
  browsers partition it for frames, but the page hides itself and stops when framed, so nothing
  can be overlaid on it.
- **Shared web address.** All of the owner's GitHub Pages apps live on one origin, which
  browsers treat as one site: a script running in a sibling app could reach Snapdoc's storage.
  With a key-bound lock such a script cannot read the key silently; it could still ask the phone
  for the same fingerprint confirmation and, if the owner confirms, unwrap the key, because the
  passkey is bound to the shared hostname and its record is readable on the shared origin. Full
  separation needs an address of its own; that move also re-binds the passkey, so the lock is set
  up again on the new address.

## The lock screen

- Away longer than the chosen time, in front or in the background: locked again. When nothing is
  in flight the page restarts, which also clears the key and every decrypted image from memory.
- Only work that ends by itself counts as in flight (pages processing, a rotation, a sync, a PDF
  build, a queued list write, the share sheet or the photo picker in front of the app). When the
  lock is due, the lock screen covers the app first, whatever follows; a restart whose final list
  write fails keeps the cover up and tries again, and a PIN typed meanwhile is never thrown away. A screen that is merely open
  does not keep the key in memory: with the corners open or the camera running, the restart
  follows once the work is done, remembers the open document and the corners being adjusted
  (page, corner positions), and reopens them after the unlock. The restart waits while a PIN is
  typed or checked, stores the list first and stays on the lock screen, trying again, while that
  write fails. Under the lock screen Back closes nothing and no message is drawn; a plain message
  raised meanwhile is shown after the unlock. "Reset this app" erases at the very start of the
  fresh page, where nothing else can write beside it.
- A password needs 8 characters with at least 4 letters; anything with fewer letters is a PIN and
  needs 12 digits, whatever separators it carries, judged on the text the key is derived from.
- While work is in flight (pages processing, a sync, the share sheet) the lock screen covers the
  app at once instead: open popups and the menu close without acting, everything underneath is
  switched off, and the restart follows as soon as the work is done. Nothing is cut off.

## One active window

- A window asked to step aside finishes every shot, crop, rotation and PDF build first, however
  long that takes, and says "busy" once a second meanwhile; the new window waits as long as it
  hears that. The window holding the instance also writes an "alive" stamp once a second (and
  before a long job on its own thread), so a window that is busy but cannot answer is given time
  too; a window is taken over only when it stays silent and its stamp is half a minute old. The
  same hand-shake runs on browsers without Web Locks. A browser that cannot ask at all (no
  BroadcastChannel) never takes over on its own: the user decides with "Use Snapdoc here". A
  window with a lock that has stepped aside restarts without the key: nothing decrypted stays in
  its memory until "Use Snapdoc here". A sign-in link that landed in such a window comes along.
- The database is opened with a version number (2 since v12). A window still running an older
  release holds the old version open and cannot write beside the new one; the new window says so
  and starts once that window is closed. Later versions step the old window aside by themselves,
  once its shots are stored.
- A sign-in link opened in the running app is taken off the address at once and handled by a
  fresh start as soon as nothing is in flight; a link nobody asked for from this browser does not
  take the app away from another window, and an error link shows only one of a few fixed
  sentences, never the sender's text.

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
- One entry per document (`sd_documents`) and one encrypted file per version of its pages
  (`sd/<user>/<document id>.<tag>`). A file is never overwritten: a new version gets a new file,
  the entry names the version, and the file of the version before is removed once the entry has
  moved on. Files written before format 4 (`sd/<user>/<document id>`) are still read.
- **Pages** have a revision and a random tag. A device uploads when its pages are newer than what
  the cloud last agreed on, and downloads when the cloud has moved on. An upload alone proves
  nothing: a version counts as synced only once the cloud has accepted the entry that names it.
- **Entries are written conditionally.** Each device remembers the server stamp of the entry it
  last saw and writes only if the cloud still holds that one (the first entry of a document is
  inserted, never upserted). If another device was first, its entry is taken in and the write is
  tried once more. A late write from a stale pass can therefore never replace a newer entry; a
  device that still holds the newer state sends it again.
- **Both changed the pages** since they last agreed: nothing is overwritten. The device keeps its
  own version as a separate document, "… (copy from this device)", and takes the cloud version.
- **Pages cannot be added or changed while a newer version is still downloading.** A page that is
  being scanned at that moment waits and is added to the downloaded version, and counts as a change
  of the document from that moment. The stamp "these pages are the newest version" is refused at
  the last moment too: a rotation or crop that was under way when the newer version was announced
  is not applied, and the user is told. A turned or cropped page is stored under a new id; the
  list is switched to it and stored before the old record goes, so a save that is lost leaves the
  old page whole. Undo of a removed page says where the page went when the document changed
  meanwhile (kept for the newer version, or back as the last page).
- **Deleting a document** stores the list without its pages first and removes the records
  afterwards; an interruption leaves only records nothing refers to, and a delete that was
  interrupted is finished at the next start. The question "delete this document?" describes the
  document as it is; an answer to a question about one page deletes nothing once more pages are
  there. A document deleted on another device while the camera or the view is on it: the view and
  the camera close with the reason; pages that only this device has (being scanned, waiting to
  join a download) live on in a new document and the camera continues there.
- **A PDF is built from a snapshot** of the page list, name and page size; a page removed during
  the build cannot make the file skip another one. If the document changed during the build, the
  PDF is built again, and two callers for the same version share one build.
- **The crop that is stored starts from the outline the camera showed**: the full-size photo is
  searched near that outline, and when nothing is found the outline itself is used, never the
  whole photo.
- **Name and deletion** follow the later change. A document deleted on one device and renamed
  later on another comes back whole: the renaming device uploads the file again.
- The server stamps each write (`synced_at`, a sequence since v13: it never steps back, unlike a
  clock); devices pull everything stamped after their last visit, with a small overlap, in pages
  keyed by stamp and id (never by offset, so a row rewritten meanwhile shifts nothing). Entries
  are idempotent. The bookmark of the last visit and the account the list last synced with are
  stored inside the encrypted document list, in the same write, so neither can be ahead of the
  list or be read from outside it. Two entries with the same change stamp are decided alike on
  every device: a delete beats a live change, then the larger revision, then the larger name. An
  entry this device cannot read (written before entries were sealed, or damaged) is replaced by
  this device's next write of that document.
- Deletes are sealed markers and are written once. The files are removed from the bucket only
  after the cloud has confirmed that the marker is still the current entry; that removal is
  repeated until it succeeds. A document deleted on one device and brought back by a later change
  on another is downloaded again; a device whose pages are the only ones left sends them again,
  under a fresh file name, so a purge still under way on the other device cannot remove them.
  Every object this device no longer needs in the bucket (a replaced version, the version that
  lost a conflict, a file whose entry was never accepted) is removed, or remembered on the
  document and removed on a later pass; a delete marker is kept until nothing is owed any more.
- Signing in with another account, or signing out, resolves documents that were still waiting for
  a version from the old cloud: the pages this device holds become a version of their own.
- One document that cannot be uploaded (too large, a page missing) or whose entry cannot be
  saved is named in the status and does not hold up the others. A refused upload is tried again
  after a growing pause (1 min, 4 min, 16 min, ... up to an hour), not on every pass; "Sync now"
  tries at once.
- A pass stops as soon as the window is no longer the active one, the lock closes, the account
  changes or the window is handed over; the request under way is cut off then (the requests carry
  the pass's abort signal). A device whose clock is behind refreshes its session on a 401 and
  repeats the request once.
- The sign-in link is requested with a PKCE challenge and carries a one-time code that only this
  browser (holding the verifier) can exchange; a copy of the address in a browser history is
  worthless. Links in the older form (tokens in the fragment) are still accepted once.
- A PDF is never built or uploaded with a page left out.
- Every device downloads every PDF, so all documents are available offline.
- Sync status is always visible on the home screen; failures show their reason in the menu.
- A sign-in link is accepted only if this browser asked for one within the last hour, nobody is
  signed in, and the cloud confirms the token.

## Offline and updates

- A new release installs and then **waits**. The page running the old release keeps its complete
  set of files until it asks for the switch itself, at a quiet moment right before it restarts
  (the home screen with nothing in flight, or the restart of the lock), so it never loads a file
  of the new release. A release that took over anyway (another window asked for it) makes this
  page restart at the next quiet moment. The restart of an update waits for the list write and
  never leaves on a refused one. A device still running version 12 (whose worker switched at
  once) gets version 13 the first time the app is opened after it was closed.

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

- **Honest limit of the Drive connection.** Google's reply carries the access token in the
  address (the implicit grant; a static web app has no secret for the code flow). The app takes it
  off the address at once, but the browser may already have recorded the visit in its history.
  The token lives one hour and allows only the app's own Drive files. A reply nobody asked for is
  ignored without a word; a reply with an error shows one of a few fixed sentences. The quiet
  reconnect runs at most twice in ten minutes and only while nothing on the home screen would be
  lost. One document Google refuses does not hold up the others (back-off per document, a file
  removed in Drive is made again). PDFs over 5 MB go up in the resumable form. Two devices that
  create the same file or folder at the same moment both keep the older one.

## Set-up of the Google Drive copies (once, by the owner)

1. In the Google Cloud Console create a project, enable the "Google Drive API".
2. OAuth consent screen: external, app name Snapdoc, scope `.../auth/drive.file`. While the app
   is in "Testing", every user has to be listed as a test user; "Publish" lifts that (no review
   is needed for this scope).
3. Credentials: OAuth client ID, type "Web application", authorised JavaScript origin
   `https://smisery-prrivate.github.io`, authorised redirect URI
   `https://smisery-prrivate.github.io/snapdoc/`.
4. Put the client id into `googleClientId` in `config.js`.

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
makes every device send what it holds once more in the new form; what a device last agreed on
with the cloud is kept through that step, so the other devices recognise the re-sent versions
and do not fork copies.

## History

- v1, v2 (2026-10-09): first release; sync switched on with its own cloud project.
- v3: fixes for all 57 findings of an independent review (see `REVIEW.md`), cropped-page preview
  after each shot, OK button for the name, smooth live outline, one active window, releases that
  arrive as one unit.
- v4: scans look like scans (the look removes only the lighting, see above); the cropped page
  appears at once and large after a shot.
- v5: the picture is no longer changed at all (looks switched off); "Adjust crop" on the pop-up
  after a shot and on every page; fixes for the findings of the review of v4 (see `REVIEW.md`).
- v6: new page detector (see "Finding the page"). Not independently reviewed yet.
- v7: search field and pick mode on the home list (share or save several PDFs at once).
- v8: Google Drive copies (plain PDFs in the user's own Drive, uploaded from the device).
- v9: long press picks a document, Delete for several documents at once.
- v10: sync format 4 (one file per version, conditional entry writes, bookmark inside the list,
  back-off for refused uploads, a pass that stops with the window); fixes for the sync findings
  of review round 2 (see `REVIEW.md`).
- v11: the key record is copy-on-write, the key renewal cannot strand a record (see
  "Encryption"); fixes for the vault and storage findings of review round 2.
- v12: the document view, the camera, the lock screen and the start-up: fixes for the remaining
  findings of review round 2 (see `REVIEW.md`); database version 2; the stored crop starts from
  the outline the camera showed; a message never catches a tap meant for what lies under it.
- v13: fixes for all 87 findings of review round 3 (see `REVIEW.md`): sync (fresh file names on
  revival, keyset pull, owed objects, equal stamps, account in the list, abort signal, PKCE sign-in,
  the server stamp as a sequence: run `supabase-migration-v13.sql` once), vault and lock, the
  document view, the camera, the hand-over, the service worker that waits, Drive, the imaging
  arithmetic. The cloud account id, the last-sync time and the page records' write time are no
  longer written readable.

## Tested, and not yet

Tested in desktop Chrome with a simulated phone, a fake camera, a simulated fingerprint sensor
and a stand-in for the cloud. The scripts are kept in `_preview/tests` (not published): run
`gen_assets.py` once for the test photos and fake-camera file, install `puppeteer-core`, start
the local server on port 8792, then the `t*.js` files and `test-detect.js` (`t10-look.js` uses
the photographed-looking pages in `look/`). Not yet tested on an
iPhone. The live outline and the automatic capture can only be judged on a real phone.

## Not built (Genius Scan has it)

Text recognition (OCR) and search inside scans, PDF password protection of exported files,
tags and folders, importing existing PDFs, export to Drive/Dropbox, a search field in the list.
