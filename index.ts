import * as path from "node:path";
import * as fs from "node:fs";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import type { WikiSkillConfig, WorkspaceState, Task } from "./src/types.js";
import { loadConfig, saveConfig, DEFAULT_CONFIG, getAgentDir } from "./src/config.js";
import { getAvailableModels, resolveModelString } from "./src/model-selector.js";
import {
  initWorkspace,
  loadWorkspaceState,
  evaluateSplit,
  executeTask,
  runEvolutionIteration,
} from "./src/loop.js";
import { loadTasks, setupTaskSandbox } from "./src/tasks.js";
import { listWikiPatterns, appendLog } from "./src/wiki.js";
import { listActiveSkills, exportSkillToGlobal } from "./src/gating.js";
import { harvestSessionErrors, saveLearnedPattern } from "./src/session-learner.js";

const SUBCOMMANDS: AutocompleteItem[] = [
  {
    value: "status",
    label: "status",
    description: "Zobrazit stav evoluce, R_best skóre a aktivní/odmítnuté skilly",
  },
  {
    value: "evolve",
    label: "evolve [iters]",
    description: "Spustit evoluční smyčku (Raw → Wiki → Proposer → Gate)",
  },
  {
    value: "init",
    label: "init [domain]",
    description: "Inicializovat nový evolution workspace a demo benchmark",
  },
  {
    value: "model",
    label: "model [role] [model]",
    description: "Konfigurace modelů pro role (inference, maintainer, proposer)",
  },
  {
    value: "bench",
    label: "bench",
    description: "Vyhodnotit aktuální stav skillů na validační sadě",
  },
  {
    value: "run-task",
    label: "run-task <id>",
    description: "Spustit jeden vybraný task v sandboxu a vyhodnotit",
  },
  {
    value: "learn-session",
    label: "learn-session",
    description: "Analyzovat chyby a poučení z aktuální interaktivní Pi session do wiki",
  },
  {
    value: "export",
    label: "export",
    description: "Exportovat schválené skilly do globální složky ~/.pi/agent/skills/",
  },
  {
    value: "help",
    label: "help",
    description: "Zobrazit podrobnou nápovědu a vysvětlení algoritmu WikiSkill",
  },
];

function resolveWorkspaceDir(config: WikiSkillConfig, cwd: string, overrideDomain?: string): string {
  const domain = overrideDomain || config.activeWorkspace || "demo";
  return path.join(cwd, config.workspacesDir || "workspaces", domain);
}

