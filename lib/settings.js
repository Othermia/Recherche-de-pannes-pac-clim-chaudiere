import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./store.js";

const FILE = path.join(DATA_DIR, "reglages.json");

// Profils de modèle : quel modèle pour quelle tâche.
export const PROFILS = {
  expert: { label: "Expert (Opus 5.5)", diagnostic: "claude-opus-5-5", recherche: "claude-opus-5-5" },
  mixte: {
    label: "Mixte (Opus diagnostic, Sonnet recherches)",
    diagnostic: "claude-opus-5-5",
    recherche: "claude-sonnet-5-5",
  },
  economique: { label: "Économique (Sonnet 5.5)", diagnostic: "claude-sonnet-5-5", recherche: "claude-sonnet-5-5" },
};

const DEFAULTS = { profil: "expert", budgetMensuel: 0 };

export function readSettings() {
  const saved = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : {};
  const s = { ...DEFAULTS, ...saved };
  if (!PROFILS[s.profil]) s.profil = DEFAULTS.profil;
  return s;
}

export function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  return next;
}

/** Modèle à utiliser : CLAUDE_MODEL force un modèle unique, sinon le profil choisi. */
export function modelFor(task) {
  if (process.env.CLAUDE_MODEL) return process.env.CLAUDE_MODEL;
  const p = PROFILS[readSettings().profil];
  return task === "diagnostic" ? p.diagnostic : p.recherche;
}
