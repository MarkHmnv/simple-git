import * as vscode from "vscode";
import { execGit, getWorkspaceRoot } from "./commands";

const PROTECTED_BRANCHES = new Set(["main", "master", "develop"]);

function isProtected(branchName: string, isRemote: boolean): boolean {
  const short = isRemote
    ? branchName.split("/").slice(1).join("/")
    : branchName;
  return PROTECTED_BRANCHES.has(short);
}

/** Returns the ThemeColor for a branch icon based on ahead/behind state. */
function syncColor(
  ahead: number,
  behind: number,
): vscode.ThemeColor | undefined {
  if (ahead > 0 && behind > 0) {
    return new vscode.ThemeColor("charts.yellow");
  }
  if (ahead > 0) {
    return new vscode.ThemeColor("charts.green");
  }
  if (behind > 0) {
    return new vscode.ThemeColor("charts.blue");
  }
  return undefined;
}

export class BranchGroup extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly groupType: "local" | "remote",
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "gitbm-group";
    this.iconPath = new vscode.ThemeIcon(
      groupType === "local" ? "device-desktop" : "cloud",
    );
  }
}

export class BranchItem extends vscode.TreeItem {
  constructor(
    public readonly branchName: string,
    public readonly isRemote: boolean,
    public readonly isCurrent: boolean,
    public readonly ahead = 0,
    public readonly behind = 0,
  ) {
    super(branchName, vscode.TreeItemCollapsibleState.None);

    const protected_ = isProtected(branchName, isRemote);

    if (isRemote) {
      this.contextValue = protected_
        ? "gitbm-remote-protected"
        : "gitbm-remote-regular";
      this.iconPath = new vscode.ThemeIcon("git-branch");
    } else {
      this.contextValue = isCurrent
        ? protected_
          ? "gitbm-local-protected-current"
          : "gitbm-local-current"
        : protected_
          ? "gitbm-local-protected"
          : "gitbm-local-regular";

      // Sync arrows in description (count display)
      const syncParts: string[] = [];
      if (ahead > 0) {
        syncParts.push(`↑${ahead}`);
      }
      if (behind > 0) {
        syncParts.push(`↓${behind}`);
      }
      const syncText = syncParts.join("  ");
      this.description =
        [isCurrent ? "current" : "", syncText].filter(Boolean).join("   ") ||
        undefined;

      // ThemeIcon color for the branch icon
      const iconName = isCurrent ? "check" : "git-branch";
      const color = syncColor(ahead, behind);
      this.iconPath = color
        ? new vscode.ThemeIcon(iconName, color)
        : new vscode.ThemeIcon(iconName);

      // FileDecorationProvider needs a resourceUri to apply label text color.
      // Scheme "gitbm" is handled exclusively by SyncDecorationProvider in extension.ts.
      if (ahead > 0 || behind > 0) {
        this.resourceUri = vscode.Uri.parse(
          `gitbm://sync/${encodeURIComponent(branchName)}?a=${ahead}&b=${behind}`,
        );
      }
    }

    this.tooltip = `${isRemote ? "Remote" : "Local"}: ${branchName}`;
  }
}

export class GitBranchProvider implements vscode.TreeDataProvider<
  BranchGroup | BranchItem
> {
  private readonly _onChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onChange.event;

  refresh(): void {
    this._onChange.fire();
  }

  getTreeItem(el: BranchGroup | BranchItem): vscode.TreeItem {
    return el;
  }

  async getChildren(
    el?: BranchGroup | BranchItem,
  ): Promise<(BranchGroup | BranchItem)[]> {
    const root = getWorkspaceRoot();
    if (!root) {
      return [];
    }

    if (!el) {
      return [
        new BranchGroup("Local", "local"),
        new BranchGroup("Remote", "remote"),
      ];
    }
    if (el instanceof BranchItem) {
      return [];
    }

    try {
      return el.groupType === "local"
        ? await getLocalBranches(root)
        : await getRemoteBranches(root);
    } catch {
      return [];
    }
  }
}

async function getLocalBranches(cwd: string): Promise<BranchItem[]> {
  // %(upstream:track) emits "[ahead N]", "[behind N]", "[ahead N, behind M]", or ""
  const out = await execGit(
    ["branch", "--format=%(refname:short)|%(HEAD)|%(upstream:track)"],
    cwd,
  );
  return out
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, head, track = ""] = line.split("|");
      const ahead = parseInt(track.match(/ahead (\d+)/)?.[1] ?? "0", 10);
      const behind = parseInt(track.match(/behind (\d+)/)?.[1] ?? "0", 10);
      return new BranchItem(
        name.trim(),
        false,
        head?.trim() === "*",
        ahead,
        behind,
      );
    });
}

async function getRemoteBranches(cwd: string): Promise<BranchItem[]> {
  const out = await execGit(["branch", "-r", "--format=%(refname:short)"], cwd);
  return out
    .trim()
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      // Skip empty lines, symref arrows (origin/HEAD -> origin/main),
      // HEAD entries (origin/HEAD), and bare remote names without a branch part.
      return t && !t.includes("->") && !t.endsWith("HEAD") && t.includes("/");
    })
    .map((line) => new BranchItem(line.trim(), true, false));
}
