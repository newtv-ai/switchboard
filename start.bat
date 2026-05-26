@echo off
set KILLED=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":8787"') do (
    taskkill /PID %%a /T /F >nul 2>&1
    set KILLED=1
)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":5173"') do (
    taskkill /PID %%a /T /F >nul 2>&1
    set KILLED=1
)
if "%KILLED%"=="1" timeout /t 1 /nobreak >nul

echo =========================================
echo Starting Switchboard Geek Console...
echo =========================================
echo.

npm run dev
