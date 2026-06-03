@echo off
REM ============================================================
REM  SHOW_WINDOW —— 控制台黑窗口显示开关（手动改这一行即可）
REM    true  = 显示黑窗口，能实时看到日志
REM    false = 隐藏窗口，在后台静默运行
REM            （双击瞬间会闪一下属正常；停止请在任务管理器结束 node）
REM ============================================================
set "SHOW_WINDOW=true"

REM ---- false 时：用隐藏窗口的方式重启自己，再退出当前可见窗口 ----
if /i "%SHOW_WINDOW%"=="false" if not "%~1"=="__hidden__" (
    powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '%~f0' -ArgumentList '__hidden__' -WindowStyle Hidden"
    exit /b
)

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
