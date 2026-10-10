# Independent review, round 1 (2026-10-09)

Eight independent reviewers read the code of version 2, one per area: encryption, sync, local storage, web security and privacy, image and PDF processing, camera and browser differences, phone usability, offline behaviour and updates. Each finding was then checked by two more reviewers who tried to disprove it by tracing the code.

Result: 57 findings reported, 57 confirmed as true in the code, none rejected. By the owner's rule a finding is dropped only when it is false, never because it is unlikely, so all 57 were fixed in version 3. Many findings describe the same defect from different angles; they are grouped below.

| Severity as reported | Count |
| --- | --- |
| high | 6 |
| medium | 9 |
| low | 42 |

## Encryption and lock

| Found | Changed in version 3 | Findings |
| --- | --- | --- |
| After a lock was turned on, an unlocked copy of the key could still be recovered from the database files. | The unlocked copy now lives in a private file that is really deleted when a lock is turned on. Where an older copy may linger (installs before v3, browsers without private files) a new key is made, older records are re-encrypted in the background and the old key is dropped. | 1 |
| A cancelled second fingerprint prompt quietly produced the weaker screen-only lock. | A cancelled or failed confirmation now aborts the set-up. The screen-only lock is named as such in the menu and in the confirmation. | 2 |
| A six-digit PIN can be tried out by a computer against a copy of the storage. | Digit-only PINs need 12 digits; otherwise a password of 8 or more characters. The menu explains why. | 3 |
| The lock screen shown while work was in flight was only a cover: popups stayed usable above it, the app could be operated with the keyboard, and the key stayed in memory. | Locking closes popups and the menu without acting, switches everything underneath off, refuses new popups, and restarts the app as soon as the work in flight is done. | 17, 23, 43, 54 |
| "Lock now" restarted the app while pages were still being processed and lost them. | A lock never cuts work off: the lock screen appears at once, the restart waits for the queue and the saved list. | 16 |
| After importing photos under a PIN lock the cursor jumped into the hidden name field. | The name field takes the cursor only after unlocking. | 45 |
| History entries from before a restart swallowed one press of Back. | Every history entry carries the id of the current start; older ones are skipped. | 46, 56 |
| All of the owner's GitHub Pages apps share one web origin, so a script in a sibling app could read the scans. | Documented in the app's concept and to the owner; with a key-bound lock the key is out of reach. An address of its own is the full answer and is the owner's decision. The injection point found in the sibling app was reported for a separate fix. | 20 |

## Two windows at once

| Found | Changed in version 3 | Findings |
| --- | --- | --- |
| A second open tab could download a document and delete the page records the working tab still used; a tab could freeze a half-finished capture and later write it over the finished document. | Only one tab or window is active at a time. Every write checks a shared owner mark, so a window that was replaced, or wakes up late from the background, cannot write. Unfinished captures of another window are never adopted. | 4, 14 |

## Sync

