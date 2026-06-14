import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { BranchItem, GitBranchProvider } from "./gitBranchProvider";

const execFileAsync = promisify(execFile);

export function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export async function execGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
  });
  return stdout;
}

async function run(
  fn: (cwd: string) => Promise<void>,
  provider?: GitBranchProvider,
): Promise<void> {
  const cwd = getWorkspaceRoot();
  if (!cwd) {
    vscode.window.showErrorMessage("No workspace folder open.");
    return;
  }
  try {
    await fn(cwd);
    provider?.refresh();
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    vscode.window.showErrorMessage(
      (err.stderr ?? err.message ?? String(e)).trim(),
    );
  }
}

async function getConflictedFiles(cwd: string): Promise<string[]> {
  try {
    const out = await execGit(["diff", "--name-only", "--diff-filter=U"], cwd);
    return out.trim().split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function getMergeState(cwd: string): "merge" | "rebase" | null {
  const gitDir = path.join(cwd, ".git");
  if (fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) {
    return "merge";
  }
  if (fs.existsSync(path.join(gitDir, "rebase-merge"))) {
    return "rebase";
  }
  if (fs.existsSync(path.join(gitDir, "rebase-apply"))) {
    return "rebase";
  }
  return null;
}

async function showConflictResolution(
  cwd: string,
  provider: GitBranchProvider,
): Promise<void> {
  const qp = vscode.window.createQuickPick();
  qp.placeholder = "Select a file to open in the merge editor";
  qp.ignoreFocusOut = true;

  let filesCache: string[] = [];
  let mergeStateCache: "merge" | "rebase" | null = null;
  let suppressHide = false;
  let disposed = false;
  let mergeTabWatcher: vscode.Disposable | undefined;

  // Duck-type TabInputTextMerge (absent from installed @types/vscode).
  const isMergeTab = (t: vscode.Tab) => {
    const inp = t.input as Record<string, unknown> | null | undefined;
    return (
      inp !== null &&
      inp !== undefined &&
      "base" in inp &&
      "input1" in inp &&
      "result" in inp
    );
  };

  const refreshItems = async () => {
    filesCache = await getConflictedFiles(cwd);
    mergeStateCache = getMergeState(cwd);
    const op = mergeStateCache === "rebase" ? "Rebase" : "Merge";
    const n = filesCache.length;
    qp.title = `${op} Conflicts — ${n} file${n > 1 ? "s" : ""}`;
    qp.items = [
      ...filesCache.map((f) => ({
        label: `$(diff) ${path.basename(f)}`,
        description: path.dirname(f) !== "." ? path.dirname(f) : undefined,
        detail: f,
      })),
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: `$(pass) Continue ${op}` },
      { label: `$(circle-slash) Abort ${op}` },
    ];
  };

  await refreshItems();

  // "Complete Merge" runs git-add, which updates the index — not a document save.
  const indexWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      vscode.workspace.workspaceFolders![0],
      ".git/index",
    ),
  );

  return new Promise<void>((resolve) => {
    const finish = () => {
      disposed = true;
      mergeTabWatcher?.dispose();
      indexWatcher.dispose();
      qp.dispose();
      resolve();
    };

    // Runs the continue command. If the next rebase commit also has conflicts,
    // re-shows the picker instead of closing.
    const executeContinue = async (op: string) => {
      const continueArgs =
        op === "rebase"
          ? ["-c", "core.editor=true", "rebase", "--continue"]
          : ["commit", "--no-edit"];
      try {
        await execGit(continueArgs, cwd);
        provider.refresh();
        finish();
      } catch {
        const newConflicts = await getConflictedFiles(cwd);
        if (newConflicts.length > 0) {
          suppressHide = false;
          await refreshItems();
          qp.show();
          return;
        }
        if (!getMergeState(cwd)) {
          provider.refresh();
        }
        finish();
      }
    };

    const promptIfAllResolved = async () => {
      if (filesCache.length > 0 || suppressHide || disposed) {
        return;
      }
      const op = mergeStateCache === "rebase" ? "rebase" : "merge";
      const opLabel = op === "rebase" ? "Rebase" : "Merge";
      suppressHide = true;
      qp.hide();
      const choice = await vscode.window.showInformationMessage(
        `All conflicts resolved. Continue ${opLabel}?`,
        { modal: true },
        `Continue ${opLabel}`,
        "Abort",
      );
      // suppressHide stays true through executeContinue to block re-entry from index changes.
      if (choice === `Continue ${opLabel}`) {
        await executeContinue(op);
      } else if (choice === "Abort") {
        await execGit([op, "--abort"], cwd).catch(() => {});
        provider.refresh();
        finish();
      } else {
        suppressHide = false;
        await refreshItems();
        qp.show();
      }
    };

    indexWatcher.onDidChange(async () => {
      await refreshItems();
      await promptIfAllResolved();
    });

    qp.onDidHide(() => {
      if (!suppressHide) {
        finish();
      }
    });

    qp.onDidAccept(async () => {
      const pick = qp.activeItems[0];
      if (!pick) {
        return;
      }

      const op = mergeStateCache === "rebase" ? "rebase" : "merge";
      const opLabel = op === "rebase" ? "Rebase" : "Merge";

      if (pick.label === `$(pass) Continue ${opLabel}`) {
        const remaining = await getConflictedFiles(cwd);
        if (remaining.length > 0) {
          vscode.window.showWarningMessage(
            `${remaining.length} unresolved conflict${remaining.length > 1 ? "s" : ""} remaining.`,
          );
          return;
        }
        suppressHide = true;
        await executeContinue(op);
        return;
      }

      if (pick.label === `$(circle-slash) Abort ${opLabel}`) {
        suppressHide = true;
        qp.hide();
        const confirm = await vscode.window.showWarningMessage(
          `Abort ${op}?`,
          { modal: true },
          "Abort",
        );
        if (confirm === "Abort") {
          await execGit([op, "--abort"], cwd).catch(() => {});
          provider.refresh();
          suppressHide = false;
          finish();
        } else {
          suppressHide = false;
          await refreshItems();
          qp.show();
        }
        return;
      }

      if (pick.detail) {
        suppressHide = true;
        qp.hide();
        const uri = vscode.Uri.file(path.join(cwd, pick.detail));

        try {
          await vscode.commands.executeCommand("git.openMergeEditor", uri);
        } catch {
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc);
          suppressHide = false;
          await refreshItems();
          await promptIfAllResolved();
          if (!disposed) {
            qp.show();
          }
          return;
        }

        // git.openMergeEditor returns immediately; re-show only when the tab actually closes.
        mergeTabWatcher?.dispose();
        mergeTabWatcher = vscode.window.tabGroups.onDidChangeTabs(async (e) => {
          if (!e.closed.some(isMergeTab)) {
            return;
          }
          mergeTabWatcher?.dispose();
          mergeTabWatcher = undefined;
          if (disposed) {
            return;
          }
          suppressHide = false;
          await refreshItems();
          await promptIfAllResolved();
          if (!disposed) {
            qp.show();
          }
        });
      }
    });

    qp.show();
  });
}

