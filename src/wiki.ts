import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { Proposal } from "./types.js";

export function ensureWiki(wsDir: string): void {
  const wikiDir = path.join(wsDir, "wiki");
  const patternsDir = path.join(wikiDir, "patterns");
  fs.mkdirSync(patternsDir, { recursive: true });

  const indexPath = path.join(wikiDir, "index.md");
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(
      indexPath,
      `# Persistent Knowledge Wiki\n\nThis wiki distills agent experiences across benchmarking iterations. It is never rolled back.\n\n## Discovered Patterns\n\n(No patterns distilled yet)\n`,
      "utf8"
    );
  }

  const logPath = path.join(wikiDir, "log.md");
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(
      logPath,
      `# WikiSkill Evolution Log\n\nAudit trail of maintenance, proposals, and gating verdicts.\n\n`,
      "utf8"
    );
  }

  const impactPath = path.join(wikiDir, "skill-impact.md");
  if (!fs.existsSync(impactPath)) {
    fs.writeFileSync(
      impactPath,
      `# Skill Impact & Rejections\n\nRecords of all proposed skills and their empirical validation outcomes.\n\n| Iter | Skill | Proposal Type | Validation Score | Outcome | Reason |\n|---|---|---|---|---|---|\n`,
      "utf8"
    );
  }

  // Ensure git repo in workspace root or wiki dir
  const gitDir = path.join(wsDir, ".git");
  if (!fs.existsSync(gitDir)) {
    try {
      execSync("git init -q", { cwd: wsDir, stdio: "ignore" });
      execSync("git add wiki", { cwd: wsDir, stdio: "ignore" });
      execSync(
        "git -c user.email=wikiskill@local -c user.name=wikiskill commit -q -m 'chore: initialize persistent wiki layer'",
        {
          cwd: wsDir,
          stdio: "ignore",
        }
      );
    } catch {
      // Git commit non-fatal
    }
  }
}

export function appendLog(wsDir: string, iter: number, message: string): void {
  const logPath = path.join(wsDir, "wiki", "log.md");
  const entry = `\n### [Iter ${String(iter).padStart(2, "0")}] ${new Date().toISOString()}\n\n${message}\n`;
  fs.appendFileSync(logPath, entry, "utf8");
}

export function recordSkillImpact(
  wsDir: string,
  iter: number,
  proposal: Proposal,
  valScore: number,
  outcome: "ACCEPTED" | "REJECTED" | "NO_ACTION",
  reason: string
): void {
  const impactPath = path.join(wsDir, "wiki", "skill-impact.md");
  const skillName = proposal.skillName || "-";
  const row = `| ${iter} | \`${skillName}\` | ${proposal.type} | ${(valScore * 100).toFixed(1)}% | **${outcome}** | ${reason.replace(/\|/g, "/")} |\n`;
  fs.appendFileSync(impactPath, row, "utf8");
}

export function listWikiPatterns(wsDir: string): string[] {
  const patternsDir = path.join(wsDir, "wiki", "patterns");
  if (!fs.existsSync(patternsDir)) return [];
  return fs
    .readdirSync(patternsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.basename(f, ".md"));
}

export function commitWiki(wsDir: string, message: string): void {
  try {
    execSync("git add wiki", { cwd: wsDir, stdio: "ignore" });
    execSync(
      `git -c user.email=wikiskill@local -c user.name=wikiskill commit -m ${JSON.stringify(message)}`,
      {
        cwd: wsDir,
        stdio: "ignore",
      }
    );
  } catch {
    // If nothing to commit, ignore
  }
}
