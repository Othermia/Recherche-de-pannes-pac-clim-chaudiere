import Anthropic from "@anthropic-ai/sdk";
import { DEMO, demoStreaming, demoParse } from "./demo.js";

export const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

// Repli automatique côté serveur si une requête est déclinée par un filtre de
// sécurité (catégories cyber/bio…), routé par Anthropic selon la catégorie.
const FALLBACK = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
};

let client;
export function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

export const WEB_TOOLS = (searchUses = 6, fetchUses = 4) => [
  { type: "web_search_20260209", name: "web_search", max_uses: searchUses },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: fetchUses },
];

/**
 * Lance une requête en streaming avec les outils web (exécutés côté serveur
 * Anthropic) et relance automatiquement sur `pause_turn`.
 * `emit(event)` reçoit {type:"text", text} | {type:"status", text}.
 * Retourne le texte complet de la réponse finale.
 */
export async function runStreaming({ system, messages, tools, effort = "high", emit, signal }) {
  if (DEMO) return demoStreaming({ system, messages, emit, signal });
  const convo = [...messages];
  let fullText = "";

  for (let round = 0; round < 6; round++) {
    const stream = getClient().beta.messages.stream(
      {
        ...FALLBACK,
        model: MODEL,
        max_tokens: 64000,
        thinking: { type: "adaptive" },
        output_config: { effort },
        cache_control: { type: "ephemeral" },
        system,
        tools,
        messages: convo,
      },
      { signal },
    );

    const toolInputs = new Map();
    for await (const event of stream) {
      if (event.type === "content_block_start") {
        const b = event.content_block;
        if (b.type === "server_tool_use") toolInputs.set(event.index, { name: b.name, json: "" });
        else if (b.type === "thinking") emit({ type: "status", text: "Analyse en cours…" });
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          fullText += event.delta.text;
          emit({ type: "text", text: event.delta.text });
        } else if (event.delta.type === "input_json_delta" && toolInputs.has(event.index)) {
          toolInputs.get(event.index).json += event.delta.partial_json;
        }
      } else if (event.type === "content_block_stop" && toolInputs.has(event.index)) {
        const { name, json } = toolInputs.get(event.index);
        let input = {};
        try {
          input = JSON.parse(json || "{}");
        } catch {}
        if (name === "web_search") emit({ type: "status", text: `Recherche web : ${input.query ?? ""}` });
        else if (name === "web_fetch") emit({ type: "status", text: `Lecture : ${input.url ?? ""}` });
      }
    }

    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") {
      emit({ type: "text", text: "\n\n_La demande a été refusée par le modèle. Reformulez la question._" });
      break;
    }
    if (message.stop_reason !== "pause_turn") break;
    convo.push({ role: "assistant", content: message.content });
  }
  return fullText;
}

/** Appel structuré (sortie JSON validée par un schéma Zod). */
export async function runParse({ system, content, format, effort = "medium" }) {
  if (DEMO) return demoParse();
  const response = await getClient().beta.messages.parse({
    ...FALLBACK,
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort, format },
    system,
    messages: [{ role: "user", content }],
  });
  if (response.stop_reason === "refusal") throw new Error("Demande refusée par le modèle.");
  return response.parsed_output;
}

/** Extrait le dernier bloc ```json d'un texte. */
export function extractJsonBlock(text) {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!matches.length) return null;
  try {
    return JSON.parse(matches.at(-1)[1]);
  } catch {
    return null;
  }
}

export function apiErrorMessage(err) {
  if (err instanceof Anthropic.AuthenticationError) return "Clé API Anthropic invalide ou absente (ANTHROPIC_API_KEY).";
  if (err instanceof Anthropic.RateLimitError) return "Limite de requêtes atteinte, réessayez dans un instant.";
  if (err instanceof Anthropic.BadRequestError) return `Requête invalide : ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Impossible de joindre l'API Anthropic (réseau).";
  if (err instanceof Anthropic.APIError) return `Erreur API (${err.status}) : ${err.message}`;
  return err?.message || String(err);
}
