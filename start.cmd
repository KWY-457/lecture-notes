@echo off
rem ===========================================================================
rem  LectureNotes launcher  (ASCII only on purpose)
rem
rem  NOTE: keep this file pure ASCII. cmd.exe tracks its position in a batch
rem  file by byte offset; once "chcp 65001" is active, multi-byte characters in
rem  the file make cmd re-read from a wrong offset and chop lines apart.
rem  Chinese messages are printed by server.mjs (UTF-8, works fine after chcp).
rem ===========================================================================
chcp 65001 >nul 2>nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
title LectureNotes

set "RUNNER="

rem 1) explicit override
if defined NODE_EXE if exist "%NODE_EXE%" set "RUNNER=%NODE_EXE%"

rem 2) node on PATH
if not defined RUNNER (
  for /f "delims=" %%N in ('where node 2^>nul') do (
    if not defined RUNNER set "RUNNER=%%N"
  )
)

rem 2b) the runtime shipped inside this folder (runtime\node.exe).
rem     This is the intended path for a sold copy: the customer's machine has
rem     no Node.js, so the app must carry its own. Checked BEFORE the system
rem     locations so a green copy never depends on what is installed.
if not defined RUNNER if exist "%~dp0runtime\node.exe" set "RUNNER=%~dp0runtime\node.exe"

rem 3) common install locations
if not defined RUNNER if exist "%ProgramFiles%\nodejs\node.exe" set "RUNNER=%ProgramFiles%\nodejs\node.exe"
if not defined RUNNER if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "RUNNER=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined RUNNER if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "RUNNER=%LOCALAPPDATA%\Programs\nodejs\node.exe"

rem 3b) Node runtime bundled with DSH (DeepSeek Harness).
rem     NOTE (2026-10-14): a copy of the app is NOT supposed to need these.
rem     They are kept only so that an unfinished/dev copy still starts on this
rem     machine. The real fallback for a sold copy is runtime\node.exe (2b).
rem     Keep them pure ASCII: cmd.exe tracks its position in a batch file by
rem     byte offset, and non-ASCII text in this file would break that.
if not defined RUNNER if exist "D:\Download\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" set "RUNNER=D:\Download\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not defined RUNNER if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "RUNNER=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

rem 4) Electron runtime bundled with DSH Desktop (acts as node when
rem    ELECTRON_RUN_AS_NODE=1). Handy when Node.js is not installed.
set "ELECTRON_CANDIDATES="
for %%D in (C D E F) do (
  if exist "%%D:\Download\DSH Desktop\DSH Desktop.exe" if not defined RUNNER (
    set "RUNNER=%%D:\Download\DSH Desktop\DSH Desktop.exe"
    set "ELECTRON_RUN_AS_NODE=1"
  )
  if exist "%%D:\Program Files\DSH Desktop\DSH Desktop.exe" if not defined RUNNER (
    set "RUNNER=%%D:\Program Files\DSH Desktop\DSH Desktop.exe"
    set "ELECTRON_RUN_AS_NODE=1"
  )
)
if not defined RUNNER if exist "%LOCALAPPDATA%\Programs\DSH Desktop\DSH Desktop.exe" (
  set "RUNNER=%LOCALAPPDATA%\Programs\DSH Desktop\DSH Desktop.exe"
  set "ELECTRON_RUN_AS_NODE=1"
)

if not defined RUNNER (
  echo.
  echo   [ERROR] No JavaScript runtime found.
  echo.
  if exist "%~dp0helpers\no-node.zh.txt" type "%~dp0helpers\no-node.zh.txt"
  echo.
  echo   Option 1: install Node.js ^(recommended^) - https://nodejs.org/en/download
  echo   Option 2: set the NODE_EXE environment variable to any node.exe
  echo   Option 3: install DSH Desktop ^(its bundled runtime also works^)
  echo.
  if exist "%~dp0helpers\no-node.zh.txt" pause
  exit /b 1
)

"%RUNNER%" "%~dp0server.mjs" %*
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo   Server exited with code %CODE%
  pause
)
endlocal
