import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { Proposal } from "./types.js";
import { getAgentDir } from "./config.js";

export function ensureSkillsRepo(wsDir: string): void {
  const activeDir = path.join(wsDir, "skills", "active");
  fs.mkdirSync(activeDir, { recursive: true });

  const gitDir = path.join(activeDir, ".git");
  if (!fs.existsSync(gitDir)) {
    try {
      execSync("git init -q", { cwd: activeDir, stdio: "ignore" });
      const readme = path.join(activeDir, ".gitkeep");
      if (!fs.existsSync(readme)) {
        fs.writeFileSync(readme, "", "utf8");
      }
      execSync("git add .gitkeep", { cwd: activeDir, stdio: "ignore" });
      execSync(
        "git -c user.email=wikiskill@local -c user.name=wikiskill commit -q -m 'chore: baseline active skill set (S0 = empty)'",
        {
          cwd: activeDir,
          stdio: "ignore",
        }
      );
    } catch {
      // Non-fatal
    }
  }
}

export function stageProposal(wsDir: string, proposal: Proposal): string | null {
  if (proposal.type === "no_action" || !proposal.skillName || !proposal.content) {
    return null;
  }

  const activeDir = path.join(wsDir, "skills", "active");
  const skillDir = path.join(activeDir, proposal.skillName);
  fs.mkdirSync(skillDir, { recursive: true });

  const skillFile = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillFile, proposal.content, "utf8");
  return skillFile;
}

export function commitAcceptedSkill(
  wsDir: string,
  iter: number,
  proposal: Proposal,
  valScore: number,
  rBest: number,
  exportToGlobal = true
): void {
  const activeDir = path.join(wsDir, "skills", "active");
  try {
    execSync("git add -A", { cwd: activeDir, stdio: "ignore" });
    const msg = `iter-${String(iter).padStart(2, "0")}: ACCEPT ${proposal.skillName} (R_val=${(valScore * 100).toFixed(1)}% > R_best=${(rBest * 100).toFixed(1)}%)`;
    execSync(
      `git -c user.email=wikiskill@local -c user.name=wikiskill commit -m ${JSON.stringify(msg)}`,
      {
        cwd: activeDir,
        stdio: "ignore",
      }
    );

    if (exportToGlobal && proposal.skillName) {
      exportSkillToGlobal(activeDir, proposal.skillName);
    }
  } catch (err: any) {
    console.error("Failed to git commit accepted skill:", err?.message || err);
  }
}

export function rollbackSkills(wsDir: string): void {
  const activeDir = path.join(wsDir, "skills", "active");
  try {
    execSync("git reset --hard HEAD", { cwd: activeDir, stdio: "ignore" });
    execSync("git clean -fd", { cwd: activeDir, stdio: "ignore" });
  } catch (err: any) {
    console.error("Failed to rollback skills:", err?.message || err);
  }
}

export function exportSkillToGlobal(activeDir: string, skillName: string): void {
  try {
    const globalSkillsDir = path.join(getAgentDir(), "skills", skillName);
    const sourceDir = path.join(activeDir, skillName);
    if (fs.existsSync(sourceDir)) {
      fs.mkdirSync(globalSkillsDir, { recursive: true });
      const sourceFile = path.join(sourceDir, "SKILL.md");
      const targetFile = path.join(globalSkillsDir, "SKILL.md");
      if (fs.existsSync(sourceFile)) {
        fs.copyFileSync(sourceFile, targetFile);
      }
    }
  } catch (err: any) {
    console.error("Failed to export skill to global Pi skills:", err?.message || err);
  }
}

export function listActiveSkills(wsDir: string): string[] {
  const activeDir = path.join(wsDir, "skills", "active");
  if (!fs.existsSync(activeDir)) return [];
  return fs
    .readdirSync(activeDir)
    .filter((f) => !f.startsWith(".") && fs.statSync(path.join(activeDir, f)).isDirectory());
}
