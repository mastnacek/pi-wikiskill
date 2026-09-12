import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { formatStatus, hasWorkspace, updateWikiSkillStatus, clearWikiSkillStatus } from "../src/statusline.js";
import { initWorkspace } from "../src/loop.js";
import type { WorkspaceState } from "../src/types.js";

test("formatStatus formats idle state and custom message accurately", () => {
  const state: WorkspaceState = {
    domain: "demo",
    baselineScore: 0.5,
    bestScore: 0.85,
    currentIter: 2,
    activeSkills: ["spec_validator", "log_parser"],
    rejectedSkills: [],
    history: [],
  };

  // Plain formatting
  const plainIdle = formatStatus(state, 4);
  assert.equal(plainIdle, "wiki:demo R:85% (2s/4p)");

  const plainMsg = formatStatus(state, 4, "⟳ iter 3...");
  assert.equal(plainMsg, "wiki:demo ⟳ iter 3...");

  // Themed formatting
  const mockTheme = {
    fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
    bold: (text: string) => `<b>${text}</b>`,
  };

  const themedIdle = formatStatus(state, 4, undefined, mockTheme);
  assert.ok(themedIdle.includes("[accent]wiki:demo[/accent]"));
  assert.ok(themedIdle.includes("R:85%"));
  assert.ok(themedIdle.includes("(2s/4p)"));

  const themedMsg = formatStatus(state, 4, "⟳ iter 3...", mockTheme);
  assert.ok(themedMsg.includes("[accent]wiki:demo[/accent]"));
  assert.ok(themedMsg.includes("[warning]⟳ iter 3...[/warning]"));
});

test("hasWorkspace accurately detects initialized workspaces", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wikiskill-status-"));
  const nonExistent = path.join(tmpDir, "does-not-exist");
  assert.equal(hasWorkspace(nonExistent), false);

  const emptyDir = path.join(tmpDir, "empty");
  fs.mkdirSync(emptyDir);
  assert.equal(hasWorkspace(emptyDir), false);

  const wsDir = path.join(tmpDir, "active-ws");
  initWorkspace(wsDir);
  assert.equal(hasWorkspace(wsDir), true);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("updateWikiSkillStatus and clearWikiSkillStatus manage ctx.ui.setStatus", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wikiskill-ctx-"));
  const wsDir = path.join(tmpDir, "workspaces", "demo");
  initWorkspace(wsDir);

  let recordedKey: string | undefined;
  let recordedText: string | undefined;

  const mockCtx = {
    cwd: tmpDir,
    ui: {
      setStatus: (key: string, text?: string) => {
        recordedKey = key;
        recordedText = text;
      },
      theme: {
        fg: (_color: string, text: string) => text,
      },
    },
  };

  // Update statusline for active workspace
  updateWikiSkillStatus(mockCtx);
  assert.equal(recordedKey, "wikiskill");
  assert.ok(recordedText?.startsWith("wiki:demo R:0%"));

  // Clear statusline
  clearWikiSkillStatus(mockCtx);
  assert.equal(recordedKey, "wikiskill");
  assert.equal(recordedText, undefined);

  // Disable in config
  fs.mkdirSync(path.join(tmpDir, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, ".pi", "wikiskill.json"),
    JSON.stringify({ statusline: false }),
    "utf8"
  );

  updateWikiSkillStatus(mockCtx);
  assert.equal(recordedText, undefined);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
