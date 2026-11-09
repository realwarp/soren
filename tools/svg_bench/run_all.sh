#!/bin/sh
# Run 2B, 4B, 9B in order (each starts and stops its own llama-server). Usage: sh run_all.sh
cd "$(dirname "$0")"
for m in 2B 4B 9B; do
  .venv/bin/python run_bench.py $m --approach AB || echo "run for $m failed"
done
pgrep -fl llama-server || echo "no llama-server left running"
