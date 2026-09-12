import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WikiSkillConfig } from "./types.js";

export const DEFAULT_CONFIG: WikiSkillConfig = {
  inferenceModel: "current",
  maintainerModel: "current",
  proposerModel: "current",
  workspacesDir: "workspaces",
  activeWorkspace: "demo",
  defaultIters: 3,
  maxTurns: 15,
  exportToGlobalSkills: true,
  statusline: true,
};

export function resolveWorkspaceDir(config: WikiSkillConfig, cwd: string, overrideDomain?: string): string {
  const domain = overrideDomain || config.activeWorkspace || "demo";
  return path.join(cwd, config.workspacesDir || "workspaces", domain);
}

export function getAgentDir(): string {
  return (
    process.env.PI_CODING_AGENT_DIR ||
    path.join(os.homedir(), ".pi", "agent")
  );
}

export function getConfigPath(): string {
  return path.join(getAgentDir(), "wikiskill-config.json");
}

export function loadConfig(projectRoot?: string): WikiSkillConfig {
  let config = { ...DEFAULT_CONFIG };

  // 1. Global config
  const globalPath = getConfigPath();
  if (fs.existsSync(globalPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(globalPath, "utf8"));
      config = { ...config, ...parsed };
    } catch {
      // Ignore corrupt global config
    }
  }

  // 2. Project local config (.pi/wikiskill.json)
  const root = projectRoot || process.cwd();
  const localPath = path.join(root, ".pi", "wikiskill.json");
  if (fs.existsSync(localPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(localPath, "utf8"));
      config = { ...config, ...parsed };
    } catch {
      // Ignore corrupt local config
    }
  }

  return config;
}

export function saveConfig(cfg: Partial<WikiSkillConfig>, isLocal = false, projectRoot?: string): void {
  const root = projectRoot || process.cwd();
  const filePath = isLocal
    ? path.join(root, ".pi", "wikiskill.json")
    : getConfigPath();

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(filePath)) {
    try {
      existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      // Overwrite
    }
  }

  const merged = { ...existing, ...cfg };
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf8");
}
