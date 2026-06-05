@echo off
setlocal EnableExtensions

chcp 65001 >nul 2>&1
title Switchboard Dev Server

REM ============================================================
REM SHOW_WINDOW controls whether this script keeps a visible console.
REM   true  = show the console and stream logs.
REM   false = relaunch hidden and exit this visible console.
REM ============================================================
set "SHOW_WINDOW=true"

set "START_BAT=%~f0"
set "START_DIR=%~dp0"

if /i "%SHOW_WINDOW%"=="false" if not "%~1"=="__hidden__" (
    powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Process -FilePath $env:START_BAT -ArgumentList '__hidden__' -WorkingDirectory $env:START_DIR -WindowStyle Hidden"
    exit /b
)

cd /d "%START_DIR%" || (
    echo Failed to enter script directory: %START_DIR%
    pause
    exit /b 1
)

echo =========================================
echo Checking and cleaning up existing servers...
echo Ports: 8787, 5173, 5174
echo =========================================

set "KILLED=0"
for %%p in (8787 5173 5174) do (
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":%%p"') do (
        taskkill /PID %%a /T /F >nul 2>&1
        if not errorlevel 1 set "KILLED=1"
    )
)

if "%KILLED%"=="1" (
    timeout /t 1 /nobreak >nul
)

echo.
echo =========================================
echo Starting Switchboard Geek Console...
echo Project: %CD%
echo Server:  http://127.0.0.1:8787
echo Web UI:  http://127.0.0.1:5173
echo =========================================
echo.

npm run dev
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo npm run dev exited with code %EXIT_CODE%.
    pause
)

exit /b %EXIT_CODE%
