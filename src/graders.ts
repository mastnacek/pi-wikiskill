import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { GraderSpec, Task } from "./types.js";

export function normalizeText(s: unknown): string {
  if (s === null || s === undefined) return "";
  return String(s).replace(/\s+/g, " ").trim();
}

export function readSandboxFile(sandboxDir: string, relPath: string): string {
  const fullPath = path.isAbsolute(relPath) ? relPath : path.join(sandboxDir, relPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Deliverable file '${relPath}' not found in sandbox`);
  }
  return fs.readFileSync(fullPath, "utf8");
}

export function gradeTask(task: Task, sandboxDir: string): { score: number; details?: string } {
  const grader: GraderSpec = task.grader;
  try {
    switch (grader.type) {
      case "exact": {
        const got = readSandboxFile(sandboxDir, grader.file);
        const match = normalizeText(got) === normalizeText(grader.expected);
        return {
          score: match ? 1.0 : 0.0,
          details: match ? "Deliverable matches expected content exactly." : "Deliverable content does not match expected output.",
        };
      }

      case "contains": {
        const got = readSandboxFile(sandboxDir, grader.file);
        const match = got.includes(grader.needle);
        return {
          score: match ? 1.0 : 0.0,
          details: match ? `Deliverable contains substring: '${grader.needle}'` : `Substring '${grader.needle}' not found in deliverable.`,
        };
      }

      case "json_field": {
        const got = readSandboxFile(sandboxDir, grader.file);
        const parsed = JSON.parse(got);
        let curr: any = parsed;
        for (const seg of grader.path) {
          if (curr === undefined || curr === null) {
            return { score: 0.0, details: `JSON path '${grader.path.join(".")}' not found` };
          }
          curr = curr[seg];
        }
        const match = JSON.stringify(curr) === JSON.stringify(grader.expected) || normalizeText(curr) === normalizeText(grader.expected);
        return {
          score: match ? 1.0 : 0.0,
          details: match ? "JSON field matches expected value." : `JSON field value mismatch: got ${JSON.stringify(curr)}, expected ${JSON.stringify(grader.expected)}`,
        };
      }

      case "code_stdout": {
        const scriptPath = path.isAbsolute(grader.script) ? grader.script : path.join(sandboxDir, grader.script);
        if (!fs.existsSync(scriptPath)) {
          return { score: 0.0, details: `Script '${grader.script}' not found in sandbox` };
        }
        const runner = grader.runner || (grader.script.endsWith(".js") || grader.script.endsWith(".mjs") ? "node" : grader.script.endsWith(".py") ? "python3" : "bash");
        const stdout = execSync(`${runner} ${path.basename(scriptPath)}`, {
          cwd: sandboxDir,
          encoding: "utf8",
          timeout: 15_000,
        });
        const match = normalizeText(stdout) === normalizeText(grader.expected);
        return {
          score: match ? 1.0 : 0.0,
          details: match ? "Script stdout matches expected output." : `Script stdout mismatch: got '${stdout.trim()}', expected '${grader.expected}'`,
        };
      }

      default:
        return { score: 0.0, details: "Unknown grader type" };
    }
  } catch (err: any) {
    return {
      score: 0.0,
      details: `Grader error: ${err?.message || String(err)}`,
    };
  }
}
