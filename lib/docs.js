import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { createRequire } from "node:module";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { DOCS_DIR, TEXT_DIR, insert, list, get, remove } from "./store.js";

const MAX_PDF_BYTES = 80 * 1024 * 1024;
const PDFJS_DIR = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const STANDARD_FONTS = path.join(PDFJS_DIR, "standard_fonts") + path.sep;

export function normalize(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b([a-z]{1,3})[-.](\d{1,4})\b/g, "$1$2") // « E-09 », « F.28 » → « e09 », « f28 »
    .replace(/\b([a-z]{1,3})0+(\d)/g, "$1$2"); // « e09 » ≡ « e9 »
}

const STOP = new Set(
  "le la les de des du un une et ou a au aux en sur pour par avec dans est sont pas ne que qui quoi the and of for to in on code erreur panne defaut probleme".split(" "),
);

export function tokenize(text) {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export async function extractPages(buffer) {
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    standardFontDataUrl: STANDARD_FONTS,
    verbosity: 0,
  });
  const doc = await task.promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = "";
    for (const item of content.items) {
      if ("str" in item) text += item.str + (item.hasEOL ? "\n" : " ");
    }
    pages.push(text.replace(/[ \t]+/g, " ").trim());
    page.cleanup();
  }
  await task.destroy();
  return pages;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const v6 = ip.toLowerCase();
  return v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") || v6.startsWith("::ffff:127.");
}

async function assertPublicUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Seuls les liens http(s) sont acceptés.");
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (addresses.some((a) => isPrivateIp(a.address))) throw new Error("Adresse réseau non autorisée.");
  return url;
}

export async function downloadPdf(rawUrl) {
  let url = await assertPublicUrl(rawUrl);
  let res;
  for (let hop = 0; hop < 5; hop++) {
    res = await fetch(url, {
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0 (CVC-Doctor documentation fetcher)", Accept: "application/pdf,*/*" },
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = await assertPublicUrl(new URL(res.headers.get("location"), url).href);
      continue;
    }
    break;
  }
  if (!res.ok) throw new Error(`Téléchargement impossible (HTTP ${res.status}).`);
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > MAX_PDF_BYTES) throw new Error("Fichier trop volumineux (> 80 Mo).");
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_PDF_BYTES) throw new Error("Fichier trop volumineux (> 80 Mo).");
  if (buffer.subarray(0, 5).toString() !== "%PDF-")
    throw new Error("Le lien ne pointe pas directement vers un PDF (page web ou accès restreint).");
  return buffer;
}

/** Enregistre un PDF dans la bibliothèque et indexe son texte. */
export async function addDocument(buffer, meta) {
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const existing = list("docs").find((d) => d.sha256 === sha256);
  if (existing) return { doc: existing, duplicate: true };

  let pages = [];
  try {
    pages = await extractPages(buffer);
  } catch (err) {
    console.warn("Extraction texte PDF impossible :", err.message);
  }
  const doc = insert("docs", {
    titre: meta.titre || "Document sans titre",
    type: meta.type || "autre",
    fabricant: meta.fabricant || "",
    modele: meta.modele || "",
    langue: meta.langue || "",
    sourceUrl: meta.sourceUrl || "",
    equipementId: meta.equipementId || "",
    sha256,
    taille: buffer.length,
    pages: pages.length,
    texteIndexe: pages.some((p) => p.length > 20),
  });
  fs.writeFileSync(path.join(DOCS_DIR, `${doc.id}.pdf`), buffer);
  fs.writeFileSync(path.join(TEXT_DIR, `${doc.id}.json`), JSON.stringify(pages));
  return { doc, duplicate: false };
}

export function deleteDocument(id) {
  for (const f of [path.join(DOCS_DIR, `${id}.pdf`), path.join(TEXT_DIR, `${id}.json`)]) fs.rmSync(f, { force: true });
  return remove("docs", id);
}

export const pdfPath = (id) => path.join(DOCS_DIR, `${id}.pdf`);

const pageCache = new Map();
function loadPages(id) {
  if (!pageCache.has(id)) {
    const file = path.join(TEXT_DIR, `${id}.json`);
    const pages = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
    pageCache.set(id, { pages, norm: pages.map(normalize) });
  }
  return pageCache.get(id);
}
export function forgetPages(id) {
  pageCache.delete(id);
}

/**
 * Recherche plein texte dans les PDF indexés.
 * Les termes contenant un chiffre (codes erreur, références) pèsent plus lourd.
 */
export function searchDocuments(query, { docIds, limit = 10 } = {}) {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return [];
  const docs = list("docs").filter((d) => !docIds || docIds.includes(d.id));
  const hits = [];

  for (const doc of docs) {
    const { pages, norm } = loadPages(doc.id);
    norm.forEach((text, i) => {
      let score = 0;
      let firstPos = -1;
      for (const term of terms) {
        const re = new RegExp(`(?<![a-z0-9])${term}(?![a-z0-9])`, "g");
        const count = (text.match(re) || []).length;
        if (!count) continue;
        const weight = /\d/.test(term) ? 5 : 1;
        score += weight * (1 + Math.log(count));
        if (firstPos < 0 || weight > 1) {
          const pos = text.search(re);
          if (firstPos < 0 || pos < firstPos || weight > 1) firstPos = pos;
        }
      }
      if (score > 0) {
        const start = Math.max(0, firstPos - 250);
        hits.push({
          docId: doc.id,
          titre: doc.titre,
          page: i + 1,
          score,
          extrait: (start > 0 ? "…" : "") + pages[i].slice(start, start + 600) + "…",
          texte: pages[i],
        });
      }
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Construit le contexte documentaire injecté dans le diagnostic. */
export function buildDocContext(query, equipement) {
  let docIds;
  if (equipement) {
    const fab = normalize(equipement.fabricant || "");
    const linked = list("docs").filter(
      (d) => d.equipementId === equipement.id || (fab && normalize(d.fabricant).includes(fab)),
    );
    if (linked.length) docIds = linked.map((d) => d.id);
  }
  const extra = equipement ? `${equipement.modele || ""}` : "";
  const hits = searchDocuments(`${query} ${extra}`, { docIds, limit: 6 });
  let budget = 18000;
  const parts = [];
  for (const h of hits) {
    const text = h.texte.slice(0, Math.min(3500, budget));
    if (!text) break;
    budget -= text.length;
    parts.push(`<extrait document="${h.titre}" page="${h.page}">\n${text}\n</extrait>`);
  }
  return { context: parts.join("\n\n"), sources: hits.map(({ texte, ...rest }) => rest) };
}

export function getDoc(id) {
  return get("docs", id);
}
