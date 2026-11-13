@echo off
cd /d "%~dp0"
if exist "runtime\node.exe" (
  "runtime\node.exe" launcher.cjs
) else (
  node launcher.cjs
)
if errorlevel 1 pause