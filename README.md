# pi-wikiskill 🧠

> **WikiSkill self-evolution loop & persistent knowledge compiler for the Pi coding agent.**  
> Purely native TypeScript implementation of Google Research's **[WikiSkill: Compiling Agent Experience into Persistent Knowledge for Skill Evolution](https://arxiv.org/abs/2608.27454)** (arXiv:2608.27454).

[![TypeScript](https://img.shields.io/badge/typescript-5.8+-blue.svg)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![arXiv](https://img.shields.io/badge/arXiv-2608.27454-red.svg)](https://arxiv.org/abs/2608.27454)

```text
workspaces/<domain>/
├── raw/traces/iter-01/{train,val}/<task>.jsonl   # Neměnné stopy běhu agenta
├── wiki/                                          # Trvalá znalostní báze (nikdy se nevrací zpět)
│   ├── index.md · log.md · skill-impact.md · patterns/*.md
├── skills/active/                                 # Git-spravovaná sada aktivních skillů (S₀ = ∅)
├── bench/tasks.json                               # Sandbox úlohy s automatickými gradery
└── runs/                                          # Stav, historie a návrhy (state.json, proposals/)
```

---

## Co to je a proč to potřebujete?

Při řešení komplexních úkolů se agent často setká s chybami nástrojů, sandboxu a logiky. Běžně se však při ukončení sezení všechna tato ponaučení ztratí. 

**`pi-wikiskill`** implementuje třívrstvou architekturu a uzavřenou samo-evoluční smyčku (**Algoritmus 1**):

1. **Inference Agent:** Spustí trénovací úlohy v izolovaných sandboxes pod aktuálními skilly $S_k$ a zaznamená kompletní JSONL stopy běhu do vrstvy **Raw**.
2. **Wiki Maintainer:** Podle Appendix E.2 promptu analyzuje stopy selhání a destiluje z nich obecné vzorce řešení, příčiny a postupy do **Wiki** vrstvy (`wiki/patterns/`). **Tato wiki se nikdy nerollbackuje.**
3. **Skill Proposer:** Podle Appendix E.3 ReAct promptu navrhne úpravu nebo vytvoření nového `SKILL.md` balíčku.
4. **Validation Gating (Validační brána):** Navržený kandidátní skill je otestován na validační sadě úloh:
   - **$R_{val} > R_{best}$ (Zlepšení):** Skill je schválen, git-commitnut do `skills/active/` a volitelně exportován do globálních skillů Pi agenta (`~/.pi/agent/skills/`).
   - **$R_{val} \le R_{best}$ (Zhoršení / stagnace):** Skill vrstva je okamžitě vrácena zpět (`git reset --hard`), ale poučení o odmítnutí a důvod selhání zůstává natrvalo ve `wiki/skill-impact.md`.

---

## 📦 Instalace

Plugin lze nainstalovat přímo do Pi agenta z GitHub repozitáře:

```bash
pi install git:github.com/mastnacek/pi-wikiskill
```

Nebo lokálně ze složky:

```bash
pi install ~/100_projects/pi-wikiskill
```

---

## 🕹️ Příkazová plocha (`/wikiskill`)

Plugin nabízí interaktivní **lazy menu** při psaní v příkazovém řádku Pi s českou nápovědou a kontextovým doplňováním:

| Příkaz | Popis |
| --- | --- |
| `/wikiskill init [domain]` | Inicializuje nový workspace s 22-úlohovým auto-gradovaným benchmarkem (train / val). |
| `/wikiskill status` | Zobrazí aktuální stav evoluce, validační skóre $R_{best}$, aktivní skilly a zaznamenané wiki vzorce. |
| `/wikiskill evolve [iters]` | Spustí zadaný počet iterací kompletní samo-evoluční smyčky. |
| `/wikiskill model [role] [model]` | Otevře interaktivní menu pro výběr modelů z konfigurovaných providerů v Pi. |
| `/wikiskill bench` | Spustí vyhodnocení aktuálních skillů na validační sadě bez evoluce. |
| `/wikiskill run-task <id>` | Spustí konkrétní úlohu v sandboxu pro vizuální ladění a kontrolu výstupu graderu. |
| `/wikiskill learn-session` | **Interaktivní učení:** Analyzuje chyby nástrojů z aktuální Pi konverzace a zapíše nová poučení do wiki. |
| `/wikiskill export` | Exportuje všechny schválené aktivní skilly do globální složky `~/.pi/agent/skills/`. |
| `/wikiskill help` | Zobrazí souhrnnou nápovědu a přehled. |

---

## 🎛️ Konfigurace modelů a rolí

WikiSkill profituje ze specializovaných modelů pro jednotlivé role:
- **`inference`**: Rychlý a ekonomický model pro testování sandboxing úloh (např. `google/gemini-3.5-flash-lite`).
- **`maintainer`**: Model s velkým kontextem a přesnou syntézou pro analýzu stop chyb.
- **`proposer`**: High-reasoning model (s podporou myšlení/CoT) pro návrh striktních instrukcí ve formátu `SKILL.md`.

Modely lze nastavit interaktivně přes menu:
```text
/wikiskill model
```
Nebo přímo v příkazu:
```bash
/wikiskill model inference openrouter/google/gemini-3.5-flash-lite
/wikiskill model maintainer openrouter/google/gemini-3.8-flash
/wikiskill model proposer openrouter/anthropic/claude-3-7-sonnet
/wikiskill model all current
```

---

## 🛠️ Nástroje pro LLM Agenta

Pokud je plugin aktivní, hlavní Pi agent má k dispozici programatické nástroje:
- **`wikiskill_status`** — zjištění aktuálního stavu evoluce a skóre.
- **`wikiskill_init`** — inicializace nového evolučního workspace.
- **`wikiskill_evolve`** — spuštění evolučních cyklů.

---

## 🔬 Auto-gradery benchmarku

Úlohy v `bench/tasks.json` podporují deterministické gradery:
- `exact`: Whitespace-normalizovaná přesná shoda se souborem.
- `contains`: Ověření přítomnosti podřetězce v deliverable souboru.
- `json_field`: Kontrola hodnoty vnořeného pole JSON souboru.
- `code_stdout`: Spuštění skriptu (`node`, `python3`, `bash`) v sandboxu a ověření výstupu na standardním výstupu.

---

## 📄 Licence

MIT © [Solo Sith Lord](https://github.com/mastnacek)
