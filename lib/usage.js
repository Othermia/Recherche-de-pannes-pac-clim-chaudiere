import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./store.js";

const FILE = path.join(DATA_DIR, "consommation.jsonl");

// Tarifs en $ par million de tokens : entrée, sortie, lecture cache, écriture cache (5 min).
const TARIFS = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-opus-5": [5, 25, 0.5, 6.25],
  "claude-opus-4-8": [5, 25, 0.5, 6.25],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};
const WEB_SEARCH_USD = 0.01; // 10 $ les 1 000 recherches

export function costOf(model, usage) {
  const [pin, pout, pread, pwrite] = TARIFS[model] || TARIFS["claude-opus-5-5"];
  const searches = usage.server_tool_use?.web_search_requests || 0;
  return (
    ((usage.input_tokens || 0) * pin +
      (usage.output_tokens || 0) * pout +
      (usage.cache_read_input_tokens || 0) * pread +
      (usage.cache_creation_input_tokens || 0) * pwrite) /
      1e6 +
    searches * WEB_SEARCH_USD
  );
}

/** Enregistre la consommation d'une réponse et renvoie son coût en $. */
export function record(task, message) {
  const u = message.usage || {};
  const cost = costOf(message.model, u);
  const line = {
    t: new Date().toISOString(),
    task,
    model: message.model,
    in: u.input_tokens || 0,
    out: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
    search: u.server_tool_use?.web_search_requests || 0,
    cost,
  };
  fs.appendFileSync(FILE, JSON.stringify(line) + "\n");
  return cost;
}

function readAll() {
  if (!fs.existsSync(FILE)) return [];
  return fs
    .readFileSync(FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const monthKey = (d) => d.slice(0, 7);

export function monthCost(now = new Date()) {
  const m = now.toISOString().slice(0, 7);
  return readAll()
    .filter((l) => monthKey(l.t) === m)
    .reduce((s, l) => s + l.cost, 0);
}

/** Synthèse : aujourd'hui, mois en cours (par type d'action), mois précédent. */
export function summary(now = new Date()) {
  const lines = readAll();
  const day = now.toISOString().slice(0, 10);
  const month = now.toISOString().slice(0, 7);
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const sum = (arr) => ({ cost: arr.reduce((s, l) => s + l.cost, 0), appels: arr.length });
  const thisMonth = lines.filter((l) => monthKey(l.t) === month);
  const parTache = {};
  for (const l of thisMonth) {
    parTache[l.task] ??= { cost: 0, appels: 0 };
    parTache[l.task].cost += l.cost;
    parTache[l.task].appels += 1;
  }
  return {
    jour: sum(lines.filter((l) => l.t.startsWith(day))),
    mois: sum(thisMonth),
    moisPrecedent: sum(lines.filter((l) => monthKey(l.t) === prev)),
    parTache,
  };
}
