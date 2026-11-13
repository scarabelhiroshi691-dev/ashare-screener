@echo off
cd /d "%~dp0"
if exist "runtime\node.exe" (
  "runtime\node.exe" launcher.cjs --stop
) else (
  node launcher.cjs --stop
)
if errorlevel 1 pause