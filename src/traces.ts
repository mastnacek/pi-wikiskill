import * as fs from "node:fs";
import * as path from "node:path";
import type { TaskRunResult } from "./types.js";

export function getTracePath(
  wsDir: string,
  iter: number,
  split: string,
  taskId: string
): string {
  const iterStr = `iter-${String(iter).padStart(2, "0")}`;
  return path.join(wsDir, "raw", "traces", iterStr, split, `${taskId}.jsonl`);
}

export function writeTrace(
  wsDir: string,
  iter: number,
  result: TaskRunResult,
  events: any[]
): string {
  const tracePath = getTracePath(wsDir, iter, result.split, result.id);
  const dir = path.dirname(tracePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const header = {
    backend: "pi",
    task_id: result.id,
    split: result.split,
    score: result.score,
    tool_call_count: result.toolCalls,
    message_count: result.messageCount,
    duration_ms: result.durationMs,
    error: result.error,
  };

  const lines = [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))];
  fs.writeFileSync(tracePath, lines.join("\n") + "\n", "utf8");
  return tracePath;
}

export function sampleTraces(
  wsDir: string,
  iter: number,
  results: TaskRunResult[],
  maxFail = 5,
  maxPass = 3
): Array<{ taskId: string; score: number; path: string }> {
  const fails = results.filter((r) => r.score < 1.0);
  const passes = results.filter((r) => r.score >= 1.0);

  const pickedFails = fails.slice(0, maxFail);
  const pickedPasses = passes.slice(0, maxPass);
  const picked = [...pickedFails, ...pickedPasses];

  return picked.map((r) => ({
    taskId: r.id,
    score: r.score,
    path: getTracePath(wsDir, iter, r.split, r.id),
  }));
}
