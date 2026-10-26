@echo off
rem Registers the hourly task "Snapdoc backup to Proton" for the current user (double-click once).
rem It copies the PDFs from the Google Drive folder "Snapdoc" into the Proton Drive sync folder.
schtasks /Create /F /TN "Snapdoc backup to Proton" /SC HOURLY /MO 1 /RL LIMITED /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%~dp0snapdoc-backup-to-proton.ps1\""
schtasks /Create /F /TN "Snapdoc backup to Proton (logon)" /SC ONLOGON /RL LIMITED /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%~dp0snapdoc-backup-to-proton.ps1\""
schtasks /Run /TN "Snapdoc backup to Proton"
echo.
echo Done. The task runs now, at every logon and every hour. Log: %LOCALAPPDATA%\Snapdoc\backup-to-proton.log
pause
