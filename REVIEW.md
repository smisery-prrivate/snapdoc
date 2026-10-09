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
