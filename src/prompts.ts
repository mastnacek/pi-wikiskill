import * as path from "node:path";
import type { Task, TaskRunResult } from "./types.js";

export function buildInferencePrompt(task: Task, sandboxDir: string): string {
  return (
    `You are an agent completing a task in a sandbox directory. Follow the instructions precisely. ` +
    `Use your tools to inspect files and verify your work before finishing. Write every deliverable file exactly as specified. ` +
    `Your final message should briefly state what you did.\n\n` +
    `TASK: ${task.title}\n\n${task.prompt}\n\n` +
    `WORKING DIRECTORY: ${sandboxDir}\n` +
    `Read input files from and write ALL deliverables into the WORKING DIRECTORY above. ` +
    `Use absolute paths or ensure you are working strictly inside this directory. ` +
    `Do not explore or modify anything outside the WORKING DIRECTORY. ` +
    `Verify the final deliverable file exists and is populated before completing.`
  );
}

export function buildMaintainerPrompt(
  wsDir: string,
  iter: number,
  sampledTraces: Array<{ taskId: string; score: number; path: string }>
): string {
  const wikiDir = path.join(wsDir, "wiki");
  const manifest = sampledTraces
    .map((t) => `- Task: ${t.taskId} (score: ${t.score}) -> Trace: ${t.path}`)
    .join("\n");

  return (
    `You are the Wiki Maintainer in a WikiSkill evolution loop (iteration ${iter}).\n\n` +
    `Load the \`wikiskill-maintainer\` skill and follow it exactly.\n\n` +
    `WORKSPACE: ${wsDir}\n` +
    `- Wiki directory (read + edit): ${wikiDir}/ (index.md, log.md, skill-impact.md, patterns/)\n` +
    `- Raw traces to analyze this iteration (read only, immutable):\n\n${manifest}\n\n` +
    `Procedure:\n` +
    `1. Read the trace JSONL files above (focus on low-scoring traces for root causes; also inspect successful ones).\n` +
    `2. Perform deep trace analysis: identify failure patterns, misleading assumptions, or missing skills.\n` +
    `3. Update the wiki: create/update pattern files under wiki/patterns/<pattern-name>.md.\n` +
    `4. Update wiki/index.md with links and 1-2 sentence problem + fix summaries.\n` +
    `5. Append your maintenance summary to wiki/log.md.\n` +
    `Keep pattern pages concise (10-30 lines) and actionable.`
  );
}

export function buildProposerPrompt(
  wsDir: string,
  iter: number,
  trainResults: TaskRunResult[]
): string {
  const wikiDir = path.join(wsDir, "wiki");
  const table = trainResults
    .map((r) => `- ${r.id} [${r.split}] score=${r.score}`)
    .join("\n");
  const proposalPath = path.join(
    wsDir,
    "runs",
    "proposals",
    `iter-${String(iter).padStart(2, "0")}.json`
  );

  return (
    `You are the Skill Proposer in a WikiSkill evolution loop (iteration ${iter}).\n\n` +
    `Load the \`wikiskill-proposer\` skill and follow it exactly.\n\n` +
    `WORKSPACE: ${wsDir}\n` +
    `- Wiki directory: ${wikiDir}/ (index.md, skill-impact.md, patterns/, log.md)\n` +
    `- Active skills: ${path.join(wsDir, "skills", "active")}/\n\n` +
    `Training rollout summary this iteration:\n${table}\n\n` +
    `Rules:\n` +
    `1. Read wiki/index.md and wiki/skill-impact.md (do NOT repeat rejected approaches).\n` +
    `2. Read relevant pattern pages and diagnose root causes from failed training traces.\n` +
    `3. Decide: create a new skill, patch an existing skill, or no_action.\n` +
    `4. Write your proposal JSON directly to: ${proposalPath}\n\n` +
    `Proposal JSON Schema:\n` +
    `{\n` +
    `  "action": "create",\n` +
    `  "name": "snake_case_skill_name",\n` +
    `  "skill_md": "Full SKILL.md with frontmatter (name, description) + instructions",\n` +
    `  "explanation": "Why this skill is needed based on traces and wiki patterns"\n` +
    `}\n` +
    `OR\n` +
    `{\n` +
    `  "action": "patch",\n` +
    `  "name": "existing_skill_name",\n` +
    `  "skill_md": "Updated complete SKILL.md",\n` +
    `  "explanation": "What was improved"\n` +
    `}\n` +
    `OR\n` +
    `{\n` +
    `  "action": "no_action",\n` +
    `  "explanation": "Why no skill change is warranted at this time"\n` +
    `}\n`
  );
}