async function runMergeable(
  gitArgs: string[],
  cwd: string,
  provider: GitBranchProvider,
): Promise<void> {
  try {
    await execGit(gitArgs, cwd);
    provider.refresh();
  } catch (e: unknown) {
    const conflicted = await getConflictedFiles(cwd);
    if (conflicted.length > 0) {
      provider.refresh();
      await showConflictResolution(cwd, provider);
    } else {
      const err = e as { stderr?: string; message?: string };
      vscode.window.showErrorMessage(
        (err.stderr ?? err.message ?? String(e)).trim(),
      );
    }
  }
}

export async function fetchAll(provider: GitBranchProvider): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: "Fetching all remotes…",
    },
    () =>
      run(
        (cwd) => execGit(["fetch", "--all", "--prune"], cwd).then(() => {}),
        provider,
      ),
  );
}

async function doCheckout(
  item: BranchItem,
  cwd: string,
  provider: GitBranchProvider,
): Promise<void> {
  if (item.isRemote) {
    const localName = item.branchName.split("/").slice(1).join("/");
    try {
      await execGit(
        ["checkout", "-b", localName, "--track", item.branchName],
        cwd,
      );
    } catch {
      await execGit(["checkout", localName], cwd);
    }
  } else {
    await execGit(["checkout", item.branchName], cwd);
  }
  provider.refresh();
}