| Found | Changed in version 3 | Findings |
| --- | --- | --- |
| Adding or editing pages while a newer version was still downloading replaced the cloud document on every device. | Page changes are refused until the newest version is on the device. A page being scanned at that moment waits and joins the downloaded version. | 5, 12, 28, 34, 42 |
| Two devices changing the same document could overwrite each other without notice. | When both sides changed the pages, the device keeps its own version as a separate copy and takes the cloud version. Nothing is overwritten. Each page change carries a random tag so that equal revision numbers are told apart. | 5, 6 |
| The cloud entry could keep an old revision number, so other devices never fetched the newest pages. | The app tracks the revision the cloud entry carries and sends the entry again whenever the uploaded file is newer. | 6 |
| One document that could not be uploaded stopped the whole sync in both directions. | Each upload is handled on its own; a failing document is named in the status, progress is saved after every upload, and files over 50 MB get a clear message. | 7, 29 |
| Delete on one device plus a later rename on another left a document without file or pages. | The device whose later change keeps the document uploads the file again; a document that comes back is downloaded again. | 8 |
| Removing the last page never reached the cloud. | Deleting the only page asks to delete the document, which uses the normal delete path. | 9, 44 |
| A failed removal of the cloud file was recorded as done. | It counts as done only when the cloud confirms; otherwise it is repeated on the next round. | 10, 24 |
| Delete tapped while a sync was pulling could lose the delete marker. | The change is recorded before the first wait, and a pulled entry never swallows a change that is not saved yet. | 11 |
| A delete marker from the cloud was trusted without proof; entries were not bound to their revision. | Every entry, delete markers included, is sealed with the cloud key together with its revision, change time and delete flag. The file carries its revision inside the encryption, so an older file is refused for a newer entry. | 21 |
| Any link with sign-in tokens replaced the current sign-in. | A link is accepted only if this browser asked for one within the last hour, nobody is signed in, and the cloud confirms the token. | 22 |
| Sign-in could fail silently. | A failed request and an expired link now say so. | 25 |
| A downloaded PDF was cached as if built with this device's page size and the current name. | The downloaded file is no longer reused as the local PDF; it is rebuilt from the pages on first use. | 31 |

## Storage

| Found | Changed in version 3 | Findings |
| --- | --- | --- |
| A batch scan was lost when its first page failed to process. | A document dropped after a failed page is taken back as soon as another page arrives; an empty document never stays in the list. | 13, 36 |
| Every start read and decrypted every stored PDF; a page-size change rebuilt all PDFs at once. | PDFs are prepared ahead only when an upload can follow, one at a time, and the cached file is decrypted only when its signature matches. | 15 |
| A failed write of a processed page left a permanent "Processing" tile. | Any failure before the page is complete removes the placeholder and the partial record. | 18, 39 |
| Deleted page data stayed in storage for good when the app closed within six seconds. | Records that nothing refers to are removed by a sweep once they are older than an hour. | 19, 27 |
| The browser's answer to the request for lasting storage was thrown away. | If the browser does not promise to keep the data, the menu says so while scans exist only on this device. | 57 |

## Camera and pages

| Found | Changed in version 3 | Findings |
| --- | --- | --- |
| A shot was thrown away when Done, X or Back was pressed while the photo was being taken. | A shot that already flashed is always kept: it goes into the document the camera was working on, or into a new one. | 35 |
| Camera error text and a disabled shutter stayed on screen after the camera recovered; a second start leaked a camera stream. | A successful start clears the error state; overlapping starts and stops are told apart by a counter. | 37, 38 |
| After unlocking on the camera screen, camera and screen wake lock were not restored. | Unlocking resumes the camera. | 40 |
| Automatic capture could take the same page twice when the camera moved. | It arms again only when the outline has vanished or what lies inside it has changed. | 41 |
| The phone's back button in batch mode dropped to the list instead of the new document. | It now ends on the new document with the cursor in its name. | 49 |
| Tapping Rotate twice turned the page once; two taps on Crop stacked two editors; a second tap on Share saved an unasked copy. | Rotations run one after the other; the editor and the PDF build are guarded against a second tap; a failed share never falls through to a download. | 30, 47, 48 |
| Imported images with transparency came out black; Share failed when the PDF cache could not be written. | Transparent areas become white; the cache write is best effort. | 32, 33 |

## Offline and updates

| Found | Changed in version 3 | Findings |
| --- | --- | --- |
| On a weak connection the fully cached app waited for the network before starting; error pages could be cached over the app; a release could arrive as a mix of two versions; sign-in tokens could land in the offline cache. | The service worker stores one complete release fetched past the HTTP cache and serves only from it. Nothing is written to the cache at run time. A new release arrives as a new worker and the page restarts into it at a quiet moment; a release with a missing file is never activated. | 26, 50, 51, 53, 55 |
| Start-up could die without a message. | Any unexpected error during start-up is shown. | 52 |

