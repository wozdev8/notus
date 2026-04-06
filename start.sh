#!/bin/bash
# Notus - Start all services
# Usage: ./start.sh

echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║           Notus Launcher              ║"
echo "  ╠══════════════════════════════════════════╣"
echo "  ║  Starting all services...                ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is required. Install from https://nodejs.org"
    exit 1
fi

DIR="$(cd "$(dirname "$0")" && pwd)"

# Start the connector in background
echo "[1/2] Starting connector on port 9471..."
node "$DIR/connector/server.js" &
CONNECTOR_PID=$!

# Start the app server
echo "[2/2] Starting app server on port 3000..."
npx serve "$DIR/app" -l 3000 &
APP_PID=$!

echo ""
echo "  Services running:"
echo "    App:       http://localhost:3000"
echo "    Connector: http://localhost:9471"
echo ""
echo "  Press Ctrl+C to stop all services"
echo ""

# Trap Ctrl+C to kill both
trap "echo 'Stopping...'; kill $CONNECTOR_PID $APP_PID 2>/dev/null; exit 0" SIGINT SIGTERM

# Wait for either to exit
wait
