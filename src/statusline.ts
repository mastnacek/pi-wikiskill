import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkspaceState } from "./types.js";
import { loadConfig, resolveWorkspaceDir } from "./config.js";
import { loadWorkspaceState } from "./loop.js";
import { listWikiPatterns } from "./wiki.js";

export function hasWorkspace(wsDir: string): boolean {
  if (!fs.existsSync(wsDir)) return false;
  const statePath = path.join(wsDir, "runs", "state.json");
  const tasksPath = path.join(wsDir, "bench", "tasks.json");
  const wikiPath = path.join(wsDir, "wiki", "index.md");
  return fs.existsSync(statePath) || fs.existsSync(tasksPath) || fs.existsSync(wikiPath);
}

export function formatStatus(
  state: WorkspaceState,
  patternsCount: number,
  customMessage?: string,
  theme?: { fg: (color: string, text: string) => string; bold?: (text: string) => string }
): string {
  const domain = state.domain || "demo";

  if (customMessage) {
    if (theme) {
      return `${theme.fg("accent", `wiki:${domain}`)} ${theme.fg("warning", customMessage)}`;
    }
    return `wiki:${domain} ${customMessage}`;
  }

  const scorePct = Math.round((state.bestScore ?? 0) * 100);
  const skillsCount = state.activeSkills?.length ?? 0;

  if (theme) {
    const label = theme.fg("accent", `wiki:${domain}`);
    const scoreColor = scorePct >= 100 ? "success" : "dim";
    const score = theme.fg(scoreColor, ` R:${scorePct}%`);
    const details = theme.fg("muted", ` (${skillsCount}s/${patternsCount}p)`);
    return `${label}${score}${details}`;
  }

  return `wiki:${domain} R:${scorePct}% (${skillsCount}s/${patternsCount}p)`;
}

export function updateWikiSkillStatus(
  ctx: { ui?: { setStatus?: (key: string, text?: string) => void; theme?: any }; cwd?: string } | undefined,
  customMessage?: string
): void {
  if (!ctx || !ctx.ui || typeof ctx.ui.setStatus !== "function") return;

  const config = loadConfig(ctx.cwd);
  if (config.statusline === false) {
    ctx.ui.setStatus("wikiskill", undefined);
    return;
  }

  const wsDir = resolveWorkspaceDir(config, ctx.cwd || process.cwd());
  if (!hasWorkspace(wsDir)) {
    ctx.ui.setStatus("wikiskill", undefined);
    return;
  }

  const state = loadWorkspaceState(wsDir);
  const patterns = listWikiPatterns(wsDir);
  const text = formatStatus(state, patterns.length, customMessage, ctx.ui.theme);
  ctx.ui.setStatus("wikiskill", text);
}

export function clearWikiSkillStatus(
  ctx: { ui?: { setStatus?: (key: string, text?: string) => void } } | undefined
): void {
  if (ctx?.ui?.setStatus) {
    ctx.ui.setStatus("wikiskill", undefined);
  }
}
