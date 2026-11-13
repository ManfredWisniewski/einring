#!/usr/bin/env bash
# Scheduled janitor: merge origin/main then origin/wip into stale persona branches.
# Safe by construction: merge-only, aborts conflicts, never touches main/work/wip,
# never force-pushes, and skips branches with no unique commits.
# Env: WIT_REMOTE (default origin), WIT_PROTECTED_BRANCHES (space-separated).
set -euo pipefail
remote="${WIT_REMOTE:-origin}"
protected="${WIT_PROTECTED_BRANCHES:-main work wip}"
dry=0; [ "${1:-}" = "--dry-run" ] && dry=1
root="$(git rev-parse --show-toplevel)"; cd "$root"
git fetch "$remote" --prune "+refs/heads/*:refs/remotes/$remote/*"
git rev-parse --verify -q "$remote/main^{commit}" >/dev/null || { echo "no $remote/main" >&2; exit 0; }
git rev-parse --verify -q "$remote/wip^{commit}" >/dev/null || { echo "no $remote/wip" >&2; exit 0; }
conflicts=0; synced=0; skipped=0; failed=0
for ref in $(git for-each-ref --format='%(refname:short)' "refs/remotes/$remote"); do
  b=${ref#"$remote"/}
  [[ " $protected " == *" $b "* ]] && continue
  [[ "$b" == "HEAD" || -z "$b" ]] && continue
  git merge-base "$remote/wip" "$remote/$b" >/dev/null 2>&1 || continue
  git merge-base --is-ancestor "$remote/$b" "$remote/wip" && { skipped=$((skipped+1)); continue; }
  git merge-base --is-ancestor "$remote/main" "$remote/$b" && git merge-base --is-ancestor "$remote/wip" "$remote/$b" && { skipped=$((skipped+1)); continue; }
  echo "sync    $b"
  tmp=$(mktemp -d)
  cleanup() { git worktree remove --force "$tmp/wt" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
  trap cleanup EXIT
  git worktree add --detach "$tmp/wt" "$remote/$b" >/dev/null
  if ! (cd "$tmp/wt" && git config user.name "wit-ci" && git config user.email "wit-ci@localhost" && git merge --no-edit "$remote/main"); then
    (cd "$tmp/wt" && git merge --abort) >/dev/null 2>&1 || true
    echo "conflict $b (main)" >&2; conflicts=$((conflicts+1)); cleanup; trap - EXIT; continue
  fi
  if ! (cd "$tmp/wt" && git merge --no-edit "$remote/wip"); then
    (cd "$tmp/wt" && git merge --abort) >/dev/null 2>&1 || true
    echo "conflict $b (wip)" >&2; conflicts=$((conflicts+1)); cleanup; trap - EXIT; continue
  fi
  if [ "$dry" -eq 1 ]; then echo "would push $b"; synced=$((synced+1)); cleanup; trap - EXIT; continue; fi
  if ! git -C "$tmp/wt" push "$remote" "HEAD:refs/heads/$b"; then
    echo "push rejected $b (branch moved or protected)" >&2; failed=$((failed+1)); cleanup; trap - EXIT; continue
  fi
  cleanup; trap - EXIT
  synced=$((synced+1))
done
echo "janitor: synced=$synced skipped=$skipped conflicts=$conflicts failed=$failed"
[ "$conflicts" -eq 0 ] && [ "$failed" -eq 0 ]
