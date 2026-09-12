import * as fs from "node:fs";
import * as path from "node:path";
import type { Task, Split } from "./types.js";

// Deterministic Pseudo-Random Number Generator (Linear Congruential Generator)
class RNG {
  private state: number;
  constructor(seed = 42) {
    this.state = seed;
  }
  next(): number {
    this.state = (this.state * 1664525 + 1013904223) % 4294967296;
    return this.state / 4294967296;
  }
  choice<T>(arr: T[]): T {
    const idx = Math.floor(this.next() * arr.length);
    return arr[idx];
  }
  randint(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
}

export function generateBenchmarkTasks(seed = 42): Task[] {
  const rng = new RNG(seed);
  const tasks: Task[] = [];

  // 1. Format 1: NAME|QTY|STATUS, sorted by name, qty >= threshold
  const fmt1Configs: Array<[Split, number, number]> = [
    ["train", 10, 1],
    ["val", 15, 2],
  ];
  for (const [split, thresh, i] of fmt1Configs) {
    const products = [];
    const pool = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
    for (let p = 0; p < 8; p++) {
      products.push({
        name: rng.choice(pool),
        qty: rng.randint(0, 40),
        status: rng.choice(["active", "sold", "pending"]),
      });
    }
    const kept = products
      .filter((p) => p.qty >= thresh)
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    const expected = kept.map((p) => `${p.name}|${p.qty}|${p.status}`).join("\n");
    const spec =
      `# Output specification\n` +
      `Write the deliverable to \`output.txt\` with EXACTLY this format:\n` +
      `- one line per product whose quantity is >= ${thresh}\n` +
      `- lines sorted alphabetically by product name (case-insensitive)\n` +
      `- each line: NAME|QTY|STATUS (pipe-separated, no spaces around \`|\`)\n` +
      `- no header line, no footer, no trailing blank lines\n\n` +
      `Product data is in \`products.json\` (list of {name, qty, status}).\n`;

    tasks.push({
      id: `spec-format1-${i}`,
      split,
      title: "Format products according to spec",
      prompt: "Read `spec.md` and `products.json` in the current directory. Follow `spec.md` exactly and produce `output.txt`.",
      sandbox: {
        "spec.md": spec,
        "products.json": JSON.stringify(products, null, 2),
      },
      grader: { type: "exact", file: "output.txt", expected },
    });
  }

  // 2. Format 2: semicolon-separated, UPPERCASE names, header row, qty > 0
  const fmt2Configs: Array<[Split, number]> = [
    ["train", 1],
    ["val", 2],
  ];
  for (const [split, i] of fmt2Configs) {
    const products = [];
    const pool = ["apple", "banana", "cherry", "date", "elderberry", "fig"];
    for (let p = 0; p < 7; p++) {
      products.push({
        name: rng.choice(pool),
        qty: rng.randint(0, 25),
      });
    }
    const kept = products
      .filter((p) => p.qty > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
    const lines = ["NAME;QUANTITY", ...kept.map((p) => `${p.name.toUpperCase()};${p.qty}`)];
    const expected = lines.join("\n");
    const spec =
      `# Output specification\n` +
      `Write the deliverable to \`output.txt\`:\n` +
      `- header line: NAME;QUANTITY\n` +
      `- one line per product with quantity > 0, sorted by name (case-insensitive)\n` +
      `- product names UPPERCASE, quantity as integer\n` +
      `- semicolon separator, no spaces\n` +
      `- no trailing blank lines\n\n` +
      `Data: \`products.json\` (list of {name, qty}).\n`;

    tasks.push({
      id: `spec-format2-${i}`,
      split,
      title: "Produce semicolon report with header",
      prompt: "Read `spec.md` and `products.json` in the current directory. Follow `spec.md` exactly and produce `output.txt`.",
      sandbox: {
        "spec.md": spec,
        "products.json": JSON.stringify(products, null, 2),
      },
      grader: { type: "exact", file: "output.txt", expected },
    });
  }

  // 3. Format 3: filter status==active, sort by qty desc
  const fmt3Configs: Array<[Split, string, number]> = [
    ["train", "active", 1],
    ["val", "active", 2],
  ];
  for (const [split, status, i] of fmt3Configs) {
    const items = [];
    const pool = ["red", "green", "blue", "yellow", "purple", "orange", "cyan", "magenta"];
    for (let p = 0; p < 9; p++) {
      items.push({
        name: rng.choice(pool),
        qty: rng.randint(0, 60),
        status: rng.choice(["active", "archived"]),
      });
    }
    const kept = items
      .filter((p) => p.status === status)
      .sort((a, b) => b.qty - a.qty);
    const expected = kept.map((p) => `${p.name}|${p.qty}`).join("\n");
    const spec =
      `# Output specification\n` +
      `Write the deliverable to \`output.txt\`:\n` +
      `- only products with status == '${status}'\n` +
      `- sorted by quantity DESCENDING (highest first)\n` +
      `- each line: NAME|QTY (pipe-separated, no spaces)\n` +
      `- no header, no trailing blank lines\n\n` +
      `Data: \`items.json\` (list of {name, qty, status}).\n`;

    tasks.push({
      id: `spec-format3-${i}`,
      split,
      title: "Filter and sort items by spec",
      prompt: "Read `spec.md` and `items.json` in the current directory. Follow `spec.md` exactly and produce `output.txt`.",
      sandbox: {
        "spec.md": spec,
        "items.json": JSON.stringify(items, null, 2),
      },
      grader: { type: "exact", file: "output.txt", expected },
    });
  }

  // 4. Log extraction: ERROR lines to timestamps
  for (const [split, i] of [["train", 1], ["val", 2]] as Array<[Split, number]>) {
    const logLines = [];
    const errorLines = [];
    for (let l = 0; l < 10; l++) {
      const ts = `2026-08-${String(rng.randint(1, 28)).padStart(2, "0")} ${String(rng.randint(0, 23)).padStart(2, "0")}:${String(rng.randint(0, 59)).padStart(2, "0")}`;
      const level = rng.choice(["INFO", "ERROR", "WARN", "DEBUG"]);
      const msg = `Module-${rng.choice(["auth", "db", "api", "cache"])} event code ${rng.randint(100, 999)}`;
      logLines.push(`[${ts}] [${level}] ${msg}`);
      if (level === "ERROR") {
        errorLines.push(`${ts}|${msg}`);
      }
    }
    const expected = errorLines.sort().join("\n");
    tasks.push({
      id: `extract-logs-${i}`,
      split,
      title: "Extract error log entries",
      prompt: "Extract all lines with level [ERROR] from `server.log`. Save them to `output.txt` formatted as 'TIMESTAMP|MESSAGE', sorted ascending by timestamp.",
      sandbox: {
        "server.log": logLines.join("\n"),
      },
      grader: { type: "exact", file: "output.txt", expected },
    });
  }

  // 5. Code execution: Simple calculation script
  for (const [split, i] of [["train", 1], ["val", 2]] as Array<[Split, number]>) {
    const numbers = Array.from({ length: 6 }, () => rng.randint(1, 50));
    const sumEven = numbers.filter((n) => n % 2 === 0).reduce((a, b) => a + b, 0);
    tasks.push({
      id: `calc-even-sum-${i}`,
      split,
      title: "Compute sum of even numbers",
      prompt: "Read `numbers.json`. Calculate the sum of all even numbers and write ONLY the integer result to `output.txt`.",
      sandbox: {
        "numbers.json": JSON.stringify(numbers),
      },
      grader: { type: "exact", file: "output.txt", expected: String(sumEven) },
    });
  }

  return tasks;
}

export function loadTasks(workspaceDir: string): Task[] {
  const tasksFile = path.join(workspaceDir, "bench", "tasks.json");
  if (!fs.existsSync(tasksFile)) {
    throw new Error(`Tasks benchmark file not found at: ${tasksFile}`);
  }
  const content = fs.readFileSync(tasksFile, "utf8");
  return JSON.parse(content) as Task[];
}

export function saveTasks(workspaceDir: string, tasks: Task[]): void {
  const benchDir = path.join(workspaceDir, "bench");
  if (!fs.existsSync(benchDir)) {
    fs.mkdirSync(benchDir, { recursive: true });
  }
  fs.writeFileSync(path.join(benchDir, "tasks.json"), JSON.stringify(tasks, null, 2), "utf8");
}

export function setupTaskSandbox(task: Task, targetDir: string): void {
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  fs.mkdirSync(targetDir, { recursive: true });

  for (const [relPath, content] of Object.entries(task.sandbox)) {
    const fullPath = path.join(targetDir, relPath);
    const parentDir = path.dirname(fullPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    fs.writeFileSync(fullPath, content, "utf8");
  }
}
