<#
  LAIN DESKTOP (DEV) IN THE START MENU: one shortcut, so the Windows key finds the Harness of this checkout.

    powershell -NoProfile -ExecutionPolicy Bypass -File tools\dev\make-shortcut.ps1           # make or refresh it
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\dev\make-shortcut.ps1 -Remove   # take it away

  It writes exactly one file, "%APPDATA%\Microsoft\Windows\Start Menu\Programs\LAIN Desktop (dev).lnk", pointing at
  tools\dev\lain-desktop.cmd in this checkout (nothing is copied). Re-running it rewrites the same file. It does not
  touch the installed LAIN's own shortcut (distribution/shortcut.js), PATH, the registry or LAIN's settings.
#>
param([switch]$Remove)
$ErrorActionPreference = 'Stop'

$Name = 'LAIN Desktop (dev)'
$Dir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$Lnk = Join-Path $Dir "$Name.lnk"
$Cmd = Join-Path $PSScriptRoot 'lain-desktop.cmd'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Ico = Join-Path $Root 'distribution\brand\lain.ico'

if ($Remove) {
  if (Test-Path -LiteralPath $Lnk) { Remove-Item -LiteralPath $Lnk -Force; Write-Output "Removed: $Lnk" }
  else { Write-Output "Nothing to remove: $Lnk does not exist" }
  exit 0
}

if (-not (Test-Path -LiteralPath $Cmd)) { Write-Error "The launcher is missing: $Cmd"; exit 1 }
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($Lnk)
$s.TargetPath = $Cmd
$s.Arguments = ''
$s.WorkingDirectory = $Root
$s.WindowStyle = 7            # minimized: the console that runs LAIN stays out of the way; the window is LAIN's
$s.Description = "LAIN Harness from the checkout at $Root"
if (Test-Path -LiteralPath $Ico) { $s.IconLocation = "$Ico,0" }
$s.Save()

# VERIFY: the file, where it points, and whether the Start menu lists it (what the Windows key searches).
$back = $shell.CreateShortcut($Lnk)
Write-Output "Shortcut: $Lnk"
Write-Output "  target: $($back.TargetPath)"
Write-Output "  icon:   $(if ($back.IconLocation -and $back.IconLocation -ne ',0') { $back.IconLocation } else { '(default: no lain.ico found)' })"
$listed = $null
for ($i = 0; $i -lt 10 -and -not $listed; $i++) {
  try { $listed = Get-StartApps | Where-Object { $_.Name -eq $Name } } catch { $listed = $null; break }
  if (-not $listed) { Start-Sleep -Milliseconds 500 }
}
if ($listed) { Write-Output "  Start menu: listed as '$($listed.Name)' (press Windows, type 'LAIN Desktop')" }
else { Write-Output "  Start menu: not listed yet by Get-StartApps; the shortcut is in place, Windows usually indexes it within a minute" }
