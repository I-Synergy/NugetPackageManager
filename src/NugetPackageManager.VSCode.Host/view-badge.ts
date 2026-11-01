import * as vscode from "vscode";

let badgeView: vscode.TreeView<unknown> | undefined;

export function RegisterBadgeView(view: vscode.TreeView<unknown>): void {
  badgeView = view;
}

export function ClearBadgeView(view: vscode.TreeView<unknown>): void {
  if (badgeView === view) badgeView = undefined;
}

function BuildBadgeTooltip(count: number, blockedCount: number): string {
  const updates = `${count} update${count === 1 ? "" : "s"} available`;
  if (blockedCount <= 0) return updates;
  const conflicts = blockedCount === 1
    ? "1 blocked by a dependency conflict"
    : `${blockedCount} blocked by dependency conflicts`;
  return `${updates} · ${conflicts}`;
}

export function SetUpdateBadge(count: number, blockedCount = 0): void {
  if (!badgeView) return;
  const value = Math.max(0, Math.floor(count));
  badgeView.badge = value > 0
    ? { value, tooltip: BuildBadgeTooltip(value, Math.max(0, Math.floor(blockedCount))) }
    : undefined;
}
