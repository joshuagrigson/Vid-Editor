@echo off
rem GhostCut - double-click to start the found-footage horror splicer.
title GhostCut
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
  py ghostcut.py %*
  goto :done
)
where python >nul 2>nul
if %errorlevel%==0 (
  python ghostcut.py %*
  goto :done
)
echo.
echo Python is needed to run GhostCut but wasn't found.
echo Install it from https://www.python.org/downloads/ (tick "Add to PATH"),
echo then double-click this file again.
echo.
pause
exit /b 1

:done
if errorlevel 1 (
  echo.
  echo GhostCut stopped with a problem ^(details above^).
  pause
)
