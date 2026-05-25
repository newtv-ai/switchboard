#!/bin/bash
set -e
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
echo "Please keep this terminal open."
echo ""

npm run dev
