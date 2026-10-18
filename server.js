import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { MODEL, WEB_TOOLS, runStreaming, runParse, extractJsonBlock, apiErrorMessage } from "./lib/claude.js";
import { EXPERT_SYSTEM, MODE_HINTS, PLAQUE_SYSTEM, DOCS_SYSTEM } from "./lib/prompts.js";
import * as store from "./lib/store.js";
import {
  addDocument,
  deleteDocument,
  downloadPdf,
  pdfPath,
  searchDocuments,
  buildDocContext,
  getDoc,
  forgetPages,
} from "./lib/docs.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "25mb" }));

// --- Accès protégé par mot de passe (HTTP Basic) si APP_PASSWORD est défini ---
const PASSWORD = process.env.APP_PASSWORD;
if (PASSWORD) {
  const expected = crypto.createHash("sha256").update(PASSWORD).digest();
  app.use((req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization || "").split(" ");
    if (scheme === "Basic" && encoded) {
      const pass = Buffer.from(encoded, "base64").toString().split(":").slice(1).join(":");
      const given = crypto.createHash("sha256").update(pass).digest();
      if (crypto.timingSafeEqual(given, expected)) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="CVC Doctor"').status(401).send("Authentification requise");
  });
}

app.use(express.static(path.join(here, "public")));
app.get("/vendor/marked.js", (_req, res) => res.sendFile(path.join(here, "node_modules/marked/lib/marked.esm.js")));
app.get("/vendor/purify.js", (_req, res) => res.sendFile(path.join(here, "node_modules/dompurify/dist/purify.es.mjs")));

