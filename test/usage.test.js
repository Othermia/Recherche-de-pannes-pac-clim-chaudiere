import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "othermia-test-"));
delete process.env.CLAUDE_MODEL;
const { costOf, record, summary, monthCost } = await import("../lib/usage.js");
const { modelFor, writeSettings } = await import("../lib/settings.js");

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≉ ${b}`);

test("coût Opus 5.5 : 4 $/M en entrée, 20 $/M en sortie, 0,01 $ par recherche web", () => {
  near(costOf("claude-opus-5-5", { input_tokens: 1e6, output_tokens: 1e6, server_tool_use: { web_search_requests: 3 } }), 24.03);
});

test("coût Sonnet 5.5 deux fois moins cher qu'Opus 5.5", () => {
  const u = { input_tokens: 40000, output_tokens: 5000 };
  near(costOf("claude-sonnet-5-5", u) * 2, costOf("claude-opus-5-5", u));
});

test("cache : lecture 0,20 $/M, écriture 1,25 × entrée", () => {
  near(costOf("claude-opus-5-5", { cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 }), 5.2);
});

test("enregistrement et synthèse du mois", () => {
  record("code", { model: "claude-opus-5-5", usage: { input_tokens: 10000, output_tokens: 2000 } });
  record("diagnostic", { model: "claude-sonnet-5-5", usage: { input_tokens: 10000, output_tokens: 2000 } });
  const s = summary();
  assert.equal(s.mois.appels, 2);
  near(s.mois.cost, 0.08 + 0.04);
  near(monthCost(), s.mois.cost);
  assert.equal(s.parTache.code.appels, 1);
});

test("profils de modèle", () => {
  writeSettings({ profil: "mixte" });
  assert.equal(modelFor("diagnostic"), "claude-opus-5-5");
  assert.equal(modelFor("code"), "claude-sonnet-5-5");
  writeSettings({ profil: "economique" });
  assert.equal(modelFor("diagnostic"), "claude-sonnet-5-5");
});
