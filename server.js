import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { MODEL, WEB_TOOLS, runStreaming, runParse, extractJsonBlock, apiErrorMessage } from "./lib/claude.js";
import { EXPERT_SYSTEM, MODE_HINTS, PLAQUE_SYSTEM, DOCS_SYSTEM, CODE_SYSTEM, PIECES_SYSTEM } from "./lib/prompts.js";
import { findCodes, normalizeCode, MARQUES } from "./lib/codes.js";
import fs from "node:fs";
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
    res.set("WWW-Authenticate", 'Basic realm="OThermia"').status(401).send("Authentification requise");
  });
}

// --- Identité visuelle de l'entreprise (modifiable depuis l'écran Paramètres) ---
const BRAND_FILE = path.join(store.DATA_DIR, "brand.json");
const BRAND_DEFAULT = {
  nom: "O'Thermia",
  slogan: "Plomberie · Chauffage · Climatisation",
  couleurPrimaire: "#082da0",
  couleurAccent: "#b70b2c",
  telephone: "",
  email: "",
  adresse: "",
  site: "",
};
const readBrand = () => ({
  ...BRAND_DEFAULT,
  ...(fs.existsSync(BRAND_FILE) ? JSON.parse(fs.readFileSync(BRAND_FILE, "utf8")) : {}),
});
const LOGO_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const customLogo = () =>
  Object.values(LOGO_TYPES)
    .map((ext) => path.join(store.BRAND_DIR, `logo.${ext}`))
    .find((f) => fs.existsSync(f));

app.get("/brand/logo", (_req, res) => {
  res.set("Cache-Control", "no-cache");
  res.sendFile(customLogo() || path.join(here, "public/brand/logo.png"));
});
app.get("/manifest.webmanifest", (_req, res) => {
  const b = readBrand();
  const logo = customLogo();
  res.type("application/manifest+json").send(
    JSON.stringify({
      name: `${b.nom} – Dépannage CVC`,
      short_name: b.nom,
      description: "Diagnostic de pannes, codes erreur, documentations et calculs pour PAC, climatisation et chaudières.",
      lang: "fr",
      start_url: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: b.couleurPrimaire,
      icons: logo
        ? [{ src: "/brand/logo", sizes: "512x512", type: `image/${path.extname(logo).slice(1).replace("jpg", "jpeg")}`, purpose: "any" }]
        : [
            { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
            { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
          ],
    }),
  );
});

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

app.get("/api/brand", (_req, res) => res.json({ ...readBrand(), logoPerso: Boolean(customLogo()) }));
app.put("/api/brand", (req, res) => {
  const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
  const brand = z
    .object({
      nom: z.string().max(80),
      slogan: z.string().max(160),
      couleurPrimaire: color,
      couleurAccent: color,
      telephone: z.string().max(40),
      email: z.string().max(120),
      adresse: z.string().max(240),
      site: z.string().max(160),
    })
    .partial()
    .safeParse(req.body);
  if (!brand.success) return res.status(400).json({ error: "Données invalides (couleurs au format #RRGGBB)." });
  const next = { ...readBrand(), ...brand.data };
  delete next.logoPerso;
  fs.writeFileSync(BRAND_FILE, JSON.stringify(next, null, 2));
  res.json(next);
});
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 } });
app.post("/api/brand/logo", logoUpload.single("logo"), (req, res) => {
  const ext = req.file && LOGO_TYPES[req.file.mimetype];
  if (!ext) return res.status(400).json({ error: "Logo attendu au format PNG, JPEG ou WebP (3 Mo maxi)." });
  for (const e of Object.values(LOGO_TYPES)) fs.rmSync(path.join(store.BRAND_DIR, `logo.${e}`), { force: true });
  fs.writeFileSync(path.join(store.BRAND_DIR, `logo.${ext}`), req.file.buffer);
  res.json({ ok: true });
});
app.delete("/api/brand/logo", (_req, res) => {
  for (const e of Object.values(LOGO_TYPES)) fs.rmSync(path.join(store.BRAND_DIR, `logo.${e}`), { force: true });
  res.json({ ok: true });
});

// --- Base de codes erreur (enrichie à chaque recherche, consultable hors ligne) ---
app.get("/api/marques", (_req, res) => {
  const known = new Set(MARQUES);
  for (const e of store.list("equipements")) if (e.fabricant) known.add(e.fabricant);
  for (const c of store.list("codes")) if (c.marque) known.add(c.marque);
  res.json([...known].sort((a, b) => a.localeCompare(b, "fr")));
});

app.get("/api/codes", (req, res) => {
  res.json(findCodes({ marque: req.query.marque, code: req.query.code, q: req.query.q }));
});

