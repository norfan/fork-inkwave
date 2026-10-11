#!/usr/bin/env bash
# syntax check for all js/mjs/cjs in src, electron, build, tools (mirror of package.json "check")
cd "$(dirname "$0")/.." || exit 1
fail=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  node --check "$f" || { echo "FAIL: $f"; fail=1; }
done < <(find src electron build tools -name '*.js' -o -name '*.mjs' -o -name '*.cjs')
if [ "$fail" = "0" ]; then echo "syntax ok"; else exit 1; fi