## All findings as reported

| No. | Area | Severity | Place | Finding |
| --- | --- | --- | --- | --- |
| 1 | crypto | medium | `vault.js:128` | PIN/fingerprint lock does not remove the device key slot from storage; a copy of the browser profile still yields the key |
| 2 | crypto | low | `vault.js:124` | Fingerprint set-up silently downgrades to the weak "gate" (storage-readable) lock when the normal second PRF prompt is cancelled or fails |
| 3 | crypto | low | `vault.js:139` | 6-digit numeric PIN with 600k PBKDF2 is offline-brute-forceable from a storage copy within hours |
| 4 | sync | high | `app-sync.js:190` | A second open tab "downloads" a document and deletes the page records the working tab still uses |
| 5 | sync | high | `app-core.js:133` | Pages added or edited before the newest revision has been downloaded replace the cloud document |
| 6 | sync | medium | `app-sync.js:149` | The cloud row keeps an old revision number, so other devices never fetch the newest pages |
| 7 | sync | medium | `app-sync.js:146` | One document that cannot be uploaded stops the entire sync on that device |
| 8 | sync | low | `app-sync.js:119` | Delete on one device plus a later rename on another leaves a document without its file or without its pages |
| 9 | sync | low | `app-sync.js:141` | Removing the last page of a synced document never reaches the cloud |
| 10 | sync | low | `app-sync.js:160` | A failed removal of the cloud file is recorded as done |
| 11 | sync | low | `app-docs.js:133` | Delete tapped while a sync is pulling can lose the tombstone and still remove the cloud file |
| 12 | storage | high | `app-core.js:133` | Adding or editing pages on a document that is still downloading wipes its cloud pages on every device |
| 13 | storage | medium | `app-cam.js:131` | Batch scan is lost when its first page fails to process: later pages go into a document that is no longer in the list |
| 14 | storage | medium | `app-core.js:101` | Two open tabs (or installed app plus browser tab): the second one freezes a half-finished capture and later writes it over the finished document |
| 15 | storage | low | `app-boot.js:35` | Every start and every unlock reads and decrypts every stored PDF at once (sync off); after a page-size change all PDFs are rebuilt at the same time |
| 16 | storage | low | `app-lock.js:103` | "Lock now" reloads the page while scanned pages are still being processed and silently discards them |
| 17 | storage | low | `app-lock.js:50` | Lock overlay without restart leaves the app operable behind it: PDF export and "Turn the lock off" work without unlocking |
| 18 | storage | low | `app-cam.js:136` | A failed write of a processed page leaves a permanent "Processing…" tile that cannot be removed |
| 19 | storage | low | `app-docs.js:123` | Deleted page data stays in IndexedDB for good when the app is closed or locked within 6 seconds; nothing ever collects unreferenced records |
| 20 | websec | medium | `vault.js:51` | Snapdoc shares one web origin with Stillzeit and Braindump, so script running in either of them can read every scan |
| 21 | websec | low | `app-sync.js:108` | A delete marker from the cloud is trusted without any proof and erases the local document |
| 22 | websec | low | `app-sync.js:27` | Any link with #access_token=... replaces the current sign-in and throws away the cloud key |
| 23 | websec | low | `app-lock.js:50` | The lock screen shown while work is in flight is only a cover: popups stay on top of it and the key stays in memory |
| 24 | websec | low | `app-sync.js:160` | The cloud file of a deleted document is marked as removed even when the removal failed |
| 25 | websec | low | `app-sync.js:241` | Sign-in fails silently: the send button hangs on 'Sending…' and an expired link shows nothing |
| 26 | websec | low | `sw.js:24` | The service worker overwrites good cached files with error pages |
| 27 | websec | low | `app-docs.js:123` | A deleted page stays on the device for good when the app closes within six seconds |
| 28 | imaging | high | `app-sync.js:189` | Scanning into a document while its cloud copy is pending loses the scan or wipes the document on every device |
| 29 | imaging | medium | `app-sync.js:146` | One document that cannot be uploaded (PDF over 50 MB) stops the whole sync in both directions |
| 30 | imaging | low | `app-docs.js:99` | Tapping Rotate twice turns the page only once |
| 31 | imaging | low | `app-sync.js:192` | Downloaded PDF is cached as if it had been built with this device's page size and the current name |
| 32 | imaging | low | `imaging.js:27` | Imported images with transparency come out black |
| 33 | imaging | low | `app-docs.js:150` | Share and Save PDF fail when the PDF cache cannot be written |
| 34 | camera | high | `app-docs.js:126` | "+ Pages" on a document that is still downloading replaces the cloud copy with only the new page |
| 35 | camera | medium | `app-cam.js:102` | A shot is thrown away when Done, X or back is pressed while the photo is still being taken |
| 36 | camera | low | `app-cam.js:122` | After a failed first page the camera keeps scanning into a document that was already removed from the list |
| 37 | camera | low | `app-cam.js:43` | Camera error text and disabled shutter stay on screen after the camera starts on return to the app |
| 38 | camera | low | `app-cam.js:34` | startStream does not re-check after its awaits: a second call leaks a live camera stream, and leaving early leaves wake lock and timer running |
| 39 | camera | low | `app-cam.js:136` | A page stays on "Processing…" until restart when storing it fails |
| 40 | camera | low | `app-lock.js:58` | After the overlay lock on the camera screen is unlocked, camera and wake lock are not restored |
| 41 | camera | low | `app-cam.js:68` | Automatic capture takes the same page twice: the hold depends only on where the outline is |
| 42 | ux | high | `app-docs.js:126` | '+ Pages' is enabled on a document that has not been downloaded yet; scanning then replaces the whole cloud document with just the new page |
| 43 | ux | low | `app-lock.js:50` | A popup that was open stays usable on top of the lock screen (soft re-lock), so a document can be saved, shared or deleted without unlocking |
| 44 | ux | low | `app-docs.js:119` | Deleting the last page leaves an empty document that never syncs; the cloud and other devices keep the deleted page |
| 45 | ux | low | `app-docs.js:38` | After importing photos under a PIN lock, focus jumps into the hidden name field and the PIN is typed into the document name |
| 46 | ux | low | `app-lock.js:52` | Every automatic re-lock leaves a dead entry in the back history; Back then does nothing, once per re-lock |
| 47 | ux | low | `app-docs.js:204` | Page editor is not guarded against a second tap: two taps on Crop stack two editors and leave a dead editor screen; Back during 'Done' also closes the document |
| 48 | ux | low | `app-docs.js:184` | A second tap on 'Share PDF' while the first is still running saves an unencrypted copy into Downloads |
| 49 | ux | low | `app-core.js:184` | Android back button in batch mode drops to the home list instead of showing the new document and its name field |
| 50 | offline | medium | `sw.js:23` | No time limit on the network attempt: on a weak connection the fully cached app waits for the network before it starts |
| 51 | offline | low | `sw.js:24` | Sign-in link tokens are written unencrypted into the offline cache |
| 52 | offline | low | `app-boot.js:7` | The change waiting in the working tree makes start-up die without a message when index.html is older than app-boot.js |
| 53 | offline | low | `sw.js:23` | A release does not arrive as one unit: a page and the offline cache can hold files from two versions |
| 54 | offline | low | `app-lock.js:50` | The lock screen can be operated around while the app counts as busy; a popup left open sits on top of it |
| 55 | offline | low | `sw.js:24` | Server error pages are cached over the app and served in its place |
| 56 | offline | low | `app-boot.js:13` | History entries from before a reload are trusted: Back gets swallowed and then does nothing once |
| 57 | offline | low | `app-boot.js:29` | The answer to the request for lasting storage is thrown away, so the user never learns that the browser may delete the scans |

