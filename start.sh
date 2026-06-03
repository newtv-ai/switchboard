#!/bin/bash
set -e

# ============================================================
#  SHOW_WINDOW —— 是否占用/显示当前终端（手动改这一行即可）
#    true  = 前台运行，留在当前终端，能实时看到日志
#    false = 后台静默运行，不占用终端（日志写入 switchboard.log）
#            停止方式：kill $(lsof -ti:8787,5173)
#  注：Linux 没有 Windows 那种自动弹出的黑窗口，
#      这里的 false 等价于"脱离终端、后台静默运行"。
# ============================================================
SHOW_WINDOW=true
echo "========================================="
echo "Checking and cleaning up existing dev servers..."
echo "========================================="

# Find and kill processes using ports 5173 and 8787
if command -v lsof >/dev/null 2>&1; then
    PIDS=$(lsof -ti:5173,8787 2>/dev/null)
    if [ ! -z "$PIDS" ]; then
        echo "Stopping processes on ports 5173 and 8787..."
        kill -9 $PIDS 2>/dev/null
    fi
else
    echo "Warning: lsof command not found, skipping auto-cleanup."
fi

echo ""
echo "========================================="
echo "Starting Switchboard Geek Console..."
echo "========================================="

if [ "$SHOW_WINDOW" = "false" ]; then
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    LOG="$SCRIPT_DIR/switchboard.log"
    echo "后台静默运行中（不显示窗口），日志写入: $LOG"
    echo "停止方式: kill \$(lsof -ti:8787,5173)"
    nohup npm run dev >"$LOG" 2>&1 &
    disown
    exit 0
fi

echo "Please keep this terminal open."
echo ""

npm run dev
