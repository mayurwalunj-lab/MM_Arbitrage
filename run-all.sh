#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-main}"

PIDS=()

start_service() {
  local name="$1"
  local dir="$2"
  local file="$3"

  if [ ! -d "$ROOT_DIR/node_modules" ]; then
    echo "[$name] Missing root node_modules in: $ROOT_DIR"
    echo "[$name] Run: cd \"$ROOT_DIR\" && npm install"
    exit 1
  fi

  echo "[$name] starting: $dir/$file"
  (
    cd "$ROOT_DIR"
    node "$dir/$file"
  ) &
  PIDS+=("$!")
}

stop_all() {
  echo
  echo "Stopping services..."
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}

trap stop_all INT TERM EXIT

BITMART_DIR="bitmart"
LBANK_DIR="lbank"
DASHBOARD_DIR="dashboard"

case "$MODE" in
  all|main|pattern)
    start_service "bitmart-pattern" "$BITMART_DIR" "Bitmart_Pattern_Trading.js"
    start_service "bitmart-grid" "$BITMART_DIR" "grid_manager_bitmart.js"
    start_service "lbank-pattern" "$LBANK_DIR" "Lbank_Pattern_Trading.js"
    start_service "lbank-grid" "$LBANK_DIR" "LBank_GridManager.js"
    start_service "dashboard" "$DASHBOARD_DIR" "Server.js"
    ;;
  bots)
    start_service "bitmart-pattern" "$BITMART_DIR" "Bitmart_Pattern_Trading.js"
    start_service "lbank-pattern" "$LBANK_DIR" "Lbank_Pattern_Trading.js"
    ;;
  grids)
    start_service "bitmart-grid" "$BITMART_DIR" "grid_manager_bitmart.js"
    start_service "lbank-grid" "$LBANK_DIR" "LBank_GridManager.js"
    ;;
  bitmart)
    start_service "bitmart-pattern" "$BITMART_DIR" "Bitmart_Pattern_Trading.js"
    start_service "bitmart-grid" "$BITMART_DIR" "grid_manager_bitmart.js"
    ;;
  lbank)
    start_service "lbank-pattern" "$LBANK_DIR" "Lbank_Pattern_Trading.js"
    start_service "lbank-grid" "$LBANK_DIR" "LBank_GridManager.js"
    ;;
  ui|dashboard)
    start_service "dashboard" "$DASHBOARD_DIR" "Server.js"
    ;;
  *)
    echo "Usage: ./run-all.sh [all|bots|grids|bitmart|lbank|dashboard]"
    echo
    echo "all       Starts Bitmart pattern + Bitmart grid + LBank pattern + LBank grid + dashboard"
    echo "bots      Starts Bitmart pattern + LBank pattern"
    echo "grids     Starts Bitmart grid + LBank grid"
    echo "bitmart   Starts Bitmart pattern + Bitmart grid"
    echo "lbank     Starts LBank pattern + LBank grid"
    echo "dashboard Starts only the dashboard"
    exit 1
    ;;
esac

echo
echo "Services started."
echo "Bitmart bot UI: http://localhost:5010"
echo "LBank bot UI:   http://localhost:5001"
echo "Dashboard:      http://localhost:5002"
echo
echo "Press Ctrl+C to stop all services."

wait
