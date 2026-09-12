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
import { loadConfig, saveConfig, DEFAULT_CONFIG, getAgentDir, resolveWorkspaceDir } from "./src/config.js";
import { getAvailableModels, resolveModelString } from "./src/model-selector.js";
import {
  initWorkspace,
  loadWorkspaceState,
  evaluateSplit,
  executeTask,
  runEvolutionIteration,
} from "./src/loop.js";
import { loadTasks, setupTaskSandbox } from "./src/tasks.js";
import { listWikiPatterns, appendLog, ensureWiki } from "./src/wiki.js";
import { listActiveSkills, exportSkillToGlobal } from "./src/gating.js";
import { harvestSessionErrors, saveLearnedPattern } from "./src/session-learner.js";
import { updateWikiSkillStatus, clearWikiSkillStatus } from "./src/statusline.js";

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
  {
    value: "statusline",
    label: "statusline [on|off]",
    description: "Zapnout nebo vypnout WikiSkill indikátor ve statusline",
  },
];

export default function (pi: ExtensionAPI): void {
  let sessionCtx: ExtensionContext | undefined;

  pi.on("session_start", (_event, ctx) => {
    sessionCtx = ctx;
    updateWikiSkillStatus(ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    updateWikiSkillStatus(ctx);
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
            "  /wikiskill statusline [on|off]  - Zapnout nebo vypnout indikátor ve statusline",
          ];
          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }

        case "init": {
          const domain = remainder || config.activeWorkspace || "demo";
          const targetWs = resolveWorkspaceDir(config, ctx.cwd, domain);
          const res = initWorkspace(targetWs);
          saveConfig({ activeWorkspace: domain }, true, ctx.cwd);
          updateWikiSkillStatus(ctx);
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
          updateWikiSkillStatus(ctx, `⟳ evoluce 1/${itersCount}...`);

          for (let i = 1; i <= itersCount; i++) {
            const nextIter = state.currentIter + 1;
            updateWikiSkillStatus(ctx, `⟳ iter ${i}/${itersCount}...`);
            const _report = await runEvolutionIteration(wsDir, nextIter, config, tasks, state, {
              onMessage: (msg) => ctx.ui.notify(msg, "info"),
              onProgress: (status) => {
                ctx.ui.notify(status, "info");
                updateWikiSkillStatus(ctx, `⟳ ${i}/${itersCount} (${status.slice(0, 18)})`);
              },
            });

            if (state.bestScore >= 1.0) {
              ctx.ui.notify(`🎉 Dosaženo 100% validačního skóre! Evoluce úspěšně ukončena.`, "info");
              break;
            }
          }
          updateWikiSkillStatus(ctx);
          break;
        }

        case "bench": {
          if (!fs.existsSync(wsDir)) {
            ctx.ui.notify(`Workspace neexistuje. Spusťte nejprve /wikiskill init`, "warning");
            return;
          }
          const tasks = loadTasks(wsDir);
          ctx.ui.notify("Spouštím validační sadu (benchmark)...", "info");
          updateWikiSkillStatus(ctx, "⟳ benching...");
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
          updateWikiSkillStatus(ctx);
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
          updateWikiSkillStatus(ctx);
          break;
        }

        case "statusline": {
          const action = tokens[1]?.toLowerCase();
          if (action === "on") {
            saveConfig({ statusline: true }, false, ctx.cwd);
            updateWikiSkillStatus(ctx);
            ctx.ui.notify("WikiSkill statusline indikátor zapnut.", "info");
          } else if (action === "off") {
            saveConfig({ statusline: false }, false, ctx.cwd);
            clearWikiSkillStatus(ctx);
            ctx.ui.notify("WikiSkill statusline indikátor vypnut.", "info");
          } else {
            const current = config.statusline !== false;
            const next = !current;
            saveConfig({ statusline: next }, false, ctx.cwd);
            if (next) {
              updateWikiSkillStatus(ctx);
              ctx.ui.notify("WikiSkill statusline indikátor zapnut.", "info");
            } else {
              clearWikiSkillStatus(ctx);
              ctx.ui.notify("WikiSkill statusline indikátor vypnut.", "info");
            }
          }
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

  // Programmatic tools for LLM agent
  pi.registerTool({
    name: "wikiskill_status",
    label: "WikiSkill Status",
    description:
      "Zobrazit aktuální stav WikiSkill evolučního cyklu: nejlepší validační skóre R_best, počet iterací, seznam aktivních schválených skillů, odmítnuté návrhy a počet zaznamenaných wiki vzorců.",
    promptSnippet: "Získat přehled WikiSkill evoluce",
    promptGuidelines: [
      "Použij wikiskill_status pro kontrolu aktuálního validačního skóre, aktivních skillů a stavu evolučního cyklu.",
    ],
    parameters: Type.Object({
      domain: Type.Optional(
        Type.String({
          description:
            "Název cílové workspace domény (např. 'demo', 'coding-bench'). Pokud není zadáno, použije se aktuálně aktivní workspace.",
        })
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const config = loadConfig(ctx.cwd);
      const wsDir = resolveWorkspaceDir(config, ctx.cwd, params?.domain);
      if (!fs.existsSync(wsDir)) {
        return {
          content: [{ type: "text", text: `Workspace '${wsDir}' neexistuje. Spusťte nejprve 'wikiskill_init'.` }],
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
    description:
      "Inicializovat nový WikiSkill workspace s automaticky vygenerovaným 22-úlohovým benchmarkem (train i val split), perzistentní wiki vrstvou a git-spravovaným úložištěm skillů.",
    promptSnippet: "Inicializovat WikiSkill workspace",
    promptGuidelines: [
      "Použij wikiskill_init pro vytvoření nového evolučního workspace a přípravu testovacího benchmarku.",
    ],
    parameters: Type.Object({
      domain: Type.Optional(
        Type.String({
          description:
            "Název vytvářeného workspace (např. 'demo', 'python-fixes'). Výchozí hodnota je 'demo'.",
        })
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const config = loadConfig(ctx.cwd);
      const domain = params?.domain || "demo";
      const wsDir = resolveWorkspaceDir(config, ctx.cwd, domain);
      const res = initWorkspace(wsDir);
      updateWikiSkillStatus(ctx);
      return {
        content: [
          {
            type: "text",
            text: `WikiSkill workspace '${domain}' byl úspěšně vytvořen na cestě '${res.wsDir}' s ${res.tasksCount} benchmarkovými úlohami.`,
          },
        ],
        details: { wsDir: res.wsDir, tasksCount: res.tasksCount },
      };
    },
  });

  pi.registerTool({
    name: "wikiskill_evolve",
    label: "WikiSkill Evolve",
    description:
      "Spustit WikiSkill evoluční smyčku podle Algoritmu 1 (Inference v sandboxu → Wiki Maintainer analýza stop → Skill Proposer návrh skillu → Validační brána s přísným pravidlem R_val > R_best).",
    promptSnippet: "Spustit evoluci skillů",
    promptGuidelines: [
      "Použij wikiskill_evolve pro spuštění evoluce skillů na základě nashromážděných zkušeností a chybových stop.",
    ],
    parameters: Type.Object({
      domain: Type.Optional(
        Type.String({
          description:
            "Název workspace domény, kde má evoluční cyklus probíhat (výchozí: aktivní workspace).",
        })
      ),
      iterations: Type.Optional(
        Type.Number({
          description:
            "Počet iterací evoluční smyčky, které se mají provést (výchozí: 1, doporučeno: 2 až 5 pro stabilní výsledky).",
        })
      ),
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

      updateWikiSkillStatus(ctx, `⟳ evoluce 1/${iters}...`);

      for (let i = 1; i <= iters; i++) {
        const nextIter = state.currentIter + 1;
        updateWikiSkillStatus(ctx, `⟳ iter ${i}/${iters}...`);
        const report = await runEvolutionIteration(wsDir, nextIter, config, tasks, state);
        reports.push(report);
        if (state.bestScore >= 1.0) break;
      }

      updateWikiSkillStatus(ctx);

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

  pi.registerTool({
    name: "wikiskill_run_task",
    label: "WikiSkill Run Task",
    description:
      "Spustit jednu vybranou úlohu v izolovaném sandboxu s aktuálními aktivními skilly a vyhodnotit výsledek automatickým graderem.",
    promptSnippet: "Spustit konkrétní task v sandboxu",
    promptGuidelines: [
      "Použij wikiskill_run_task pro ověření chování agenta na jedné vybrané benchmarkové úloze.",
    ],
    parameters: Type.Object({
      taskId: Type.String({
        description:
          "Identifikátor úlohy k otestování (např. 'spec-format1-1', 'extract-logs-1', 'calc-even-sum-1').",
      }),
      domain: Type.Optional(
        Type.String({
          description:
            "Název workspace domény obsahující benchmark (pokud není zadáno, použije se aktivní workspace).",
        })
      ),
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
      const tasks = loadTasks(wsDir);
      const task = tasks.find((t) => t.id === params.taskId);
      if (!task) {
        return {
          content: [{ type: "text", text: `Úloha '${params.taskId}' nebyla v benchmarku nalezena.` }],
          details: { error: "task_not_found" },
        };
      }
      const res = await executeTask(wsDir, task, 0, resolveModelString(config.inferenceModel));
      return {
        content: [
          {
            type: "text",
            text: `Výsledek úlohy ${task.id} (${task.split}):\nSkóre: ${(res.score * 100).toFixed(1)}%\nDoba trvání: ${(res.durationMs / 1000).toFixed(1)}s\nVolání nástrojů: ${res.toolCalls}\nPodrobnosti: ${res.details || "-"}`,
          },
        ],
        details: { runResult: res },
      };
    },
  });

  pi.registerTool({
    name: "wikiskill_learn_session",
    label: "WikiSkill Learn Session",
    description:
      "Analyzovat chyby nástrojů, výjimky a opravné kroky z aktuální interaktivní konverzace a zapsat je jako trvalé vzorce do wiki vrstvy (wiki/patterns/).",
    promptSnippet: "Zapsat zkušenosti z konverzace do wiki",
    promptGuidelines: [
      "Použij wikiskill_learn_session pro uložení poučení z chyb v aktuální session do znalostní báze wiki.",
    ],
    parameters: Type.Object({
      domain: Type.Optional(
        Type.String({
          description:
            "Cílový workspace, do jehož wiki vrstvy se mají nová poučení zapsat (výchozí: aktivní workspace).",
        })
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const config = loadConfig(ctx.cwd);
      const wsDir = resolveWorkspaceDir(config, ctx.cwd, params?.domain);
      ensureWiki(wsDir);

      if (!sessionCtx) {
        return {
          content: [{ type: "text", text: "Není k dispozici kontext aktivní session." }],
          details: { error: "no_session" },
        };
      }

      const entries = sessionCtx.sessionManager.getEntries();
      const errors = harvestSessionErrors(entries);

      if (errors.length === 0) {
        return {
          content: [{ type: "text", text: "V aktuálním sezení nebyly nalezeny žádné chyby nástrojů k extrakci." }],
          details: { extracted: 0 },
        };
      }

      const savedPatterns: string[] = [];
      for (let i = 0; i < Math.min(errors.length, 3); i++) {
        const err = errors[i];
        const slug = `interactive-fix-${Date.now().toString(36)}-${i + 1}`;
        const p = saveLearnedPattern(wsDir, {
          title: `Chyba nástroje: ${err.tool}`,
          slug,
          problem: `Nástroj '${err.tool}' selhal s chybou.`,
          rootCause: err.error,
          fix: `Před voláním nástroje ověřit stav a vstupní parametry.`,
          tags: ["session-learning", err.tool],
        });
        savedPatterns.push(p);
      }

      updateWikiSkillStatus(ctx);

      return {
        content: [
          {
            type: "text",
            text: `Z aktuální konverzace bylo destilováno ${savedPatterns.length} chybových vzorců do wiki/patterns/.`,
          },
        ],
        details: { savedPatterns },
      };
    },
  });

  pi.registerTool({
    name: "wikiskill_export_skills",
    label: "WikiSkill Export Skills",
    description:
      "Exportovat všechny schválené aktivní skilly z workspace do globální složky skillů Pi agenta (~/.pi/agent/skills/) pro okamžité použití ve všech budoucích sezeních.",
    promptSnippet: "Exportovat schválené skilly do Pi",
    promptGuidelines: [
      "Použij wikiskill_export_skills pro přenos ověřených skillů do globálního profilu Pi agenta.",
    ],
    parameters: Type.Object({
      domain: Type.Optional(
        Type.String({
          description:
            "Název workspace domény, ze které se mají skilly exportovat (výchozí: aktivní workspace).",
        })
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const config = loadConfig(ctx.cwd);
      const wsDir = resolveWorkspaceDir(config, ctx.cwd, params?.domain);
      const active = listActiveSkills(wsDir);
      if (active.length === 0) {
        return {
          content: [{ type: "text", text: "Ve workspace se nenacházejí žádné aktivní skilly k exportu." }],
          details: { exported: 0 },
        };
      }
      const activeDir = path.join(wsDir, "skills", "active");
      for (const s of active) {
        exportSkillToGlobal(activeDir, s);
      }
      return {
        content: [
          {
            type: "text",
            text: `Úspěšně exportováno ${active.length} skillů (${active.join(", ")}) do globálního adresáře ~/.pi/agent/skills/.`,
          },
        ],
        details: { exportedSkills: active },
      };
    },
  });
}
