#!/bin/zsh
# Usage: run.sh <name> <python script> [args...]
# Runs the script under /usr/bin/time -l (max RSS) and records swap before/after.
# Writes out/<name>.time.txt (stderr of time), out/<name>.log (stdout+stderr) and out/<name>.meta.json
cd "$(dirname "$0")"
name=$1; shift
mkdir -p out
export DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib
export PYTHONUNBUFFERED=1
export PYTHONPATH="$PWD/vendor/star-vector:$PWD"
swap_before=$(sysctl -n vm.swapusage)
/usr/bin/time -l -o "out/$name.time.txt" perl -e 'alarm 600; exec @ARGV' .venv/bin/python "$@" > "out/$name.log" 2>&1
code=$?
swap_after=$(sysctl -n vm.swapusage)
.venv/bin/python - "$name" "$code" "$swap_before" "$swap_after" <<'PY'
import json, re, sys
name, code, sb, sa = sys.argv[1:5]
def used(s):
    m = re.search(r"used = ([\d.]+)M", s); return float(m.group(1))
rss = None
for line in open(f"out/{name}.time.txt"):
    if "maximum resident set size" in line: rss = int(line.split()[0])
meta = dict(name=name, exit=int(code), swap_before=sb, swap_after=sa,
            swap_change_mb=round(used(sa) - used(sb), 1),
            peak_rss_gb=round(rss / 1e9, 2) if rss else None)
json.dump(meta, open(f"out/{name}.meta.json", "w"), indent=1)
print(json.dumps(meta))
PY
