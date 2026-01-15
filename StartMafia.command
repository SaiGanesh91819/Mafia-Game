#!/bin/bash
# Get the directory where this script is located
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "---------------------------------------------------"
echo "           STARTING MAFIA LAN SERVER               "
echo "---------------------------------------------------"

# Check if node is installed
if ! command -v node &> /dev/null
then
    echo "ERROR: Node.js is not installed or not in PATH."
    read -p "Press Enter to exit..."
    exit
fi

cd "$DIR/server"

# Handle cleanup on exit
cleanup() {
    echo ""
    echo "Shutting down..."
    exit
}
trap cleanup SIGINT

# Get Local IP
IP=$(ipconfig getifaddr en0)
if [ -z "$IP" ]; then
    IP="localhost"
fi

echo "Game running at: http://$IP:3000"
echo "Opening browser..."
open "http://$IP:3000"

# Run Server
node index.js
