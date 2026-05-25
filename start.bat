@echo off
echo =========================================
echo Checking and cleaning up existing dev servers...
echo =========================================

:: Use robust PowerShell commands to kill port processes to avoid CMD syntax errors
powershell -Command "Get-NetTCPConnection -LocalPort 5173, 8787 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"

echo.
echo =========================================
echo Starting Switchboard Geek Console...
echo =========================================
echo Please keep this window open.
echo.

call npm run dev

pause
