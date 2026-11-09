#!/bin/zsh
# Shows card-classifier training progress and refreshes every 20 seconds. Ctrl-C to stop.
#   tools/cards/progress.sh
cd "$(dirname "$0")/../../data/cards/runs" || exit 1
while true; do
  clear
  date '+%H:%M:%S'
  echo
  printf '%-22s %-8s %-9s %-9s %s\n' run epoch val_acc dev_acc seconds
  for f in r2-*.log; do
    [ -f "$f" ] || continue
    name=${f%.log}
    last=$(grep -a "'epoch'" "$f" | tail -1)
    if [ -d "$name" ] && [ -f "$name/log.json" ]; then state="done"; else state="running"; fi
    if [ -n "$last" ]; then
      e=$(echo "$last" | sed -E "s/.*'epoch': ([0-9]+).*/\1/")
      v=$(echo "$last" | sed -E "s/.*'val_kind_acc': ([0-9.]+).*/\1/")
      d=$(echo "$last" | sed -E "s/.*'dev_kind_acc': ([0-9.]+).*/\1/")
      s=$(echo "$last" | sed -E "s/.*'seconds': ([0-9]+).*/\1/")
      printf '%-22s %-8s %-9s %-9s %s  %s\n' "$name" "$e" "$v" "$d" "$s" "$state"
    else
      printf '%-22s starting\n' "$name"
    fi
  done
  echo
  ls queue3.done queue4.done 2>/dev/null | sed 's/^/finished: /'
  echo
  echo "swap: $(sysctl -n vm.swapusage | sed -E 's/total = ([0-9.]+M).*used = ([0-9.]+M).*/used \2 of \1/')"
  sleep 20
done