Each fix has a test that first reproduces the defect: `t5-fixes.js`, `t6-syncfix.js`, `t7-update.js` in `_preview/tests`.

# Review of version 4 (2026-10-09)

Four independent reviewers read the change from version 3 to version 4, each through one lens: the
order of events around a shot, readable pictures in memory, the arithmetic of the image code, and
regressions. Each finding was then traced in the code by a second reviewer who had to answer only
whether the defect exists, not how likely it is. The findings below were confirmed and are fixed
in version 5. Several of them were older than version 4 and had not been seen in round 1.

| Found | Changed in version 5 |
| --- | --- |
| Done, X or Back while the photo was still being taken stored a blank 2x2 pixel page in place of the shot (the still camera refuses the photo once the camera is closed, and the fallback then read an empty video). | The picture of the shutter moment is kept before anything is waited for and is used whenever the still camera fails, is too slow (6 s) or was closed. A camera without a picture takes no shot. |
| A camera opened again on the same document was treated as the same session: pages of an import or of the opening before popped up in it, changed its Done picture, and a failing old page lowered its page count until the Done button disappeared. | Every opening of the camera has a number. Pop-up and Done picture belong to the newest shot of the current opening only; a failure lowers the count only for a page that opening counted. |
| A photo that arrived after the camera was closed and opened again was taken into the new session (in single mode the camera just opened closed by itself). | The photo is compared with the opening it was shot in and goes to the document it was shot for. |
| A shot whose photo was still being taken did not count as work in flight: a re-lock or an update restart reloaded the page and the shot was lost. | Pending shots count as work in flight for the lock and for updates. |
| A second window taking over while pages were still being worked on threw those pages away after 3 seconds. | The window that steps back first finishes every shot and says so once a second; the new window waits for it (up to a minute) and only takes over a window that stays silent. |
| An older page that finished late put its picture back on the Done button and could replace the pop-up of a newer shot. | Only the newest shot of the opening touches either. |
| After Auto was switched off, a shot by hand was cut along the outline from the time Auto was on. | The outline is forgotten when Auto is switched off and when the camera restarts; a shot by hand uses the live outline. |
| One failed outline request terminated the shared worker and left the quick picture that was in it unanswered for good. | A missing video frame no longer ends the worker; when the worker itself fails, everything that waits for it is answered. |
| A page rotated or cropped within 2.5 s of being finished was first redrawn with its old quick picture. | The quick picture is given back whenever the page is rendered again. |
| The pop-up and the stand-in could show another crop than the stored page, because the quick picture searched the outline with other settings and another fallback, and batch mode then never showed the stored crop. | The quick picture searches exactly like the full processing. If the finished page still has another shape (the photo can differ from the live picture), the stored page is shown again. |
| The Look step previewed the new look for pages rendered by an older version, and Done stored nothing. | Not applicable while the looks are switched off. To be handled when they return (a look version in the page record). |

