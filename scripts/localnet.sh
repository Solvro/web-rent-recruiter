#!/usr/bin/env bash
# Local validator for the app/backend: Surfpool in clock mode (review windows follow wall time),
# deploying target/deploy/scout.so itself (same as `anchor localnet`, minus its log-stream crash).
# `anchor test` uses its own Surfpool in transaction mode instead.
set -euo pipefail
cd "$(dirname "$0")/.."
PROGRAM_ID=CmdM2WPuZ6ZrwDXP7DtzfBfR4LMocHs9tqNpGB7JCTo2
surfpool start --host 127.0.0.1 --port 8899 --offline --block-production-mode clock \
	--no-tui --yes --legacy-anchor-compatibility --log-level none &
SURFPOOL=$!
trap 'kill $SURFPOOL 2>/dev/null' EXIT INT TERM
until curl -sf -X POST http://127.0.0.1:8899 -H 'Content-Type: application/json' \
	-d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$PROGRAM_ID\",{\"encoding\":\"base64\"}]}" |
	grep -q '"executable":true'; do sleep 1; done
echo "Surfpool on http://127.0.0.1:8899 with the Scout program. Next: pnpm setup:localnet"
wait $SURFPOOL
