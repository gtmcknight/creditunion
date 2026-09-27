#!/usr/bin/env bash
# Runs each Halmos rule on its own with a wall-clock cap, so one slow rule can't hide the others.
# Usage: test/formal/run.sh <Contract> [seconds per rule, default 900] [extra halmos flags...]
# Full output per rule lands in test/formal/logs/<Contract>.<rule>.log.
set -u
c=$1; cap=${2:-900}; shift; shift 2>/dev/null || true
cd "$(dirname "$0")/../.."
mkdir -p test/formal/logs
file=$(grep -l "^contract $c " test/formal/*.t.sol) || { echo "no contract $c"; exit 1; }
# the check_ functions declared inside contract $c (up to the next top-level contract)
for f in $(awk -v c="$c" '/^(abstract )?contract /{on = ($2 == c)} on && /function check_/{sub(/.*function /, ""); sub(/\(.*/, ""); print}' "$file"); do
  log=test/formal/logs/$c.$f.log
  echo "\$ halmos --match-contract '^$c\$' --match-test '^$f\(' $*" > "$log"
  perl -e 'alarm shift; exec @ARGV' "$cap" halmos --match-contract "^$c\$" --match-test "^$f\(" --no-status "$@" >> "$log" 2>&1
  rc=$?
  [ $rc -eq 142 ] && echo "TIMED OUT after ${cap}s (wall clock)" >> "$log"
  echo "$c.$f rc=$rc $(grep -Eo '\[(PASS|FAIL|TIMEOUT|ERROR)\][^(]*' "$log" | head -1)"
done