Tests: `t11-crop.js` holds each of these in place; the reviewers' own scripts were run against the fixes first.

# Review round 2 (2026-10-09, versions 5 to 9)

Independent reviewers read the whole app again (one lens each: encryption and lock, the two
windows, sync, storage, camera and pages, offline and updates, the image arithmetic), and every
finding was traced in the code by a second reviewer who answered only whether the defect exists.
127 findings were confirmed (14 high, 42 medium, 71 low); 54 of them concern `app-sync.js`. The
full list with the verdicts is in `_preview/review/r2-summary.json`.

Version 10 fixes the sync group as one change of the sync format (format 4). The other groups
are open and are being fixed next, each with a test.

| Found (sync) | Changed in version 10 |
| --- | --- |
| The file of a document was overwritten in place (upsert). A device uploading its version replaced the file another device had just referenced in its entry; a download could then read a file that did not match the entry, and a lost race left a version with no file at all. | One file per version, named by document and version tag. Files are never overwritten; the file of the version before is removed only after the entry has moved on. Old file names are still read. |
| Entries were upserted unconditionally. A late write from a stale pass (a slow device, a pass that was cut off) replaced a newer entry, and the device holding the newer state never noticed. | Entries are written conditionally against the server stamp the device last saw; the first entry is inserted, never upserted. A refused write takes in the cloud's entry and is tried once more. An older entry that lands late is pulled as "older than ours" and the newer state is sent again. |
| The pull bookmark lived in `localStorage`, written before the list was stored. A list that failed to store, or a window closed in between, left the bookmark ahead of the list: those entries were never pulled again. | The bookmark is part of the encrypted list record and moves only in the same write; if the list cannot be stored the bookmark stays. `persist()` now reports whether the write landed. |
| `pushed_rev` was set when the file upload succeeded, before the entry was accepted. A device that uploaded but whose entry write failed believed the version was synced. | Two separate marks: the file is up (`up_rev/up_tag`) and the entry is accepted (`pushed_rev/pushed_tag`). Only the second means synced. |
| A document revived by a later change on another device kept its old marks: its pages were not downloaded, or the wrong file was deleted. A device that deleted a document while holding pages it had never sent lost those pages for good when the cloud brought the document back. | Revival adopts the cloud's version and downloads it. A later delete against a later rename: the renaming device's pages are the newest version and go up again. The cloud "going back" to an older version (a device that never saw ours) is handled either way. |
| The files of a deleted document were removed before the cloud confirmed the delete marker was still current; a device that had revived the document meanwhile lost its file. The marker itself was rewritten on every pass. | The purge first reads the entry back and removes files only if the marker is still the current one. A marker is written once; a pass with nothing to do writes nothing. |
| A refused upload (too large, a missing page, a cloud error) was tried again on every pass, every few seconds, for ever. | Refused uploads back off (1, 4, 16 ... minutes, at most an hour) per document and version; "Sync now" clears the back-off. |
| A sync pass kept running after the window had lost the lock, been handed over to another window or been locked; a request in flight could still write. | Every step checks the window is still the active owner; the running request is cut off when another window takes over. |
| The list of files that could not be removed was built after awaits and lost entries; a document edited during a download was overwritten. | The list is fixed before any await; a document in the editor is skipped and downloaded on the next pass. |
| The format step reset what the device had agreed on with the cloud, so the other devices saw "both changed" and forked copies of every document. | The step keeps `pushed_rev/pushed_tag` and only re-sends the files; versions from before tags get the same tag everywhere. |
| An entry that could not be read (sealed with another key, damaged) stopped the whole pass; the other documents were never written. | One entry that fails is counted and named; the rest of the pass continues. |
| A version sent by the losing device of a "both changed" conflict stayed in the bucket for ever. | The loser's file is removed when its entry is refused; the pages live on in the copy. |