export default function (pi: ExtensionAPI): void {
  let sessionCtx: ExtensionContext | undefined;

  pi.on("session_start", (_event, ctx) => {
    sessionCtx = ctx;
  });

  // Register /wikiskill command
  pi.registerCommand("wikiskill", {
    description: "WikiSkill: samo-evoluční smyčka pro kompilaci zkušeností do wiki a tvorbu skillů",
    getArgumentCompletions: async (prefix: string): Promise<AutocompleteItem[] | null> => {
      const tokens = prefix.split(/\s+/).filter(Boolean);
      const trailingSpace = /\s$/.test(prefix);
      const normalizedPrefix = tokens.join(" ").toLowerCase();

      // 2nd / 3rd Token completions
      if (tokens.length > 1 || (trailingSpace && tokens.length === 1)) {
        const cmd = tokens[0]?.toLowerCase();
        const config = loadConfig(sessionCtx?.cwd);

        // --- model completions ---
        if (cmd === "model") {
          const roles = ["all", "inference", "maintainer", "proposer"];
          if (tokens.length === 1 || (tokens.length === 2 && !trailingSpace)) {
            const items = roles.map((r) => ({
              value: `model ${r}`,
              label: `model ${r}`,
              description: `Nastavit model pro roli: ${r}`,
            }));
            const filtered = items.filter((i) => i.value.toLowerCase().startsWith(normalizedPrefix));
            return filtered.length > 0 ? filtered : null;
          }

          if (tokens.length === 2 || (tokens.length === 3 && !trailingSpace)) {
            const role = tokens[1]?.toLowerCase();
            const available = getAvailableModels(sessionCtx);
            const activeModel =
              role === "inference"
                ? config.inferenceModel
                : role === "maintainer"
                ? config.maintainerModel
                : role === "proposer"
                ? config.proposerModel
                : config.inferenceModel;

            const items = available.map((m) => {
              const isActive = m === activeModel;
              return {
                value: `model ${role} ${m}`,
                label: `model ${role} ${m}`,
                description: `použít ${m}${isActive ? " · ● AKTIVNÍ" : ""}`,
              };
            });
            const filtered = items.filter((i) => i.value.toLowerCase().startsWith(normalizedPrefix));
            return filtered.length > 0 ? filtered : null;
          }
        }

        // --- evolve completions ---
        if (cmd === "evolve") {
          const iters = [1, 2, 3, 5];
          const items = iters.map((n) => ({
            value: `evolve ${n}`,
            label: `evolve ${n}`,
            description: `Spustit ${n} iterac${n === 1 ? "i" : n < 5 ? "e" : "í"} evoluční smyčky`,
          }));
          const filtered = items.filter((i) => i.value.toLowerCase().startsWith(normalizedPrefix));
          return filtered.length > 0 ? filtered : null;
        }

        // --- run-task completions ---
        if (cmd === "run-task") {
          try {
            const wsDir = resolveWorkspaceDir(config, sessionCtx?.cwd || process.cwd());
            const tasks = loadTasks(wsDir);
            const items = tasks.map((t) => ({
              value: `run-task ${t.id}`,
              label: `run-task ${t.id}`,
              description: `[${t.split}] ${t.title}`,
            }));
            const filtered = items.filter((i) => i.value.toLowerCase().startsWith(normalizedPrefix));
            return filtered.length > 0 ? filtered : null;
          } catch {
            return null;
          }
        }

        return null;
      }

      // 1st Token completions
      const typed = (tokens[0] ?? "").toLowerCase();
      const items = SUBCOMMANDS.filter((cmd) => cmd.value.toLowerCase().startsWith(typed));
      return items.length > 0 ? items : null;
    },

    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const trimmed = args.trim();
      const tokens = trimmed.split(/\s+/).filter(Boolean);
      const subcommand = (tokens[0] ?? "status").toLowerCase();
      const remainder = tokens.slice(1).join(" ").trim();
      const config = loadConfig(ctx.cwd);
      const wsDir = resolveWorkspaceDir(config, ctx.cwd);

      switch (subcommand) {
        case "help": {
          const lines = [
            "🧠 WikiSkill: Persistent Knowledge & Skill Evolution for Pi Agent",
            "",
            "Příkazy:",
            "  /wikiskill init [domain]        - Inicializovat workspace a 22-taskový benchmark",
            "  /wikiskill status               - Zobrazit stav evoluce a metriky R_best",
            "  /wikiskill evolve [iters]       - Spustit plnou evoluční smyčku (Raw → Wiki → Propose → Gate)",
            "  /wikiskill model [role] [model] - Vybrat model z dostupných providerů",
            "  /wikiskill bench                - Spustit validační sadu a změřit aktuální úspěšnost",
            "  /wikiskill run-task <id>        - Spustit konkrétní task v sandboxu pro ladění",
            "  /wikiskill learn-session        - Analyzovat chyby z aktuální konverzace do wiki",
            "  /wikiskill export               - Zkopírovat schválené skilly do ~/.pi/agent/skills/",
          ];
          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }

        case "init": {
          const domain = remainder || config.activeWorkspace || "demo";
          const targetWs = resolveWorkspaceDir(config, ctx.cwd, domain);
          const res = initWorkspace(targetWs);
          saveConfig({ activeWorkspace: domain }, true, ctx.cwd);
          ctx.ui.notify(
            `Workspace inicializován: ${res.wsDir}\nVygenerováno úloh v benchmarku: ${res.tasksCount} (train/val)`,
            "info"
          );
          break;
        }

        case "status": {
          if (!fs.existsSync(wsDir)) {
            ctx.ui.notify(
              `Workspace '${wsDir}' zatím neexistuje. Spusťte nejprve '/wikiskill init'.`,
              "warning"
            );
            return;
          }
          const state = loadWorkspaceState(wsDir);
          const activeSkills = listActiveSkills(wsDir);
          const patterns = listWikiPatterns(wsDir);

          const lines = [
            `🧠 WikiSkill Status [Workspace: ${path.basename(wsDir)}]`,
            `-------------------------------------------------------`,
            `R_best validační skóre: ${(state.bestScore * 100).toFixed(1)}%`,
            `Dokončené iterace:      ${state.currentIter}`,
            `Aktivní skilly (S_k):   ${activeSkills.length > 0 ? activeSkills.join(", ") : "(žádné - S_0 baseline)"}`,
            `Odmítnuté návrhy:       ${state.rejectedSkills.length > 0 ? state.rejectedSkills.join(", ") : "(žádné)"}`,
            `Wiki vzory (patterns):  ${patterns.length} zaznamenaných failure vzorů`,
            `Modely:                 inference: ${config.inferenceModel} | maintainer: ${config.maintainerModel} | proposer: ${config.proposerModel}`,
          ];
          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }

        case "model": {
          const role = tokens[1]?.toLowerCase();
          const chosenModel = tokens[2];

          if (role && chosenModel) {
            if (role === "all") {
              saveConfig(
                {
                  inferenceModel: chosenModel,
                  maintainerModel: chosenModel,
                  proposerModel: chosenModel,
                },
                false,
                ctx.cwd
              );
            } else if (role === "inference") {
              saveConfig({ inferenceModel: chosenModel }, false, ctx.cwd);
            } else if (role === "maintainer") {
              saveConfig({ maintainerModel: chosenModel }, false, ctx.cwd);
            } else if (role === "proposer") {
              saveConfig({ proposerModel: chosenModel }, false, ctx.cwd);
            }
            ctx.ui.notify(`Model pro roli '${role}' nastaven na: ${chosenModel}`, "info");
            return;
          }

          // Interactive model selection via menu
          const available = getAvailableModels(sessionCtx);
          const selectedRole = await ctx.ui.select("Vyberte roli pro konfiguraci modelu:", [
            "all (všechny role najednou)",
            "inference (spouštění tasků v sandboxu)",
            "maintainer (analýza stop a zápis do wiki)",
            "proposer (návrh nových skillů)",
          ]);

          if (!selectedRole) return;
          const roleKey = selectedRole.split(" ")[0];

          const selectedModel = await ctx.ui.select(
            `Vyberte model z konfigurovaných providerů pro '${roleKey}':`,
            available
          );

          if (!selectedModel) return;

          if (roleKey === "all") {
            saveConfig(
              {
                inferenceModel: selectedModel,
                maintainerModel: selectedModel,
                proposerModel: selectedModel,
              },
              false,
              ctx.cwd
            );
          } else if (roleKey === "inference") {
            saveConfig({ inferenceModel: selectedModel }, false, ctx.cwd);
          } else if (roleKey === "maintainer") {
            saveConfig({ maintainerModel: selectedModel }, false, ctx.cwd);
          } else if (roleKey === "proposer") {
            saveConfig({ proposerModel: selectedModel }, false, ctx.cwd);
          }

          ctx.ui.notify(`Model pro '${roleKey}' úspěšně nastaven na: ${selectedModel}`, "info");
          break;
        }

        case "evolve": {
          if (!fs.existsSync(wsDir)) {
            initWorkspace(wsDir);
          }
          const itersCount = parseInt(tokens[1] || String(config.defaultIters || 3), 10);
          const tasks = loadTasks(wsDir);
          const state = loadWorkspaceState(wsDir);

          ctx.ui.notify(
            `Spouštím evoluční smyčku WikiSkill (${itersCount} iterac${itersCount === 1 ? "e" : "í"})...\nWorkspace: ${wsDir}`,
            "info"
          );

          for (let i = 1; i <= itersCount; i++) {
            const nextIter = state.currentIter + 1;
            const report = await runEvolutionIteration(wsDir, nextIter, config, tasks, state, {
              onMessage: (msg) => ctx.ui.notify(msg, "info"),
              onProgress: (status) => ctx.ui.notify(status, "info"),
            });

            if (state.bestScore >= 1.0) {
              ctx.ui.notify(`🎉 Dosaženo 100% validačního skóre! Evoluce úspěšně ukončena.`, "info");
              break;
            }
          }
          break;
        }

        case "bench": {
          if (!fs.existsSync(wsDir)) {
            ctx.ui.notify(`Workspace neexistuje. Spusťte nejprve /wikiskill init`, "warning");
            return;
          }
          const tasks = loadTasks(wsDir);
          ctx.ui.notify("Spouštím validační sadu (benchmark)...", "info");
          const evalRes = await evaluateSplit(
            wsDir,
            tasks,
            "val",
            0,
            resolveModelString(config.inferenceModel)
          );
          ctx.ui.notify(
            `Validační výsledek: ${(evalRes.avgScore * 100).toFixed(1)}% (${evalRes.results.filter((r) => r.score >= 1.0).length}/${evalRes.results.length} splněno)`,
            "info"
          );
          break;
        }

        case "run-task": {
          const taskId = tokens[1];
          if (!taskId) {
            ctx.ui.notify("Zadejte ID tasku: /wikiskill run-task <id>", "warning");
            return;
          }
          const tasks = loadTasks(wsDir);
          const task = tasks.find((t) => t.id === taskId);
          if (!task) {
            ctx.ui.notify(`Task '${taskId}' nebyl v benchmarku nalezen.`, "error");
            return;
          }
          ctx.ui.notify(`Spouštím task ${task.id}...`, "info");
          const res = await executeTask(
            wsDir,
            task,
            0,
            resolveModelString(config.inferenceModel),
            (m) => ctx.ui.notify(m, "info")
          );
          ctx.ui.notify(
            `Výsledek tasku ${task.id}: Skóre: ${res.score * 100}% | Doba: ${(res.durationMs / 1000).toFixed(1)}s\nPodrobnosti: ${res.details || "-"}`,
            res.score >= 1.0 ? "info" : "warning"
          );
          break;
        }

        case "learn-session": {
          if (!sessionCtx) {
            ctx.ui.notify("Není dostupný kontext aktivní session.", "error");
            return;
          }
          const entries = sessionCtx.sessionManager.getEntries();
          const errors = harvestSessionErrors(entries);

          if (errors.length === 0) {
            ctx.ui.notify(
              "V aktuální session nebyly detekovány žádné chyby nástrojů k extrakci.",
              "info"
            );
            return;
          }

          ctx.ui.notify(
            `Nalezeno ${errors.length} chybových interakcí. Destiluji poučení do wiki...`,
            "info"
          );

          for (let i = 0; i < Math.min(errors.length, 3); i++) {
            const err = errors[i];
            const slug = `interactive-fix-${Date.now().toString(36)}-${i + 1}`;
            saveLearnedPattern(wsDir, {
              title: `Interactive Tool Error: ${err.tool}`,
              slug,
              problem: `Nástroj '${err.tool}' selhal s chybou.`,
              rootCause: err.error,
              fix: `Vyhnout se chybným parametrům nebo prověřit stav před voláním.`,
              tags: ["session-learning", err.tool],
            });
          }

          ctx.ui.notify(`Zkušenosti z konverzace byly úspěšně zapsány do wiki/patterns/.`, "info");
          break;
        }

        case "export": {
          const active = listActiveSkills(wsDir);
          if (active.length === 0) {
            ctx.ui.notify(
              "Ve workspace nejsou žádné schválené aktivní skilly k exportu.",
              "warning"
            );
            return;
          }
          const activeDir = path.join(wsDir, "skills", "active");
          for (const s of active) {
            exportSkillToGlobal(activeDir, s);
          }
          ctx.ui.notify(
            `Úspěšně exportováno ${active.length} skillů do ${path.join(getAgentDir(), "skills")}.`,
            "info"
          );
          break;
        }

        default:
          ctx.ui.notify(`Neznámý příkaz '/wikiskill ${subcommand}'. Použijte '/wikiskill help'.`, "warning");
      }
    },
  });

  // Register programmatic tools for LLM agent
  pi.registerTool({
    name: "wikiskill_status",
    label: "WikiSkill Status",
    description: "Zobrazit aktuální stav WikiSkill evolučního cyklu, nejlepší validační skóre R_best a seznam aktivních skillů.",
    promptSnippet: "Získat přehled WikiSkill evoluce",
    promptGuidelines: ["Use wikiskill_status to check current validation score and active skills."],
    parameters: Type.Object({
      domain: Type.Optional(Type.String({ description: "Název workspace domény" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const config = loadConfig(ctx.cwd);
      const wsDir = resolveWorkspaceDir(config, ctx.cwd, params?.domain);
      if (!fs.existsSync(wsDir)) {
        return {
          content: [{ type: "text", text: `Workspace '${wsDir}' neexistuje.` }],
          details: { error: "not_found" },
        };
      }
      const state = loadWorkspaceState(wsDir);
      const active = listActiveSkills(wsDir);
      const patterns = listWikiPatterns(wsDir);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                domain: state.domain,
                bestScore: state.bestScore,
                currentIter: state.currentIter,
                activeSkills: active,
                rejectedSkills: state.rejectedSkills,
                discoveredPatternsCount: patterns.length,
              },
              null,
              2
            ),
          },
        ],
        details: { state, active, patternsCount: patterns.length },
      };
    },
  });

  pi.registerTool({
    name: "wikiskill_init",
    label: "WikiSkill Init",
    description: "Inicializovat nový WikiSkill workspace s automaticky generovaným benchmarkem úloh.",
    promptSnippet: "Inicializovat WikiSkill workspace",
    promptGuidelines: ["Use wikiskill_init to create an evolution workspace with benchmark tasks."],
    parameters: Type.Object({
      domain: Type.Optional(Type.String({ description: "Název domény (výchozí: demo)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const config = loadConfig(ctx.cwd);
      const domain = params?.domain || "demo";
      const wsDir = resolveWorkspaceDir(config, ctx.cwd, domain);
      const res = initWorkspace(wsDir);
      return {
        content: [
          {
            type: "text",
            text: `WikiSkill workspace '${domain}' byl vytvořen na cestě '${res.wsDir}' s ${res.tasksCount} benchmarkovými úlohami.`,
          },
        ],
        details: { wsDir: res.wsDir, tasksCount: res.tasksCount },
      };
    },
  });

  pi.registerTool({
    name: "wikiskill_evolve",
    label: "WikiSkill Evolve",
    description: "Spustit WikiSkill evoluční smyčku (Raw traces -> Wiki maintainer -> Skill proposer -> Validation gating).",
    promptSnippet: "Spustit evoluci skillů",
    promptGuidelines: ["Use wikiskill_evolve to optimize and evolve skills through experience and gating."],
    parameters: Type.Object({
      domain: Type.Optional(Type.String({ description: "Workspace doména" })),
      iterations: Type.Optional(Type.Number({ description: "Počet iterací (výchozí: 1)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const config = loadConfig(ctx.cwd);
      const wsDir = resolveWorkspaceDir(config, ctx.cwd, params?.domain);
      if (!fs.existsSync(wsDir)) {
        initWorkspace(wsDir);
      }
      const tasks = loadTasks(wsDir);
      const state = loadWorkspaceState(wsDir);
      const iters = params?.iterations || 1;
      const reports = [];

      for (let i = 1; i <= iters; i++) {
        const nextIter = state.currentIter + 1;
        const report = await runEvolutionIteration(wsDir, nextIter, config, tasks, state);
        reports.push(report);
        if (state.bestScore >= 1.0) break;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                completedIterations: reports.length,
                finalBestScore: state.bestScore,
                activeSkills: state.activeSkills,
                reports,
              },
              null,
              2
            ),
          },
        ],
        details: { reports, bestScore: state.bestScore },
      };
    },
  });
}
