# Simple Git — Agent Notes

## Architecture

Three files, no external runtime dependencies:

| File                       | Role                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `src/extension.ts`         | Activation, registers `TreeView`, commands, and `.git` file watcher                |
| `src/gitBranchProvider.ts` | `TreeDataProvider` — two groups (Local / Remote) → branch items                    |
| `src/commands.ts`          | All git operations via `execFile('git', args, {cwd})` (no shell, safe arg passing) |

Build: esbuild bundles everything into `dist/extension.js`. Type-check only via `tsc --noEmit`.

## Context Value Scheme

Branch items carry a `contextValue` that drives all `view/item/context` `when` clauses:

| contextValue                    | Meaning                                |
| ------------------------------- | -------------------------------------- |
| `gitbm-local-current`           | Checked-out branch, not protected      |
| `gitbm-local-regular`           | Local, not current, not protected      |
| `gitbm-local-protected`         | Local main/master/develop, not current |
| `gitbm-local-protected-current` | Checked-out protected branch           |
| `gitbm-remote-regular`          | Remote branch, not protected           |
| `gitbm-remote-protected`        | Remote main/master/develop             |

`PROTECTED_BRANCHES` in `gitBranchProvider.ts` controls what counts as protected.

When adding a new command: entries needed in `package.json` (`commands` + `menus.view/item/context`), `src/commands.ts`, and registered in `src/extension.ts`.

## Conflict Resolution (`src/commands.ts`)

`runMergeable(gitArgs, cwd, provider)` wraps any git op that can produce conflicts. On failure it checks `git diff --name-only --diff-filter=U`; if files exist, calls `showConflictResolution`.

`showConflictResolution` uses `createQuickPick()` (not `showQuickPick`) for programmatic show/hide:

- Selecting a file hides the picker and opens `git.openMergeEditor`. The command returns **immediately**, so the picker must be re-shown via `vscode.window.tabGroups.onDidChangeTabs` when the merge editor tab closes — not by awaiting the command.
- `.git/index` is watched via `FileSystemWatcher` to refresh the conflict list. `onDidSaveTextDocument` is **not** used — "Complete Merge" runs `git add` which updates the index but does not fire a document save event.
- When all conflicts are resolved, `promptIfAllResolved` hides the picker and shows a modal instead of an empty list.
- To complete a merge: `git commit --no-edit`. Do **not** use `git merge --continue --no-edit` — `--no-edit` is rejected by `--continue`.
- To complete a rebase: `git rebase --continue`.
- `suppressHide` prevents `onDidHide` from calling `finish()` during programmatic hides.
- `disposed` prevents a stale `mergeTabWatcher` from calling `qp.show()` after disposal.
- Merge editor tabs are identified by duck-typing the input (`"base" in inp && "input1" in inp && "result" in inp`) — `vscode.TabInputTextMerge` is absent from the installed `@types/vscode`.
- `getMergeState` reads the filesystem: `.git/MERGE_HEAD` → merge, `.git/rebase-merge` / `.git/rebase-apply` → rebase.

## Checkout with In-Progress Merge

`checkoutBranch` catches "resolve your current index first", detects merge/rebase state via `getMergeState`, and offers "Abort & Checkout".

## Edge Cases

- **Checkout remote → local exists**: tries `checkout -b … --track`, falls back to plain `checkout`.
- **Delete `-d` vs `-D`**: user chooses upfront; no second prompt on failure.
- **`git pull` on current branch**: runs plain `git pull`, relies on tracking branch config.
- **`git branch --format` pipe char**: passed via `execFile` (no shell), so `|` is literal.
- **Windows CRLF**: branch list output split by `/\r?\n/` throughout.
- **Protected branch detection for remotes**: strips the remote prefix before checking `PROTECTED_BRANCHES`.
- **File watcher covers `packed-refs`**: `git fetch --prune` rewrites `packed-refs`, not individual ref files.