Tests: `t14-sync4.js` holds each of these in place; `t2-sync.js` and `t6-syncfix.js` were run against the new format. The cloud mock refuses duplicate files without `x-upsert`, answers 409 on a duplicate insert and filters conditional updates by `synced_at`, like the real service.

Version 11 fixes the vault and storage group.

| Found (vault, key renewal, storage) | Changed in version 11 |
| --- | --- |
| The key record was changed in memory before it was stored (rotate, lock on, lock off, the gate branch, the step after an unlock, dropping old keys). A refused write (storage full) left a lock in memory that storage did not hold; a later unlock in the same session then removed the only stored way to the key. | Every change builds a copy of the record, stores it, and only then switches memory and the key in use. A refused write leaves memory and storage alike. The renewal after an unlock is not part of unlocking: if its write is refused, the stored lock still opens the key and it is tried again next time. |
| Turning a gate lock off wrote a new key file first and the record naming its wrapping key second. A kill, a full storage or a replaced window between the two left a file no stored key opens. | Under a gate lock the device slot stays as it is; lock off is one record write. Under a key lock the new slot is written first and the stored lock still opens the key until the record is stored. |
| Lock on removed the key file right after a database write that was not yet flushed (relaxed durability). | Writes to the key record and the list ask for strict durability. |
| A page stored while the key was renewed (seal before the wait, read-then-put without a compare) landed under the old key in a record the pass never visited; the old key was then dropped. A page edited while the pass was at its record wrote old-key fields back. | The key is chosen after the wait. Page writes replace only the fields they produced, inside one transaction on the record as stored then; the meta object is written only if the stored one is still the one read. A write that began under the previous key is sealed and stored again under the new one. |
| A second renewal during the pass: records handled before it sat under a key that was old again, and the pass dropped all old keys at its end. | The vault counts key generations; a drop names the generation the pass worked under and is refused while a renewal runs or after one happened. The pass then starts over. |
| The old keys were dropped although the list could not be stored under the new one (persist swallowed the error), and the sign-in entry was re-encrypted from memory, which a token refresh can empty at that moment. | The list, the stored sign-in entry and the cloud key are read back and must open with the current key before the drop; the stored entry itself is re-encrypted. |
| Every start and every unlock read and decrypted the whole library again while a renewal was unfinished; one damaged record made that permanent. | A progress mark per renewal; the next run continues behind it. A field no key opens is counted and reported once, the other fields of the record are still moved, and a full storage ends the pass at once. |
| Every cancelled fingerprint set-up left an unused passkey on the phone. | One passkey handle per install, stored before the first set-up: a retry replaces the earlier passkey. A browser that can is asked to remove the passkey of a cancelled set-up. |
| A refused IndexedDB request could surface as "Processing failed: null". | The request's own error is reported; an error text is never empty. |
| The key-bound lock was described as out of reach of a sibling script on the shared origin. | Wording corrected: it blocks a silent read, not a prompted replay. An address of its own is the full answer (open with the owner). |