// --- Utilitaires ---
function sse(res) {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  return (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
}

const imageSchema = z.object({
  media_type: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
  data: z.string().min(10),
});

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error(err);
    const message = err instanceof z.ZodError ? "Données invalides." : apiErrorMessage(err);
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ type: "error", text: message })}\n\n`);
      res.end();
    } else res.status(400).json({ error: message });
  }
};

function equipementSummary(e) {
  if (!e) return "";
  const fields = Object.entries(e)
    .filter(([k, v]) => v && !["id", "createdAt", "updatedAt", "historique"].includes(k))
    .map(([k, v]) => `- ${k} : ${typeof v === "object" ? JSON.stringify(v) : v}`);
  return `<equipement>\n${fields.join("\n")}\n</equipement>`;
}

app.get("/api/status", (_req, res) => {
  res.json({ apiKey: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN), model: MODEL });
});

// --- Assistant expert (diagnostic / paramétrage / question) ---
const chatSchema = z.object({
  mode: z.enum(["diagnostic", "parametrage", "question"]).default("diagnostic"),
  equipementId: z.string().optional(),
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(100_000) }))
    .min(1)
    .max(80),
  images: z.array(imageSchema).max(4).default([]),
});

app.post(
  "/api/chat",
  wrap(async (req, res) => {
    const body = chatSchema.parse(req.body);
    const equipement = body.equipementId ? store.get("equipements", body.equipementId) : null;
    const lastUser = body.messages.at(-1).content;
    const recentUser = body.messages
      .filter((m) => m.role === "user")
      .slice(-3)
      .map((m) => m.content)
      .join(" ");
    const { context, sources } = buildDocContext(recentUser, equipement);

    const contextText = [
      MODE_HINTS[body.mode],
      equipementSummary(equipement),
      context
        ? `Extraits de la bibliothèque de documentations du technicien (sources prioritaires) :\n${context}`
        : "Aucun extrait pertinent dans la bibliothèque locale : utilise la recherche web pour vérifier les données constructeur.",
    ]
      .filter(Boolean)
      .join("\n\n");

    const messages = body.messages.map((m) => ({ role: m.role, content: m.content }));
    messages[messages.length - 1] = {
      role: "user",
      content: [
        ...body.images.map((img) => ({ type: "image", source: { type: "base64", ...img } })),
        { type: "text", text: `<contexte>\n${contextText}\n</contexte>\n\n${lastUser}` },
      ],
    };

    const emit = sse(res);
    if (sources.length) emit({ type: "sources", sources });
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    await runStreaming({
      system: EXPERT_SYSTEM,
      messages,
      tools: WEB_TOOLS(6, 4),
      effort: "high",
      emit,
      signal: controller.signal,
    });
    emit({ type: "done" });
    res.end();
  }),
);

// --- Lecture de plaque signalétique ---
const PlaqueSchema = z.object({
  type_equipement: z.string().describe("PAC air/eau, PAC air/air, climatiseur, chaudière gaz, unité extérieure, etc."),
  fabricant: z.string(),
  gamme: z.string(),
  modele: z.string().describe("désignation commerciale / modèle"),
  reference: z.string().describe("référence article ou code produit"),
  numero_serie: z.string(),
  annee_fabrication: z.string(),
  fluide_frigorigene: z.string(),
  charge_fluide: z.string().describe("charge en kg et éventuellement t éq. CO2"),
  puissance_calorifique: z.string(),
  puissance_frigorifique: z.string(),
  puissance_electrique: z.string(),
  alimentation_electrique: z.string().describe("tension, phases, fréquence, intensité max, calibre protection"),
  pressions_service: z.string().describe("PS/HP/BP, pression maxi eau, etc."),
  gaz_categorie: z.string().describe("pour chaudière : catégorie gaz, type B23/C13…, pression gaz"),
  indice_protection: z.string(),
  autres_infos: z.string().describe("autres mentions utiles"),
  confiance: z.enum(["haute", "moyenne", "faible"]).describe("lisibilité globale de la plaque"),
});

app.post(
  "/api/plaque",
  wrap(async (req, res) => {
    const { image } = z.object({ image: imageSchema }).parse(req.body);
    const data = await runParse({
      system: PLAQUE_SYSTEM,
      format: betaZodOutputFormat(PlaqueSchema),
      content: [
        { type: "image", source: { type: "base64", ...image } },
        { type: "text", text: "Extrais les informations de cette plaque signalétique." },
      ],
    });
    res.json(data);
  }),
);

// --- Parc d'équipements ---
app.get("/api/equipements", (_req, res) => res.json(store.list("equipements")));
app.post("/api/equipements", (req, res) => res.json(store.insert("equipements", req.body || {})));
app.patch("/api/equipements/:id", (req, res) => {
  const item = store.update("equipements", req.params.id, req.body || {});
  item ? res.json(item) : res.status(404).json({ error: "Introuvable" });
});
app.delete("/api/equipements/:id", (req, res) => res.json({ ok: store.remove("equipements", req.params.id) }));

// --- Documentations ---
app.get("/api/docs", (_req, res) => res.json(store.list("docs")));

app.get("/api/docs/recherche", (req, res) => {
  const hits = searchDocuments(String(req.query.q || ""), { limit: 30 });
  res.json(hits.map(({ texte, ...rest }) => rest));
});

app.get("/api/docs/:id/file", (req, res) => {
  const doc = getDoc(req.params.id);
  if (!doc) return res.status(404).send("Introuvable");
  res.type("application/pdf").sendFile(pdfPath(doc.id));
});

app.patch("/api/docs/:id", (req, res) => {
  const allowed = ["titre", "type", "fabricant", "modele", "langue", "equipementId"];
  const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  const doc = store.update("docs", req.params.id, patch);
  doc ? res.json(doc) : res.status(404).json({ error: "Introuvable" });
});

app.delete("/api/docs/:id", (req, res) => {
  forgetPages(req.params.id);
  res.json({ ok: deleteDocument(req.params.id) });
});

const metaSchema = z.object({
  titre: z.string().optional(),
  type: z.string().optional(),
  fabricant: z.string().optional(),
  modele: z.string().optional(),
  langue: z.string().optional(),
  equipementId: z.string().optional(),
});

app.post(
  "/api/docs/import",
  wrap(async (req, res) => {
    const { url, ...meta } = metaSchema.extend({ url: z.string().url() }).parse(req.body);
    const buffer = await downloadPdf(url);
    res.json(await addDocument(buffer, { ...meta, sourceUrl: url }));
  }),
);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 80 * 1024 * 1024 } });
app.post(
  "/api/docs/upload",
  upload.single("file"),
  wrap(async (req, res) => {
    if (!req.file) throw new Error("Aucun fichier reçu.");
    if (req.file.buffer.subarray(0, 5).toString() !== "%PDF-") throw new Error("Le fichier n'est pas un PDF.");
    const meta = metaSchema.parse(req.body);
    res.json(await addDocument(req.file.buffer, { titre: req.file.originalname.replace(/\.pdf$/i, ""), ...meta }));
  }),
);

// Recherche de documentations sur le web pour un équipement
app.post(
  "/api/docs/trouver",
  wrap(async (req, res) => {
    const q = z
      .object({
        fabricant: z.string().default(""),
        modele: z.string().default(""),
        reference: z.string().default(""),
        type_equipement: z.string().default(""),
        besoin: z.string().default(""),
      })
      .parse(req.body);
    const emit = sse(res);
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    const text = await runStreaming({
      system: DOCS_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Trouve les documentations de cet équipement :
- Type : ${q.type_equipement || "?"}
- Fabricant : ${q.fabricant || "?"}
- Modèle / gamme : ${q.modele || "?"}
- Référence : ${q.reference || "?"}
${q.besoin ? `Besoin particulier : ${q.besoin}` : "Je veux toutes les notices utiles (installation, service, codes erreur, schémas, paramétrage)."}`,
        },
      ],
      tools: WEB_TOOLS(10, 6),
      effort: "medium",
      emit,
      signal: controller.signal,
    });
    const found = extractJsonBlock(text);
    emit({ type: "result", docs: Array.isArray(found) ? found.filter((d) => d && /^https?:\/\//.test(d.url)) : [] });
    emit({ type: "done" });
    res.end();
  }),
);

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`CVC Doctor prêt sur http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN)
    console.warn("⚠ ANTHROPIC_API_KEY non défini : l'assistant, le scan et la recherche web ne fonctionneront pas.");
  if (!PASSWORD) console.warn("⚠ APP_PASSWORD non défini : l'application est accessible sans mot de passe.");
});
