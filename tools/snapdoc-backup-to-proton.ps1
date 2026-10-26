# Snapdoc: copies the PDFs that the phone put into Google Drive (folder "Snapdoc") into the folder
# that the Proton Drive app keeps in sync, so Proton holds a backup of every PDF. Runs as a scheduled
# task at logon and every hour; copies new and changed files, never deletes in Proton (a backup keeps
# what was there). Needs Google Drive for desktop signed in and the Proton Drive app running.
$ErrorActionPreference = 'SilentlyContinue'
$log = Join-Path $env:LOCALAPPDATA 'Snapdoc\backup-to-proton.log'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
function Say($m) { Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) }

# where Google Drive for desktop keeps "My Drive": a drive letter (stream mode) or a folder under the profile (mirror mode)
$src = $null
foreach ($d in Get-PSDrive -PSProvider FileSystem) { $p = Join-Path $d.Root 'My Drive\Snapdoc'; if (Test-Path $p) { $src = $p; break } }
if (-not $src) { foreach ($p in @("$env:USERPROFILE\Google Drive\Snapdoc", "$env:USERPROFILE\My Drive\Snapdoc")) { if (Test-Path $p) { $src = $p; break } } }
if (-not $src) { $gd = Get-ChildItem "$env:USERPROFILE" -Directory | Where-Object { $_.Name -like 'Google Drive*' } | Select-Object -First 1; if ($gd) { $p = Join-Path $gd.FullName 'My Drive\Snapdoc'; if (Test-Path $p) { $src = $p } } }
if (-not $src) { Say 'Google Drive folder "Snapdoc" not found (is Google Drive for desktop signed in, and has the phone uploaded a PDF yet?)'; exit 0 }

# the Proton Drive sync folder of the signed-in account
$proton = Get-ChildItem "$env:USERPROFILE\Proton Drive" -Directory | Where-Object { $_.Name -ne 'desktop.ini' } | Select-Object -First 1
if (-not $proton) { Say 'Proton Drive folder not found (is the Proton Drive app installed and signed in?)'; exit 0 }
$dst = Join-Path $proton.FullName 'My files\Snapdoc'
New-Item -ItemType Directory -Force $dst | Out-Null

# newer or new PDFs only; nothing is deleted in Proton
$out = robocopy $src $dst *.pdf /E /XO /R:2 /W:5 /NP /NJH /NJS /NDL /NC /NS 2>&1
$code = $LASTEXITCODE
$copied = ($out | Where-Object { $_ -match '\.pdf' }).Count
if ($code -ge 8) { Say "robocopy failed ($code): $src -> $dst" } elseif ($copied -gt 0) { Say "$copied file(s) copied: $src -> $dst" }
exit 0
