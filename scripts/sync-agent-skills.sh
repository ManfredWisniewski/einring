#!/usr/bin/env bash
# Deterministically sync +wit/agents/skills/<domain>/<skill>/ into
# .agents/skills/<skill>/ and maintain skills-lock.json.
# Usage: sync-agent-skills.sh [sync|--check]
set -euo pipefail
mode="${1:-sync}"
case "$mode" in sync|--check|check) ;; *) echo "usage: $0 [sync|--check]" >&2; exit 2;; esac
root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"; cd "$root"
src="+wit/agents/skills"; dst=".agents/skills"; lock="skills-lock.json"
[ -d "$src" ] || { [ "$mode" != "sync" ] || { echo "no $src - nothing to do"; exit 0; }; }

skills=()
while IFS= read -r d; do
  [ -f "$d/SKILL.md" ] || continue
  skills+=("$d")
done < <(find "$src" -mindepth 2 -maxdepth 2 -type d | sort)

hash_dir() { (cd "$1" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}'); }

if [ "${#skills[@]}" -eq 0 ]; then
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