export async function checkoutBranch(
  item: BranchItem,
  provider: GitBranchProvider,
): Promise<void> {
  const cwd = getWorkspaceRoot();
  if (!cwd) {
    vscode.window.showErrorMessage("No workspace folder open.");
    return;
  }
  try {
    await doCheckout(item, cwd, provider);
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    const msg = (err.stderr ?? err.message ?? String(e)).trim();
    const mergeState = getMergeState(cwd);
    if (mergeState && /resolve your current index/i.test(msg)) {
      const operationLabel = mergeState === "rebase" ? "rebase" : "merge";
      const choice = await vscode.window.showWarningMessage(
        `A ${operationLabel} is in progress with unresolved conflicts. Abort it and checkout '${item.branchName}'?`,
        { modal: true },
        "Abort & Checkout",
      );
      if (choice === "Abort & Checkout") {
        try {
          await execGit([mergeState, "--abort"], cwd);
          await doCheckout(item, cwd, provider);
        } catch (e2: unknown) {
          const err2 = e2 as { stderr?: string; message?: string };
          vscode.window.showErrorMessage(
            (err2.stderr ?? err2.message ?? String(e2)).trim(),
          );
        }
      }
    } else {
      vscode.window.showErrorMessage(msg);
    }
  }
}

export async function newBranchFrom(
  item: BranchItem,
  provider: GitBranchProvider,
): Promise<void> {
  const newName = await vscode.window.showInputBox({
    title: `New Branch from '${item.branchName}'`,
    prompt: "New branch name",
    validateInput: (v) => {
      if (!v) {
        return "Enter a branch name";
      }
      if (/[\s~^:?*\[\\]/.test(v)) {
        return "Invalid branch name";
      }
      return null;
    },
  });
  if (!newName) {
    return;
  }
  await run(
    (cwd) =>
      execGit(["checkout", "-b", newName, item.branchName], cwd).then(() => {}),
    provider,
  );
}

export async function pushBranch(
  item: BranchItem,
  provider: GitBranchProvider,
): Promise<void> {
  await run(
    (cwd) =>
      execGit(["push", "-u", "origin", item.branchName], cwd).then(() => {}),
    provider,
  );
}

export async function pullBranch(
  _item: BranchItem,
  provider: GitBranchProvider,
): Promise<void> {
  const cwd = getWorkspaceRoot();
  if (!cwd) {
    vscode.window.showErrorMessage("No workspace folder open.");
    return;
  }
  await runMergeable(["pull"], cwd, provider);
}

export async function pullIntoCurrentRebase(
  item: BranchItem,
  provider: GitBranchProvider,
): Promise<void> {
  const cwd = getWorkspaceRoot();
  if (!cwd) {
    vscode.window.showErrorMessage("No workspace folder open.");
    return;
  }
  const [remote, ...rest] = item.branchName.split("/");
  const branch = rest.join("/");
  await runMergeable(["pull", "--rebase", remote, branch], cwd, provider);
}

export async function pullIntoCurrentMerge(
  item: BranchItem,
  provider: GitBranchProvider,
): Promise<void> {
  const cwd = getWorkspaceRoot();
  if (!cwd) {
    vscode.window.showErrorMessage("No workspace folder open.");
    return;
  }
  const [remote, ...rest] = item.branchName.split("/");
  const branch = rest.join("/");
  await runMergeable(["pull", remote, branch], cwd, provider);
}

export async function renameBranch(
  item: BranchItem,
  provider: GitBranchProvider,
): Promise<void> {
  const newName = await vscode.window.showInputBox({
    title: "Rename Branch",
    prompt: "New branch name",
    value: item.branchName,
    validateInput: (v) => {
      if (!v || v === item.branchName) {
        return "Enter a different name";
      }
      if (/[\s~^:?*\[\\]/.test(v)) {
        return "Invalid branch name";
      }
      return null;
    },
  });
  if (!newName) {
    return;
  }
  await run(
    (cwd) =>
      execGit(["branch", "-m", item.branchName, newName], cwd).then(() => {}),
    provider,
  );
}

export async function deleteLocalBranch(
  item: BranchItem,
  provider: GitBranchProvider,
): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    `Delete local branch '${item.branchName}'?`,
    { modal: true },
    "Delete",
    "Force Delete",
  );
  if (!choice) {
    return;
  }
  const flag = choice === "Force Delete" ? "-D" : "-d";
  await run(
    (cwd) => execGit(["branch", flag, item.branchName], cwd).then(() => {}),
    provider,
  );
}

export async function deleteRemoteBranch(
  item: BranchItem,
  provider: GitBranchProvider,
): Promise<void> {
  const [remote, ...rest] = item.branchName.split("/");
  const branch = rest.join("/");
  const confirm = await vscode.window.showWarningMessage(
    `Delete remote branch '${item.branchName}'?`,
    { modal: true },
    "Delete",
  );
  if (confirm !== "Delete") {
    return;
  }
  await run(
    (cwd) => execGit(["push", remote, "--delete", branch], cwd).then(() => {}),
    provider,
  );
}
