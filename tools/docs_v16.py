import io
P = 'C:/Users/gross/Claude_Projects/Scan_App/'
def patch(f, pairs):
    s = io.open(P + f, encoding='utf-8').read()
    for a, b in pairs:
        assert s.count(a) == 1, (f, s.count(a), a[:80])
        s = s.replace(a, b)
    io.open(P + f, 'w', encoding='utf-8', newline='\n').write(s)
patch('CONCEPT.md', [
 ("""## Set-up of the Google Drive copies (once, by the owner)""",
  """## PDF copies in a folder, and the backup to Proton Drive

- On a PC (Chrome or Edge) the menu offers **PDF copies in a folder**: the user picks a folder once,
  and every document is kept there as a plain PDF, written after a scan or a change, renamed after
  a rename, removed after a delete. Two documents with one name get separate files. The folder
  handle is kept in the database as the browser hands it out; after a restart the browser may ask
  for a tap before the folder may be written again, and the status line says so. Phones cannot do
  this (no folder access for web apps); the PC catches up whenever Snapdoc runs there.
- **Proton Drive** has no interface a web app could use (end-to-end encrypted, only Proton's own
  apps reach the files), so nothing can be written there from the phone. The autonomous way from
  the phone is Google Drive; Proton holds a **backup** of those PDFs: the scheduled Windows task
  "Snapdoc backup to Proton" (`tools/snapdoc-backup-to-proton.ps1`, hourly) copies the folder
  "Snapdoc" of Google Drive for desktop into the folder the Proton Drive app keeps in sync. It
  copies new and changed PDFs and never deletes in Proton. It needs Google Drive for desktop and
  the Proton Drive app signed in on that PC; while the PC is off, nothing is lost, the task catches
  up at the next logon.

## Set-up of the Google Drive copies (once, by the owner)"""),
 ("""- v15: the sync status line counts uploads and downloads with a percentage ("Downloading 3 of 12 ·
  25%"), so the first sync on a new device shows how far it is.""",
  """- v16: PDF copies in a folder of the PC (for a sync app such as Proton Drive), and the scheduled
  backup of the Google Drive PDFs into Proton Drive (see above).
- v15: the sync status line counts uploads and downloads with a percentage ("Downloading 3 of 12 ·
  25%"), so the first sync on a new device shows how far it is."""),
])
print('docs v16 ok')
