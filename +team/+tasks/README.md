# Tasks

One task file per agent or person: `+team/+tasks/<persona>.md`. Format and rules: `+wit/common/conventions/tasks.md`.

- Task files hold work assigned to that persona. Agents may add tasks for other assignees; only the assignee marks tasks done or moves them.
- Task lines use the Obsidian Tasks emoji format with `#task` plus `#persona/<name>` (and `#entity/<name>` when ambiguous).
- `backlog.md` — human-owned parking lot for unassigned future tasks (`#task`, no `#persona/` tag). Agents never write it; humans move tasks in and out.
- If this folder is missing in a repository, tasks are not managed there — do not create it.
