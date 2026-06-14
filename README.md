# Simple Git

Simple Git brings the version control experience from JetBrains IDEs straight into your VS Code.

## Features

### Branch panel

Opens in the Activity Bar — shows all branches split into **Local** and **Remote** groups, with the current branch marked.

### Toolbar buttons

| Button               | Action                                                                      |
| -------------------- | --------------------------------------------------------------------------- |
| `$(sync)` Fetch All  | `git fetch --all --prune` — updates remote refs and prunes deleted branches |
| `$(refresh)` Refresh | Re-reads branch list from local git state                                   |

> The panel also **auto-refreshes** when `.git/HEAD`, `.git/refs`, or `.git/packed-refs` change.

### Right-click menu — local branches

| Action              | Available on                                                                    |
| ------------------- | ------------------------------------------------------------------------------- |
| Checkout            | Non-current branches                                                            |
| Push                | Any local branch (`git push -u origin <branch>`)                                |
| Pull                | Current branch only (`git pull`)                                                |
| Rename Branch       | Non-protected branches                                                          |
| Delete Local Branch | Non-protected, non-current branches — offers safe (`-d`) or force (`-D`) delete |

### Right-click menu — remote branches

| Action                                | Description                                                             |
| ------------------------------------- | ----------------------------------------------------------------------- |
| New Branch from Selected              | Creates and checks out a new local branch from the remote branch        |
| Checkout                              | Creates a local tracking branch and checks it out                       |
| Pull into Current Branch Using Rebase | `git pull --rebase <remote> <branch>` onto HEAD                         |
| Pull into Current Branch Using Merge  | `git pull <remote> <branch>` onto HEAD                                  |
| Delete Remote Branch                  | `git push <remote> --delete <branch>` — protected branches are excluded |

### Protected branches

`main`, `master`, and `develop` are considered protected — delete and rename are hidden for them.

### Conflict resolution

When a pull or merge produces conflicts, a conflict list panel opens automatically. It shows every conflicted file and lets you:

- **Click a file** to open it in VS Code's built-in 3-way merge editor. The panel hides while you resolve and reappears when you close the editor.
- **Continue** the merge or rebase once all conflicts are resolved (the panel detects this automatically and prompts you).
- **Abort** to cancel the entire merge or rebase.

The conflict list updates in real time as files are resolved — no need to manually refresh.

### Checkout with in-progress merge

If you try to check out a branch while a merge or rebase is stuck on unresolved conflicts, you are offered the option to abort the in-progress operation and switch branches immediately.

## Requirements

- Git must be available in `PATH`.
- A workspace folder containing a `.git` directory.
