#!/usr/bin/env bash
# Pull repository updates; update the +wit submodule and sync agent skills.
# Invoked by the pull-on-open VS Code task (.vscode/tasks.json); on Windows
# pull-on-open.ps1 locates a real Git Bash and runs this script.
git pull --ff-only --autostash
git submodule update --init --recursive
if [ -d +wit ]; then
  b=$(git config -f .gitmodules --get submodule.+wit.branch)
  [ -n "$b" ] && git -C +wit checkout -q "$b"
  git -C +wit pull --ff-only --autostash
fi
[ -f scripts/sync-agent-skills.sh ] && bash scripts/sync-agent-skills.sh sync
exit 0
