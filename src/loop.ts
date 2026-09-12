import * as fs from "node:fs";
import * as path from "node:path";
import type {
  Task,
  TaskRunResult,
  Proposal,
  IterationReport,
  WikiSkillConfig,
  WorkspaceState,
} from "./types.js";
import { setupTaskSandbox, generateBenchmarkTasks, saveTasks, loadTasks } from "./tasks.js";
import { gradeTask } from "./graders.js";
import { writeTrace, sampleTraces } from "./traces.js";
import { ensureWiki, appendLog, recordSkillImpact, commitWiki } from "./wiki.js";
import {
  ensureSkillsRepo,
  stageProposal,
  commitAcceptedSkill,
  rollbackSkills,
  listActiveSkills,
} from "./gating.js";
import { buildInferencePrompt, buildMaintainerPrompt, buildProposerPrompt } from "./prompts.js";
import { runPiAgent } from "./subagent-runner.js";
import { resolveModelString } from "./model-selector.js";

export function getWorkspaceStatePath(wsDir: string): string {
  return path.join(wsDir, "runs", "state.json");
}

export function loadWorkspaceState(wsDir: string): WorkspaceState {
  const statePath = getWorkspaceStatePath(wsDir);
  if (fs.existsSync(statePath)) {
    try {
      return JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch {
      // Return default
    }
  }
  return {
    domain: path.basename(wsDir),
    baselineScore: 0,
    bestScore: 0,
    currentIter: 0,
    activeSkills: [],
    rejectedSkills: [],
    history: [],
  };
}

export function saveWorkspaceState(wsDir: string, state: WorkspaceState): void {
  const runsDir = path.join(wsDir, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(getWorkspaceStatePath(wsDir), JSON.stringify(state, null, 2), "utf8");
}

export function initWorkspace(wsDir: string): { wsDir: string; tasksCount: number } {
  for (const sub of [
    "raw/traces",
    "wiki/patterns",
    "skills/active",
    "bench",
    "runs/proposals",
  ]) {
    fs.mkdirSync(path.join(wsDir, sub), { recursive: true });
  }

  ensureWiki(wsDir);
  ensureSkillsRepo(wsDir);

  const tasksFile = path.join(wsDir, "bench", "tasks.json");
  let tasks: Task[] = [];
  if (!fs.existsSync(tasksFile)) {
    tasks = generateBenchmarkTasks();
    saveTasks(wsDir, tasks);
  } else {
    tasks = loadTasks(wsDir);
  }

  const state = loadWorkspaceState(wsDir);
  saveWorkspaceState(wsDir, state);

  return { wsDir, tasksCount: tasks.length };
}

export function getActiveSkillPaths(wsDir: string): string[] {
  const activeDir = path.join(wsDir, "skills", "active");
  if (!fs.existsSync(activeDir)) return [];
  const entries = fs.readdirSync(activeDir);
  const paths: string[] = [];
  for (const entry of entries) {
    const full = path.join(activeDir, entry);
    if (fs.statSync(full).isDirectory()) {
      const skillFile = path.join(full, "SKILL.md");
      if (fs.existsSync(skillFile)) {
        paths.push(full);
      }
    }
  }
  return paths;
}

export async function executeTask(
  wsDir: string,
  task: Task,
  iter: number,
  model?: string,
  onStatus?: (msg: string) => void
): Promise<TaskRunResult> {
  const sandboxDir = path.join(wsDir, "bench", "tasks", task.id, "sandbox");
  setupTaskSandbox(task, sandboxDir);

  onStatus?.(`Spouštím task ${task.id} (${task.split}): ${task.title}...`);
  const prompt = buildInferencePrompt(task, sandboxDir);
  const activeSkills = getActiveSkillPaths(wsDir);

  const res = await runPiAgent(prompt, {
    workdir: sandboxDir,
    model,
    activeSkillPaths: activeSkills,
    timeoutMs: 90_000,
  });

  const graded = gradeTask(task, sandboxDir);
  const runResult: TaskRunResult = {
    id: task.id,
    split: task.split,
    score: graded.score,
    durationMs: res.durationMs,
    toolCalls: res.toolCalls,
    messageCount: res.messageCount,
    details: graded.details,
    error: res.exitCode !== 0 ? res.stderr : undefined,
  };

  writeTrace(wsDir, iter, runResult, res.events);
  return runResult;
}

export async function evaluateSplit(
  wsDir: string,
  tasks: Task[],
  split: "train" | "val",
  iter: number,
  model?: string,
  onProgress?: (idx: number, total: number, result: TaskRunResult) => void
): Promise<{ avgScore: number; results: TaskRunResult[] }> {
  const splitTasks = tasks.filter((t) => t.split === split);
  const results: TaskRunResult[] = [];

  for (let i = 0; i < splitTasks.length; i++) {
    const task = splitTasks[i];
    const res = await executeTask(wsDir, task, iter, model);
    results.push(res);
    onProgress?.(i + 1, splitTasks.length, res);
  }

  const totalScore = results.reduce((sum, r) => sum + r.score, 0);
  const avgScore = splitTasks.length > 0 ? totalScore / splitTasks.length : 0;
  return { avgScore, results };
}

export async function runEvolutionIteration(
  wsDir: string,
  iter: number,
  config: WikiSkillConfig,
  tasks: Task[],
  state: WorkspaceState,
  callbacks?: {
    onMessage?: (msg: string) => void;
    onProgress?: (info: string) => void;
  }
): Promise<IterationReport> {
  const startTime = Date.now();
  callbacks?.onMessage?.(`\n--- 🚀 Začátek iterace ${iter} ---`);

  // Step 1: Inference rollouts on train split
  callbacks?.onProgress?.(`Krok 1/4: Spouštím trénovací tasky (S_${iter - 1})...`);
  const trainEval = await evaluateSplit(
    wsDir,
    tasks,
    "train",
    iter,
    resolveModelString(config.inferenceModel)
  );
  callbacks?.onMessage?.(
    `Trénovací skóre: ${(trainEval.avgScore * 100).toFixed(1)}% (${trainEval.results.filter((r) => r.score >= 1.0).length}/${trainEval.results.length} splněno)`
  );

  // Step 2: Maintainer step
  callbacks?.onProgress?.(`Krok 2/4: Wiki Maintainer analyzuje stopy a aktualizuje wiki...`);
  const sampled = sampleTraces(wsDir, iter, trainEval.results);
  const maintainerPrompt = buildMaintainerPrompt(wsDir, iter, sampled);
  await runPiAgent(maintainerPrompt, {
    workdir: wsDir,
    model: resolveModelString(config.maintainerModel),
    timeoutMs: 120_000,
  });
  commitWiki(wsDir, `iter-${String(iter).padStart(2, "0")}: wiki maintenance updates`);

  // Step 3: Proposer step
  callbacks?.onProgress?.(`Krok 3/4: Skill Proposer navrhuje zlepšení skillů...`);
  const proposerPrompt = buildProposerPrompt(wsDir, iter, trainEval.results);
  const proposalFile = path.join(
    wsDir,
    "runs",
    "proposals",
    `iter-${String(iter).padStart(2, "0")}.json`
  );

  await runPiAgent(proposerPrompt, {
    workdir: wsDir,
    model: resolveModelString(config.proposerModel),
    timeoutMs: 120_000,
  });

  let proposal: Proposal = {
    type: "no_action",
    explanation: "Proposer did not write a proposal file.",
  };

  if (fs.existsSync(proposalFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(proposalFile, "utf8"));
      proposal = {
        type: parsed.action || "no_action",
        skillName: parsed.name,
        content: parsed.skill_md,
        explanation: parsed.explanation || "",
      };
    } catch {
      // Malformed proposal JSON
    }
  }

  callbacks?.onMessage?.(
    `Návrh skillu: ${proposal.type.toUpperCase()} ${proposal.skillName ? `\`${proposal.skillName}\`` : ""}`
  );

  // Step 4: Gating Step
  callbacks?.onProgress?.(`Krok 4/4: Validační brána a vyhodnocení (Gating)...`);
  let valScore = state.bestScore;
  let decision: "ACCEPTED" | "REJECTED" | "NO_ACTION" = "NO_ACTION";
  const bestBefore = state.bestScore;

  if (proposal.type === "no_action" || !proposal.skillName || !proposal.content) {
    decision = "NO_ACTION";
    appendLog(wsDir, iter, `Proposal: NO_ACTION. R_best remains ${(state.bestScore * 100).toFixed(1)}%.`);
  } else {
    // Stage proposal into skills/active/
    stageProposal(wsDir, proposal);

    // Evaluate validation tasks with candidate skill set S'
    const valEval = await evaluateSplit(
      wsDir,
      tasks,
      "val",
      iter,
      resolveModelString(config.inferenceModel)
    );
    valScore = valEval.avgScore;

    // Strict Gating: R_val > R_best
    if (valScore > state.bestScore) {
      decision = "ACCEPTED";
      commitAcceptedSkill(
        wsDir,
        iter,
        proposal,
        valScore,
        state.bestScore,
        config.exportToGlobalSkills
      );
      state.bestScore = valScore;
      state.activeSkills = listActiveSkills(wsDir);
      appendLog(
        wsDir,
        iter,
        `ACCEPTED proposal \`${proposal.skillName}\`: Val score ${(valScore * 100).toFixed(1)}% > ${(bestBefore * 100).toFixed(1)}%. Committed to active skills.`
      );
      recordSkillImpact(wsDir, iter, proposal, valScore, "ACCEPTED", proposal.explanation);
      callbacks?.onMessage?.(
        `✅ PŘIJATO: Skóre stouplo na ${(valScore * 100).toFixed(1)}% (předtím ${(bestBefore * 100).toFixed(1)}%). Skill uložen!`
      );
    } else {
      decision = "REJECTED";
      rollbackSkills(wsDir);
      if (!state.rejectedSkills.includes(proposal.skillName)) {
        state.rejectedSkills.push(proposal.skillName);
      }
      appendLog(
        wsDir,
        iter,
        `REJECTED proposal \`${proposal.skillName}\`: Val score ${(valScore * 100).toFixed(1)}% <= R_best ${(bestBefore * 100).toFixed(1)}%. Rolled back skills.`
      );
      recordSkillImpact(
        wsDir,
        iter,
        proposal,
        valScore,
        "REJECTED",
        `Score ${(valScore * 100).toFixed(1)}% did not beat R_best ${(bestBefore * 100).toFixed(1)}%`
      );
      callbacks?.onMessage?.(
        `❌ ODMÍTNUTO: Validační skóre ${(valScore * 100).toFixed(1)}% nepřekonalo R_best ${(bestBefore * 100).toFixed(1)}%. Skill vrácen zpět.`
      );
    }
  }

  const report: IterationReport = {
    iter,
    trainScore: trainEval.avgScore,
    valScore,
    bestScoreBefore: bestBefore,
    bestScoreAfter: state.bestScore,
    proposal,
    decision,
    durationMs: Date.now() - startTime,
    tracesSampled: sampled.length,
  };

  state.currentIter = iter;
  state.lastRunAt = new Date().toISOString();
  state.history.push(report);
  saveWorkspaceState(wsDir, state);

  return report;
}
