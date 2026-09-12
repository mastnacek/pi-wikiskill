import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureWiki, commitWiki } from "./wiki.js";

export interface DistilledLesson {
  title: string;
  slug: string;
  problem: string;
  rootCause: string;
  fix: string;
  tags: string[];
}

export function harvestSessionErrors(entries: any[]): Array<{ tool: string; error: string; context: string }> {
  const errors: Array<{ tool: string; error: string; context: string }> = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry?.type === "message" && entry?.message?.role === "tool") {
      const isErr = entry.message.isError || (typeof entry.message.content === "string" && entry.message.content.includes("Error"));
      if (isErr) {
        const toolName = entry.message.toolName || "tool";
        const content = typeof entry.message.content === "string" ? entry.message.content : JSON.stringify(entry.message.content);
        // Find preceding assistant call if available
        let prevContext = "";
        if (i > 0 && entries[i - 1]?.message?.content) {
          prevContext = JSON.stringify(entries[i - 1].message.content).slice(0, 300);
        }
        errors.push({
          tool: toolName,
          error: content.slice(0, 500),
          context: prevContext,
        });
      }
    }
  }

  return errors;
}

export function saveLearnedPattern(wsDir: string, lesson: DistilledLesson): string {
  ensureWiki(wsDir);
  const patternPath = path.join(wsDir, "wiki", "patterns", `${lesson.slug}.md`);

  const md =
    `# Pattern: ${lesson.title}\n\n` +
    `**Tags**: ${lesson.tags.map((t) => `\`${t}\``).join(", ")}\n` +
    `**Learned At**: ${new Date().toISOString()}\n\n` +
    `## Problem\n${lesson.problem}\n\n` +
    `## Root Cause\n${lesson.rootCause}\n\n` +
    `## Fix & Prevention\n${lesson.fix}\n`;

  fs.writeFileSync(patternPath, md, "utf8");

  // Update wiki/index.md
  const indexPath = path.join(wsDir, "wiki", "index.md");
  const linkEntry = `- [${lesson.title}](patterns/${lesson.slug}.md): ${lesson.problem} -> **Fix**: ${lesson.fix}\n`;
  if (fs.existsSync(indexPath)) {
    fs.appendFileSync(indexPath, linkEntry, "utf8");
  }

  commitWiki(wsDir, `feat(wiki): learn interactive pattern ${lesson.slug}`);
  return patternPath;
}
