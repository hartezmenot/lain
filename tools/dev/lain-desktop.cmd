@echo off
rem LAIN DESKTOP (DEV): start the LAIN Harness from this checkout, without an installer.
rem   tools\dev\lain-desktop.cmd [--no-design] [--dev] [other lain flags]
rem The checkout is the folder two levels up; the Harness is its harness\ folder.
rem Nothing is copied: what runs is this checkout and that Harness folder, as they are on disk.
setlocal EnableExtensions
set "TITLE=LAIN Desktop (dev)"
for %%I in ("%~dp0..\..") do set "LAIN_ROOT=%%~fI"

set "ARGS="
:args
if "%~1"=="" goto checked
if /i "%~1"=="--no-design" (
  rem A COPY WITH DESIGN OFF: Design is looked for only here, and nothing is here.
  set "LAIN_DESIGN_DIR=%TEMP%\lain-no-design"
) else (
  set "ARGS=%ARGS% %1"
)
shift
goto args
:checked

where node >nul 2>nul || (call :fail "Node.js was not found on PATH. Install Node.js 20 or newer (nodejs.org), then start %TITLE% again." & exit /b 1)
if not exist "%LAIN_ROOT%\bin\lain.js" (call :fail "No LAIN checkout at %LAIN_ROOT% (bin\lain.js is missing). Keep this file in tools\dev of the LAIN checkout." & exit /b 1)
if not exist "%LAIN_ROOT%\harness\index.js" (call :fail "No LAIN Harness at %LAIN_ROOT%\harness — this checkout is incomplete." & exit /b 1)
if not defined LAIN_DESIGN_DIR if not exist "%LAIN_ROOT%\packages\design-core\node_modules\parse5\package.json" (
  call :warn "LAIN Design's parsers are not installed, so the Design room will not appear. To add them: npm ci --omit=dev --prefix packages/design-core (in %LAIN_ROOT%). Starting without Design."
)

rem ANOTHER LAIN ALREADY RUNNING (the installed one, or a CLI): --desktop would only bring THAT window to the front.
set "RUNNING="
for /f "usebackq delims=" %%R in (`node -e "require(process.argv[1]).discover().then(r=>{if(r.running)console.log('pid '+r.pid+(r.version?', LAIN '+r.version:''));process.exit(0)},()=>process.exit(0))" "%LAIN_ROOT%\src\corelock.js"`) do set "RUNNING=%%R"
if defined RUNNING (call :fail "A LAIN is already running (%RUNNING%). Exit it first (the rail's Exit LAIN, or /exit in its terminal): this checkout would otherwise only show that window." & exit /b 1)

cd /d "%USERPROFILE%"
node "%LAIN_ROOT%\bin\lain.js" --desktop%ARGS%
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" call :fail "LAIN Desktop exited with code %CODE%. Run %~f0 from a terminal to read why."
exit /b %CODE%

:fail
echo %TITLE%: %~1 1>&2
set "LAIN_MSG=%~1"
powershell -NoProfile -WindowStyle Hidden -Command "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($env:LAIN_MSG, $env:TITLE, 'OK', 'Error')" >nul 2>nul
exit /b 0

:warn
echo %TITLE%: %~1 1>&2
set "LAIN_MSG=%~1"
powershell -NoProfile -WindowStyle Hidden -Command "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($env:LAIN_MSG, $env:TITLE, 'OK', 'Warning')" >nul 2>nul
exit /b 0
