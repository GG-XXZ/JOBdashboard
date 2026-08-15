#!/bin/sh
# Start the JOBdashboard dashboard on macOS/Linux.
cd "$(dirname "$0")"
( sleep 1 && (open "http://localhost:8420/dashboard.html" 2>/dev/null || xdg-open "http://localhost:8420/dashboard.html" 2>/dev/null) ) &
node server.js
