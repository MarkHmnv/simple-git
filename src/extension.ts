import * as vscode from "vscode";
import { GitBranchProvider } from "./gitBranchProvider";
import * as cmds from "./commands";

// Colors the label text of branches that have ahead/behind commits.
// FileDecoration.color is the only VSCode API that can tint tree-item label text.
class SyncDecorationProvider implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== "gitbm") {
      return;
    }
    const p = new URLSearchParams(uri.query);
    const ahead = parseInt(p.get("a") ?? "0", 10);
    const behind = parseInt(p.get("b") ?? "0", 10);
    if (ahead === 0 && behind === 0) {
      return;
    }

    const color =
      ahead > 0 && behind > 0
        ? new vscode.ThemeColor("gitDecoration.modifiedResourceForeground")
        : ahead > 0
          ? new vscode.ThemeColor("gitDecoration.addedResourceForeground")
          : new vscode.ThemeColor("gitDecoration.submoduleResourceForeground");

    return { color };
  }
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new GitBranchProvider();

  const treeView = vscode.window.createTreeView("simple-git.branchView", {
    treeDataProvider: provider,
    showCollapseAll: false,
  });

  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(new SyncDecorationProvider()),
  );

  // Watch .git internals only when a workspace folder is present.
  // packed-refs is included because git fetch --prune rewrites it instead of individual ref files.
  let watcher: vscode.FileSystemWatcher | undefined;

  function setupWatcher() {
    watcher?.dispose();
    watcher = undefined;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }
    watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, ".git/{HEAD,refs/**/*,packed-refs}"),
    );
    watcher.onDidChange(() => provider.refresh());
    watcher.onDidCreate(() => provider.refresh());
    watcher.onDidDelete(() => provider.refresh());
    context.subscriptions.push(watcher);
  }

  setupWatcher();
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      setupWatcher();
      provider.refresh();
    }),
  );

  const reg = (cmd: string, fn: (...args: unknown[]) => unknown) =>
    vscode.commands.registerCommand(cmd, fn);

  context.subscriptions.push(
    treeView,
    reg("simple-git.refresh", () => provider.refresh()),
    reg("simple-git.fetch", () => cmds.fetchAll(provider)),
    reg("simple-git.newBranchFrom", (item) =>
      cmds.newBranchFrom(item as never, provider),
    ),
    reg("simple-git.checkout", (item) =>
      cmds.checkoutBranch(item as never, provider),
    ),
    reg("simple-git.push", (item) => cmds.pushBranch(item as never, provider)),
    reg("simple-git.pull", (item) => cmds.pullBranch(item as never, provider)),
    reg("simple-git.pullRebase", (item) =>
      cmds.pullIntoCurrentRebase(item as never, provider),
    ),
    reg("simple-git.pullMerge", (item) =>
      cmds.pullIntoCurrentMerge(item as never, provider),
    ),
    reg("simple-git.rename", (item) =>
      cmds.renameBranch(item as never, provider),
    ),
    reg("simple-git.deleteLocal", (item) =>
      cmds.deleteLocalBranch(item as never, provider),
    ),
    reg("simple-git.deleteRemote", (item) =>
      cmds.deleteRemoteBranch(item as never, provider),
    ),
  );
}

export function deactivate() {}
