import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "./config.js";

export function getAvailableModels(ctx?: ExtensionContext): string[] {
  const models = new Set<string>(["current", "default"]);

  // 1. Inspect runtime ModelRegistry
  try {
    const registry = (
      ctx as unknown as {
        modelRegistry?: {
          getModels?: () => Array<{ provider?: string; id?: string }>;
        };
      }
    )?.modelRegistry;
    if (registry?.getModels) {
      for (const m of registry.getModels()) {
        if (m.provider && m.id) {
          models.add(`${m.provider}/${m.id}`);
        }
      }
    }
  } catch {
    // Non-fatal
  }

  // 2. Read models from ~/.pi/agent/models.json (custom providers)
  try {
    const customModelsPath = path.join(getAgentDir(), "models.json");
    if (fs.existsSync(customModelsPath)) {
      const data = JSON.parse(fs.readFileSync(customModelsPath, "utf8")) as {
        providers?: Record<string, { models?: Array<{ id?: string }> }>;
      };
      if (data.providers) {
        for (const [provider, info] of Object.entries(data.providers)) {
          if (Array.isArray(info?.models)) {
            for (const m of info.models) {
              if (m?.id) models.add(`${provider}/${m.id}`);
            }
          }
        }
      }
    }
  } catch {
    // Non-fatal
  }

  // 3. Read models from ~/.pi/agent/models-store.json (cached remote catalogs)
  try {
    const storePath = path.join(getAgentDir(), "models-store.json");
    if (fs.existsSync(storePath)) {
      const data = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<
        string,
        { models?: Array<string | { id?: string }> }
      >;
      for (const [provider, info] of Object.entries(data)) {
        if (Array.isArray(info?.models)) {
          for (const m of info.models) {
            const id = typeof m === "string" ? m : m?.id;
            if (id) models.add(`${provider}/${id}`);
          }
        }
      }
    }
  } catch {
    // Non-fatal
  }

  return Array.from(models);
}

export function resolveModelString(
  configuredModel: string,
  sessionModel?: { provider?: string; id?: string }
): string | undefined {
  if (configuredModel === "current") {
    if (sessionModel?.provider && sessionModel?.id) {
      return `${sessionModel.provider}/${sessionModel.id}`;
    }
    return undefined; // Let pi use its current default
  }
  if (configuredModel === "default") {
    return undefined; // Let pi use default
  }
  return configuredModel;
}
