export type Split = "train" | "val";

export type GraderSpec =
  | { type: "exact"; file: string; expected: string }
  | { type: "contains"; file: string; needle: string }
  | { type: "json_field"; file: string; path: string[]; expected: unknown }
  | { type: "code_stdout"; script: string; expected: string; runner?: string };

export interface Task {
  id: string;
  split: Split;
  title: string;
  prompt: string;
  sandbox: Record<string, string>;
  grader: GraderSpec;
}

export interface TaskRunResult {
  id: string;
  split: Split;
  score: number;
  durationMs: number;
  toolCalls: number;
  messageCount: number;
  error?: string;
  details?: string;
}

export interface Proposal {
  type: "create" | "patch" | "no_action";
  skillName?: string;
  content?: string;
  explanation: string;
  rawText?: string;
}

export interface IterationReport {
  iter: number;
  trainScore: number;
  valScore: number;
  bestScoreBefore: number;
  bestScoreAfter: number;
  proposal: Proposal;
  decision: "ACCEPTED" | "REJECTED" | "NO_ACTION";
  durationMs: number;
  tracesSampled: number;
}

export interface WikiSkillConfig {
  inferenceModel: string;
  maintainerModel: string;
  proposerModel: string;
  workspacesDir: string;
  activeWorkspace: string;
  defaultIters: number;
  maxTurns: number;
  exportToGlobalSkills: boolean;
}

export interface WorkspaceState {
  domain: string;
  baselineScore: number;
  bestScore: number;
  currentIter: number;
  activeSkills: string[];
  rejectedSkills: string[];
  lastRunAt?: string;
  history: IterationReport[];
}
