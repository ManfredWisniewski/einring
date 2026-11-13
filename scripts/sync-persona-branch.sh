#!/usr/bin/env bash
# Syncs the current persona branch with upstream integration branches.
# Bash counterpart of sync-persona-branch.ps1 for Git Bash/Linux sessions.
# Convention: +wit/common/conventions/git-worktrees.md.
set -euo pipefail

remote="${WIT_REMOTE:-origin}"
if [ "$#" -eq 0 ]; then upstreams=("$remote/main" "$remote/wip"); else upstreams=("$@"); fi

root="$(git rev-parse --show-toplevel)"
cd "$root"

branch="$(git branch --show-current)"
[ -n "$branch" ] || { echo "detached HEAD - check out a persona branch first" >&2; exit 1; }
case "$branch" in main|work|wip) echo "refusing to sync integration branch '$branch'" >&2; exit 1;; esac
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean - commit or stash first" >&2; exit 1; }
for st in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD; do git rev-parse --verify -q "$st" >/dev/null && { echo "operation in progress ($st) - finish or abort first" >&2; exit 1; }; done
[ ! -d "$(git rev-parse --git-path rebase-merge)" ] || { echo "rebase in progress - finish or abort first" >&2; exit 1; }

git fetch "$remote" --prune
for up in "${upstreams[@]}"; do
  git rev-parse --verify -q "$up^{commit}" >/dev/null || { echo "skip    $up - ref does not exist"; continue; }
  if git merge-base --is-ancestor "$up" HEAD; then echo "uptodate $up"; continue; fi
  echo "merge   $up"
  if ! git merge --no-edit "$up"; then
    git merge --abort || true
    git submodule update --init --recursive || true
    echo "merge of $up conflicted - escalate to a human; do not resolve by hand" >&2
    exit 1
  fi
done

git submodule sync --recursive --quiet 2>/dev/null || true
git submodule update --init --recursive
echo "done    $branch synced (${upstreams[*]})"
