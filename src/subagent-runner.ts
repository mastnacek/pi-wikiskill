import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

export interface AgentRunOptions {
  workdir: string;
  sessionDir?: string;
  model?: string;
  provider?: string;
  tools?: string;
  skillsDir?: string;
  activeSkillPaths?: string[];
  maxTurns?: number;
  timeoutMs?: number;
  onEvent?: (event: any) => void;
}

export interface AgentRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  events: any[];
  toolCalls: number;
  messageCount: number;
  durationMs: number;
}

export async function runPiAgent(
  prompt: string,
  options: AgentRunOptions
): Promise<AgentRunResult> {
  const startedAt = Date.now();
  const args: string[] = ["-p", "--mode", "json", "--no-context-files", "--no-extensions"];

  if (options.tools) {
    args.push("--tools", options.tools);
  } else {
    args.push("--tools", "read,bash,edit,write");
  }

  if (options.model) {
    if (options.model.includes("/")) {
      args.push("--model", options.model);
    } else if (options.provider) {
      args.push("--provider", options.provider, "--model", options.model);
    } else {
      args.push("--model", options.model);
    }
  }

  if (options.sessionDir) {
    fs.mkdirSync(options.sessionDir, { recursive: true });
    args.push("--session-dir", options.sessionDir);
  } else {
    args.push("--no-session");
  }

  if (options.activeSkillPaths && options.activeSkillPaths.length > 0) {
    args.push("--no-skills");
    for (const skillPath of options.activeSkillPaths) {
      args.push("--skill", skillPath);
    }
  }

  args.push("--", prompt);

  return new Promise((resolve) => {
    let stdoutBuffer = "";
    let stderrBuffer = "";
    const events: any[] = [];
    let toolCalls = 0;
    let messageCount = 0;

    const child = spawn("pi", args, {
      cwd: options.workdir,
      env: {
        ...process.env,
        PI_OFFLINE: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, options.timeoutMs || 180_000);

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdoutBuffer += text;

      // Parse JSON stream events
      const lines = text.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const ev = JSON.parse(trimmed);
          events.push(ev);
          options.onEvent?.(ev);

          if (ev.type === "message_start") {
            messageCount++;
          }
          if (ev.type === "tool_execution_start" || ev.assistantMessageEvent?.type === "tool_use") {
            toolCalls++;
          }
        } catch {
          // Non-JSON line
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code ?? 0,
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
        events,
        toolCalls,
        messageCount,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        exitCode: 1,
        stdout: stdoutBuffer,
        stderr: stderrBuffer + `\nProcess error: ${err.message}`,
        events,
        toolCalls,
        messageCount,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
