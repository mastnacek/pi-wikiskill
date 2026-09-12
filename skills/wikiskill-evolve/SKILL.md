---
name: wikiskill-evolve
description: "Spustit WikiSkill samo-evoluční smyčku (arXiv 2608.27454) na workspace — raw stopy → maintainer → proposer → striktní validační brána R_val > R_best."
version: 1.0.0
license: MIT
platforms: [linux, macos, windows]
metadata:
  pi:
    tags: [wikiskill, evolution, skills, paper-implementation, pi-agent, subagents]
    homepage: https://github.com/mastnacek/pi-wikiskill
---

# WikiSkill Evolve (Pi Agent)

Spusťte samo-evoluční smyčku podle práce Google Research (arXiv:2608.27454) přímo v **Pi agentovi**.
Agent se učí ze svých vlastních chyb: raw sessions → maintainer destiluje vzorce chyb a řešení do trvalé wiki → proposer navrhne kandidátní skill → validační brána jej přijme **pouze tehdy**, pokud $R_{val} > R_{best}$ (jinak následuje git rollback).

## Kdy použít

- Chcete, aby se agent ze svých chyb a zkušeností (stop) sám učil a vytvářel opakovaně použitelné `SKILL.md` balíčky.
- Chcete ověřit, zda navržený skill reálně pomáhá na held-out validačních úlohách, místo pouhého odhadu.
- Chcete trvalou znalostní bázi, která se nikdy neztratí ani po rollbacku nepovedeného skillu.

## Příkazy v Pi agentovi (`/wikiskill`)

Plugin `pi-wikiskill` je plně integrován s příkazovou řádkou Pi:

```text
/wikiskill init <domain>          # Inicializace workspace a 22-úlohového benchmarku
/wikiskill status                 # Zobrazení baseline, R_best, aktivních a odmítnutých skillů
/wikiskill evolve [iters]         # Spuštění evoluční smyčky (train → maintain → propose → gate)
/wikiskill model                  # Výběr modelu pro role (inference, maintainer, proposer)
/wikiskill bench                  # Samostatné vyhodnocení na validační sadě
/wikiskill run-task <id>          # Spuštění konkrétní úlohy v sandboxu pro ladění
/wikiskill learn-session          # Extrakce chyb z aktuální konverzace do wiki
/wikiskill export                 # Export schválených skillů do ~/.pi/agent/skills/
```

## Programatické nástroje pro Pi Agenta

V konverzaci může agent přímo volat:
- `wikiskill_init(domain)` — vytvoření nového evolučního workspace.
- `wikiskill_status(domain)` — kontrola stavu evoluce, $R_{best}$ a zaznamenaných vzorců.
- `wikiskill_evolve(domain, iterations)` — spuštění samo-evolučního cyklu.
- `wikiskill_run_task(taskId, domain)` — otestování jedné úlohy v sandboxu.
- `wikiskill_learn_session(domain)` — zápis ponaučení z aktuální session do wiki.
- `wikiskill_export_skills(domain)` — přenos ověřených skillů do globálního profilu.

## Struktura workspace (`workspaces/<domain>/`)

- `runs/state.json` — $R_{best}$, dokončené iterace, historie.
- `wiki/log.md` — rozhodnutí maintainera, proposera a validační brány.
- `wiki/patterns/` — zkompilované vzorce řešení a návody (trvalé, nerollbackují se).
- `wiki/skill-impact.md` — přehled schválených i odmítnutých návrhů (včetně důvodů).
- `skills/active/` — git-spravované produkční skilly v otevřeném formátu `SKILL.md`.

## Výsledky validační brány

- **ACCEPTED**: $R_{val} > R_{best}$ $\rightarrow$ git commit do `skills/active/`, zvýšení $R_{best}$, export do Pi profilu.
- **REJECTED**: $R_{val} \le R_{best}$ $\rightarrow$ git rollback (`git reset --hard`), zaznamenání do `wiki/skill-impact.md`.
- **NO_ACTION**: Proposer usoudil, že není potřeba žádná úprava (platný stav).
