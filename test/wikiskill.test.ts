import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { generateBenchmarkTasks, setupTaskSandbox } from "../src/tasks.js";
import { gradeTask, normalizeText } from "../src/graders.js";
import { sampleTraces } from "../src/traces.js";
import { ensureWiki, recordSkillImpact, listWikiPatterns } from "../src/wiki.js";
import { stageProposal, rollbackSkills, listActiveSkills, ensureSkillsRepo } from "../src/gating.js";
import { resolveModelString } from "../src/model-selector.js";

test("benchmark generator produces deterministic tasks", () => {
  const tasks1 = generateBenchmarkTasks(42);
  const tasks2 = generateBenchmarkTasks(42);
  assert.equal(tasks1.length, tasks2.length);
  assert.equal(tasks1[0].id, tasks2[0].id);
  assert.equal(tasks1[0].split, "train");
  assert.ok(tasks1.some((t) => t.split === "val"));
});

test("graders accurately score deliverables", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wikiskill-test-"));
  const task = {
    id: "test-task",
    split: "train" as const,
    title: "Test",
    prompt: "Test",
    sandbox: {},
    grader: { type: "exact" as const, file: "out.txt", expected: "apple|10|active" },
  };

  // Missing file -> score 0
  assert.equal(gradeTask(task, tmpDir).score, 0.0);

  // Correct file -> score 1
  fs.writeFileSync(path.join(tmpDir, "out.txt"), "apple|10|active\n");
  assert.equal(gradeTask(task, tmpDir).score, 1.0);

  // Normalization check
  assert.equal(normalizeText("  foo   bar \n"), "foo bar");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("wiki and gating mechanics work", () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "wikiskill-ws-"));
  ensureWiki(tmpWs);
  assert.ok(fs.existsSync(path.join(tmpWs, "wiki", "index.md")));
  assert.ok(fs.existsSync(path.join(tmpWs, "wiki", "log.md")));
  assert.ok(fs.existsSync(path.join(tmpWs, "wiki", "skill-impact.md")));

  // Staging proposal
  ensureSkillsRepo(tmpWs);
  stageProposal(tmpWs, {
    type: "create",
    skillName: "spec_validator",
    content: "---\nname: spec_validator\ndescription: test\n---\n# Test",
    explanation: "test",
  });
  assert.ok(listActiveSkills(tmpWs).includes("spec_validator"));

  // Rollback
  rollbackSkills(tmpWs);
  // Note: in a fresh temp dir without commits, rollback cleans untracked
  assert.equal(listActiveSkills(tmpWs).length, 0);

  fs.rmSync(tmpWs, { recursive: true, force: true });
});

test("model selector resolves current and default", () => {
  assert.equal(resolveModelString("default"), undefined);
  assert.equal(
    resolveModelString("current", { provider: "openrouter", id: "gemini-flash" }),
    "openrouter/gemini-flash"
  );
  assert.equal(resolveModelString("anthropic/claude-3-7-sonnet"), "anthropic/claude-3-7-sonnet");
});
