#!/usr/bin/env python3
"""Check a repository against the wit-common structure inventory.

Usage:
  check-repo-structure.py [repo-root] [--inventory PATH] [--name NAME]
                          [--remote] [--skills-check]
"""
import argparse, json, os, shutil, subprocess, sys

def exists(root, p): return os.path.exists(os.path.join(root, p))
def isfile(root, p): return os.path.isfile(os.path.join(root, p))
def isdir(root, p): return os.path.isdir(os.path.join(root, p))

def project_type(root):
    f = os.path.join(root, '.wit-project-type')
    if os.path.isfile(f):
        return open(f, errors='ignore').read().strip() or None
    return None

def run(root, *args, check=False):
    return subprocess.run(args, cwd=root, text=True, capture_output=True)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('root', nargs='?', default='.')
    ap.add_argument('--inventory')
    ap.add_argument('--name')
    ap.add_argument('--remote', action='store_true')
    ap.add_argument('--skills-check', action='store_true')
    a = ap.parse_args()
    root = os.path.abspath(a.root)
    inv = a.inventory or ('+wit/common/repo-inventory.json' if exists(root, '+wit/common/repo-inventory.json') else 'common/repo-inventory.json')
    inv_path = os.path.join(root, inv)
    if not os.path.isfile(inv_path):
        print(f'inventory not found: {inv}', file=sys.stderr); return 2
    data = json.load(open(inv_path))
    repos = data.get('repositories', data if isinstance(data, list) else [])
    name = a.name or os.path.basename(root).lower()
    # entries with "project_type" are additive fragments, never the base profile
    selectable = [r for r in repos if not r.get('project_type')]
    entry = next((r for r in selectable if str(r.get('name','')).lower() == name or str(r.get('path','')).lower() == name), None)
    if entry is None:
        entry = next((r for r in selectable if r.get('default')), None)
    if entry is None:
        print(f'no inventory entry for {name} and no default profile in {inv}', file=sys.stderr); return 2
    ptype = project_type(root)
    profiles = [entry] + [r for r in repos if ptype and r.get('project_type') == ptype]
    required = [p for r in profiles for p in r.get('required', [])]
    any_of = [g for r in profiles for g in r.get('any_of', [])]
    errors = []
    for p in required:
        if not exists(root, p): errors.append(f'missing: {p}')
    for group in any_of:
        if group and not any(exists(root, p) for p in group): errors.append('missing any of: ' + ', '.join(group))
    if entry.get('wit_submodule', True):
        gm = os.path.join(root, '.gitmodules')
        if not isfile(root, '.gitmodules') or '+wit' not in open(gm, errors='ignore').read():
            errors.append('missing +wit submodule in .gitmodules')
    if entry.get('agents_md_nul_rule', True):
        f = os.path.join(root, 'AGENTS.md')
        if not os.path.isfile(f) or '/dev/null' not in open(f, errors='ignore').read():
            errors.append('AGENTS.md missing Git Bash /dev/null rule')
    if a.remote or entry.get('check_remote_branches'):
        for b in ('main', 'work', 'wip'):
            r = run(root, 'git', 'ls-remote', '--heads', 'origin', f'refs/heads/{b}')
            if r.returncode != 0 or not r.stdout.strip(): errors.append(f'missing remote branch: {b}')
    if a.skills_check or entry.get('skills_check'):
        script = os.path.join(root, '+wit/common/templates/common/scripts/sync-agent-skills.sh')
        if not os.path.isfile(script): script = os.path.join(root, 'scripts/sync-agent-skills.sh')
        if not os.path.isfile(script): errors.append('missing scripts/sync-agent-skills.sh')
        else:
            r = run(root, shutil.which('bash') or 'bash', script, '--check')
            if r.returncode != 0:
                errors.append('agent skills drift:\n' + (r.stdout + r.stderr).strip())
    for e in errors: print(e)
    if errors: return 1
    print('structure ok')
    return 0

if __name__ == '__main__': sys.exit(main())
