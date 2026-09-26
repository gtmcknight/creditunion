#!/usr/bin/env bash
# Local demo data on a fresh anvil (`anvil --gas-limit 60000000`): parties in every state, with the clock
# advanced between the stages the lock rules require. Writes the addresses into ../web/.dev.vars.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
RPC=${RPC:-http://127.0.0.1:8545}
KEY0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
tick() { cast rpc --rpc-url "$RPC" evm_increaseTime "$1" >/dev/null; cast rpc --rpc-url "$RPC" evm_mine >/dev/null; }
sig() { forge script script/SeedDemo.s.sol --rpc-url "$RPC" --broadcast --slow --sig "$@" 2>&1 | grep -E "^\s*[A-Z_]+ 0x|Error|Revert" || true; }

OUT=$(forge script script/SeedDemo.s.sol --rpc-url "$RPC" --broadcast --slow 2>&1)
echo "$OUT" | grep -E "^\s*(CREDITS|FACTORY|RATINGS|FIRST) 0x|Error|Revert"
get() { echo "$OUT" | awk -v k="$1" '$1==k{print $2}'; }
C=$(get CREDITS); F=$(get FACTORY); R=$(get RATINGS); B1=$(get FIRST)
[ -n "$F" ] || { echo "deploy failed"; exit 1; }

tick 301                                   # first party: countdown → burnable
sig "burnFirst(address)" "$B1"
tick 86401                                 # its auction ends
cast send --rpc-url "$RPC" --private-key "$KEY0" "$B1" "settle()" >/dev/null && echo "settled $B1"
OUT2=$(forge script script/SeedDemo.s.sol --rpc-url "$RPC" --broadcast --slow --sig "later(address)" "$F" 2>&1)
echo "$OUT2" | grep -E "^\s*(SECOND|BURN_ME) 0x|Error|Revert"
B2=$(echo "$OUT2" | awk '$1=="SECOND"{print $2}')
tick 301                                   # second party: burnable (and BURN_ME too, for an hour)
sig "burnSecond(address)" "$B2"

if [ -f ../web/.dev.vars ]; then
  sed -i '' "s/^CREDITS=.*/CREDITS=$C/; s/^FACTORY=.*/FACTORY=$F/; s/^RATINGS=.*/RATINGS=$R/" ../web/.dev.vars
  echo "web/.dev.vars → FACTORY=$F"
fi