app.patch("/api/codes/:id", (req, res) => {
  const patch = {};
  if (typeof req.body?.favori === "boolean") patch.favori = req.body.favori;
  if (typeof req.body?.notes === "string") patch.notes = req.body.notes.slice(0, 5000);
  const item = store.update("codes", req.params.id, patch);
  item ? res.json(item) : res.status(404).json({ error: "Introuvable" });
});
app.delete("/api/codes/:id", (req, res) => res.json({ ok: store.remove("codes", req.params.id) }));

app.post(
  "/api/codes/recherche",
  wrap(async (req, res) => {
    const q = z
      .object({ marque: z.string().min(1).max(80), modele: z.string().max(120).default(""), code: z.string().min(1).max(40) })
      .parse(req.body);
    const emit = sse(res);
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    const { context, sources } = buildDocContext(`${q.code} ${q.modele}`, { fabricant: q.marque, modele: q.modele });
    if (sources.length) emit({ type: "sources", sources });
    const text = await runStreaming({
      system: CODE_SYSTEM,
      messages: [
        {
          role: "user",
          content: `${context ? `<extraits_documentation>\n${context}\n</extraits_documentation>\n\n` : ""}Marque : ${q.marque}\nModèle : ${q.modele || "non précisé"}\nCode défaut : ${q.code}`,
        },
      ],
      tools: WEB_TOOLS(6, 3),
      effort: "medium",
      emit,
      signal: controller.signal,
    });
    const fiche = extractJsonBlock(text);
    if (fiche && typeof fiche === "object" && !Array.isArray(fiche)) {
      const saved = store.insert("codes", {
        ...fiche,
        marque: fiche.marque || q.marque,
        modele: fiche.modele || q.modele,
        code: fiche.code || q.code,
        codeNorm: normalizeCode(fiche.code || q.code),
        docsLocales: sources.slice(0, 5).map(({ docId, titre, page }) => ({ docId, titre, page })),
        favori: false,
      });
      emit({ type: "fiche", fiche: saved });
    } else emit({ type: "error", text: "Fiche non structurée : consultez le texte ci-dessus." });
    emit({ type: "done" });
    res.end();
  }),
);

// --- Pièces détachées ---
app.post(
  "/api/pieces/trouver",
  wrap(async (req, res) => {
    const q = z
      .object({
        marque: z.string().max(80).default(""),
        modele: z.string().max(160).default(""),
        piece: z.string().min(2).max(300),
      })
      .parse(req.body);
    const emit = sse(res);
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    const text = await runStreaming({
      system: PIECES_SYSTEM,
      messages: [{ role: "user", content: `Appareil : ${q.marque} ${q.modele}\nPièce recherchée : ${q.piece}` }],
      tools: WEB_TOOLS(8, 4),
      effort: "medium",
      emit,
      signal: controller.signal,
    });
    const found = extractJsonBlock(text);
    emit({
      type: "result",
      pieces: Array.isArray(found) ? found.map((p) => ({ ...p, url: /^https?:\/\//.test(p?.url) ? p.url : "" })) : [],
    });
    emit({ type: "done" });
    res.end();
  }),
);

app.get("/api/pieces", (_req, res) => res.json(store.list("pieces")));
app.post("/api/pieces", (req, res) => {
  const p = z
    .object({
      designation: z.string().min(1).max(300),
      reference: z.string().max(120).default(""),
      quantite: z.number().int().min(1).max(999).default(1),
      url: z.string().max(1000).default(""),
      source: z.string().max(120).default(""),
      prix: z.string().max(60).default(""),
      equipementId: z.string().max(40).default(""),
      statut: z.enum(["a_commander", "commandee", "recue", "posee"]).default("a_commander"),
    })
    .safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "Données invalides." });
  res.json(store.insert("pieces", p.data));
});
app.patch("/api/pieces/:id", (req, res) => {
  const allowed = ["statut", "quantite", "reference", "designation", "equipementId"];
  const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  const item = store.update("pieces", req.params.id, patch);
  item ? res.json(item) : res.status(404).json({ error: "Introuvable" });
});
app.delete("/api/pieces/:id", (req, res) => res.json({ ok: store.remove("pieces", req.params.id) }));

// --- Recherche globale (accueil) ---
app.get("/api/recherche", (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json({ codes: [], docs: [], equipements: [] });
  const needle = q.toLowerCase();
  res.json({
    codes: findCodes({ q }).slice(0, 15),
    docs: searchDocuments(q, { limit: 8 }).map(({ texte, ...rest }) => rest),
    equipements: store
      .list("equipements")
      .filter((e) => JSON.stringify(e).toLowerCase().includes(needle))
      .slice(0, 10),
  });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`O'Thermia prêt sur http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN)
    console.warn("⚠ ANTHROPIC_API_KEY non défini : l'assistant, le scan et la recherche web ne fonctionneront pas.");
  if (!PASSWORD) console.warn("⚠ APP_PASSWORD non défini : l'application est accessible sans mot de passe.");
});
