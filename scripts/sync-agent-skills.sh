#!/usr/bin/env bash
# Deterministically sync +wit/agents/skills/<domain>/<skill>/ into
# .agents/skills/<skill>/ and maintain skills-lock.json.
# Usage: sync-agent-skills.sh [sync|--check]
set -euo pipefail
mode="${1:-sync}"
case "$mode" in sync|--check|check) ;; *) echo "usage: $0 [sync|--check]" >&2; exit 2;; esac
root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"; cd "$root"
src="+wit/agents/skills"; dst=".agents/skills"; lock="skills-lock.json"; cfg="skills-domains.json"
if [ ! -d "$src" ]; then
  if [ "$mode" = "sync" ]; then echo "no $src - nothing to do"; exit 0; fi
  echo "no skills found" >&2; exit 1
fi

# Optional per-repo domain filter: skills-domains.json
#   { "version": 1, "include": ["common", "strategy"], "exclude": ["arr"] }
# include empty/absent -> all domains; exclude is always subtracted.
json_list() { # <file> <key> -> newline-separated list entries
  if command -v python >/dev/null 2>&1; then
    python - "$1" "$2" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
v = d.get(sys.argv[2]) or []
if isinstance(v, list):
    print("\n".join(str(i) for i in v))
PY
  elif command -v node >/dev/null 2>&1; then
    node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=d[process.argv[2]]||[];if(Array.isArray(v))console.log(v.join("\n"))' "$1" "$2"
  else
    echo "error: $1 present but neither python nor node is available to parse it" >&2; exit 1
  fi
}

include=() exclude=()
if [ -f "$cfg" ]; then
  while IFS= read -r line; do [ -n "$line" ] && include+=("$line"); done < <(json_list "$cfg" include | tr -d '\r')
  while IFS= read -r line; do [ -n "$line" ] && exclude+=("$line"); done < <(json_list "$cfg" exclude | tr -d '\r')
fi

in_list() { local x="$1"; shift; local i; for i in "$@"; do [ "$i" = "$x" ] && return 0; done; return 1; }

skills=()
while IFS= read -r d; do
  [ -f "$d/SKILL.md" ] || continue
  dom="$(basename "$(dirname "$d")")"
  if [ "${#include[@]}" -gt 0 ] && ! in_list "$dom" "${include[@]}"; then continue; fi
  if [ "${#exclude[@]}" -gt 0 ] && in_list "$dom" "${exclude[@]}"; then continue; fi
  skills+=("$d")
done < <(find "$src" -mindepth 2 -maxdepth 2 -type d | sort)

if [ -f "$cfg" ] && [ "${#include[@]}" -gt 0 ]; then
  for inc in "${include[@]}"; do
    [ -d "$src/$inc" ] || echo "warning: $cfg include lists '$inc' but $src/$inc does not exist" >&2
  done
fi

hash_dir() { (cd "$1" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}'); }

if [ "${#skills[@]}" -eq 0 ]; then
  if [ -f "$cfg" ]; then
    echo "error: $cfg selected no skills — check include/exclude against $src" >&2; exit 1
  fi
  [ "$mode" = "sync" ] && { rm -rf "$dst"; printf '{\n  "version": 1,\n  "source": "%s",\n  "skills": {}\n}\n' "$src" > "$lock"; echo "no skills"; exit 0; }
  echo "no skills found" >&2; exit 1
fi

names=()
for d in "${skills[@]}"; do names+=("$(basename "$d")"); done
dupes=$(printf '%s\n' "${names[@]}" | sort | uniq -d)
[ -z "$dupes" ] || { echo "duplicate skill names: $dupes" >&2; exit 1; }

check_one() {
  local d="$1" name target
  name="$(basename "$d")"; target="$dst/$name"
  [ -d "$target" ] || { echo "missing: $target"; return 1; }
  diff -qr "$d" "$target" >/dev/null 2>&1 || { echo "drift: $target"; return 1; }
}

lock_json() {
  printf '{\n  "version": 1,\n  "source": "%s",\n  "skills": {\n' "$src"
  first=1
  for d in "${skills[@]}"; do
    n="$(basename "$d")"; h="$(hash_dir "$d")"
    [ "$first" -eq 0 ] && printf ',\n'; first=0
    printf '    "%s": "%s"' "$n" "$h"
  done
  printf '\n  }\n}\n'
}

if [ "$mode" = "--check" ] || [ "$mode" = "check" ]; then
  fail=0
  for d in "${skills[@]}"; do check_one "$d" || fail=1; done
  if [ -d "$dst" ]; then
    while IFS= read -r extra; do
      n=$(basename "$extra"); printf '%s\n' "${names[@]}" | grep -qx "$n" || { echo "stale: $extra"; fail=1; }
    done < <(find "$dst" -mindepth 1 -maxdepth 1 -type d | sort)
  fi
  if [ ! -f "$lock" ]; then echo "missing: $lock"; fail=1
  elif [ "$(lock_json)" != "$(cat "$lock")" ]; then echo "drift: $lock"; fail=1; fi
  [ "$fail" -eq 0 ] && echo "skills in sync" || exit 1
  exit 0
fi

rm -rf "$dst"; mkdir -p "$dst"
for d in "${skills[@]}"; do cp -a "$d" "$dst/$(basename "$d")"; done
lock_json > "$lock"
echo "synced ${#skills[@]} skills"