Tests: `t15-keys.js` (a renewal racing twelve page writes, a second renewal during the pass, refused key-record writes, gate lock off without a file write, the reused passkey handle); `t3-lock.js` and `t8-upgrade.js` re-run.

Version 12 fixes the remaining groups: the document view, the camera, the lock screen, the start-up
and the one imaging finding (whose fix had shipped with the new detector in version 6: the live
search follows the outline of the frame before).

| Found (document view, camera, lock, start-up) | Changed in version 12 |
| --- | --- |
| Rotate and Crop checked "no newer version on its way" before their work and stamped the old pages as the newest version afterwards; a pull that landed in between made the other device lose its pages, with no copy and no message. | The stamp itself refuses while a newer version is on its way; Rotate and Crop re-check right before it and tell the user when the change was not applied. |
| Rotate and Crop overwrote the page record before the list was stored; a lost save left the stored document on the old revision with a new picture: Share and the cloud kept the old page. | The new picture is stored under a new id, the list is switched to it and stored, then the old record goes. |
| Delete stored the list with every page still listed and removed the records one by one; an interruption left the images on the device for 60 days (or a live document with a page missing), and the hourly sweep protected them. | The list is detached and stored first, the records go afterwards; a deleted document that still lists pages is finished at the next start; the sweep protects only pages of documents that are not deleted, and re-checks the live state right before a record goes. |
| "This is the only page. Delete the document?" could be answered after Undo had brought a page back or a download had added pages: everything was deleted. | A pending Undo is settled before the question; the answer re-checks the page count and revision and deletes nothing when they changed. |
| Undo of a removed page dropped the page without a word while a newer version was on its way, or spliced it into another device's version. | The page is kept for the newer version, or goes back as the last page when the version changed, and the user is told either way. |
| The PDF walked the live page list across awaits: a page removed during the build made it skip another one, and the result was cached and uploaded under the old signature. The same PDF was built twice at once, and a pre-build decrypted a finished PDF for nothing. | Built from a snapshot; not cached and built again when the document changed meanwhile; one build per version shared by its callers; the pre-build only checks the signature. |
| Done in the crop editor was refused "still downloading" for ever, because the download waited for the editor to close. | Done says what happened, closes the corners and starts the download; closing the corners always lets a waiting download through. |
| Shots into a document that another device deleted while the camera was open were discarded silently while the counter kept counting; a page scanned while a newer version was pending did not count as a change and was purged by an older delete. | A delete from another device closes the camera and the view with the reason; pages that only this device has live on in a new document and the camera continues there; a waiting page counts as a change. A document deleted during the page write leaves no record behind. |
| The crop that was stored was not the outline the camera showed: the photo was searched again from scratch and fell back to the whole photo. | The outline is handed over: the search starts from it and falls back to it. |
| After a failed capture Auto mode still treated the sheet as taken; the Done button kept the picture of the failed shot. | The hold is released and the sheet is taken again once it holds still; after two failures in a row it is left to the shutter button; the button shows the last page that is really there. |
| A failed first page closed only the popup on top and left a view of a document that was not in the list. | The view closes down to the document screen, whatever lies on top, once. |
| The photo picker held the restart with a clock value: after ten minutes the page restarted behind the picker and the chosen photos were lost. | The hold is a flag, cleared when the picker answers, or a few seconds after the app is back without an answer. |
| The soft lock never restarted with the corners open or a batch counted in the camera: the key and the decrypted images stayed in memory, the camera kept running behind the lock. A running rotation and a photo still being taken were not counted as work. The restart could fire while a PIN was being typed or checked, and went ahead although the final list write had failed. | Only self-ending work counts; the corners and the open document are remembered and restored after the unlock; a shot under way and every background page job count; the restart waits while a PIN is typed or checked, stores the list first and keeps trying on the lock screen while that fails; no new shot starts once the restart is decided. |
| Back under the lock screen closed the editor underneath; messages were drawn over the lock screen and showed document names. | Back closes nothing under the lock; nothing is drawn over it, a plain message waits for the unlock. |
| "Reset this app" on the soft lock screen while pages were still being stored left a list under the old key beside a new key record: the app could not start any more. | The erase happens at the start of the fresh page, before anything else can write; a start without a key record clears leftovers first. |
| A window that stepped aside kept the key and the decrypted scans in memory for as long as it stayed open. | With a lock set it restarts into a key-free state until "Use Snapdoc here". |
| A window asked to step aside gave up after 3 seconds and lost the pages still in its queue; the newcomer stole the lock after 4 silent seconds, even from a third window that had just taken over; browsers without Web Locks got no waiting at all. | No time limit on the shots; "busy" once a second and a screen that says so; a second question before taking over; the same hand-shake without Web Locks. |
| A page opened before an update kept running the old release beside the new one and overwrote its list. | The database carries a version number; the old window is told to close, later releases step it aside by themselves. |
| A sign-in link opened in the running app reloaded at once and cut off the pages being processed; any link with two token-shaped values took the app away from a window in use; the link's own error text was shown as the app's message. | Taken off the address and handled by a careful restart once nothing is in flight; a link nobody asked for takes nothing away; fixed sentences only. |
| The 12-digit rule tested ASCII digits on the raw text while the key is derived from the normalised text; one separator lifted the rule. | Judged on the normalised text: fewer than four letters means a PIN, which needs 12 digits whatever it carries. |
| The fingerprint set-up's double-tap guard was set after an await. | Set before the first wait. |
| A delete marker was forgotten after 60 days even when its removal, or the marker itself, never reached the cloud. | A marker goes only when nothing is owed to the cloud any more. |
| A refused IndexedDB request surfaced as "null"; a message caught taps meant for the buttons under it. | The request's own error is reported; a message never catches a tap. |

Tests: `t16-docs.js` and `t17-camlock.js` hold these in place; every earlier suite was re-run.
