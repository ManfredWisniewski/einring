#!/usr/bin/env python3
"""Move finished task lines (- [x] / [-]) from +team/+tasks/<persona>.md to
+team/+tasks/<persona>.history.md. Runs daily via the tasks-archive workflow;
convention: common/conventions/tasks.md. Idempotent; no-op without +team/+tasks/.
backlog.md is human-owned: finished items are dropped, never archived.
Indented continuation lines move with their task line."""
import re, glob, os, sys

DONE = re.compile(r'^(\s*)- \[[xX-]\]')
for path in sorted(glob.glob('+team/+tasks/*.md')):
    base = os.path.basename(path)
    if base == 'README.md' or base.endswith('.history.md'):
        continue
    persona = base[:-3]
    backlog = persona == 'backlog'
    keep, done = [], []
    taking = indent = 0
    for line in open(path, encoding='utf-8').read().splitlines():
        m = DONE.match(line)
        if m:
            done.append(line); taking = True; indent = len(m.group(1))
            continue
        if taking and line.strip() and line.startswith(' ' * (indent + 1)):
            done.append(line)
            continue
        taking = False
        keep.append(line)
    if not done:
        continue
    if not backlog:
        hist = f'+team/+tasks/{persona}.history.md'
        if not os.path.exists(hist):
            open(hist, 'w', encoding='utf-8').write(
                f'# Task history \u2014 {persona}\n\n'
                f'Completed tasks. Open items: `+team/+tasks/{persona}.md`.\n\n')
        with open(hist, 'a', encoding='utf-8') as f:
            f.write('\n'.join(done) + '\n')
        print(f'{path}: {len(done)} task line(s) -> {hist}')
    else:
        print(f'{path}: {len(done)} finished backlog line(s) dropped')
    with open(path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(keep).rstrip() + '\n')
sys.exit(0)
