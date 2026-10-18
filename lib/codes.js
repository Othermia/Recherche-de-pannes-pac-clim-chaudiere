import { normalize } from "./docs.js";
import { list } from "./store.js";

/** « E-09 », « e 09 », « F.28 » → « E9 », « F28 » : forme canonique d'un code défaut. */
export function normalizeCode(code) {
  return String(code || "")
    .toUpperCase()
    .replace(/[\s.\-_/]/g, "")
    .replace(/^([A-Z]+)0+(?=\d)/, "$1");
}

export const normalizeBrand = (marque) => normalize(String(marque || "")).replace(/[^a-z0-9]/g, "");

/** Fiches de codes déjà connues pour une marque et un code. */
export function findCodes({ marque, code, q } = {}) {
  const b = normalizeBrand(marque);
  const c = normalizeCode(code);
  const terms = q ? normalize(q).split(/\s+/).filter(Boolean) : [];
  return list("codes").filter((f) => {
    if (b && !normalizeBrand(f.marque).includes(b)) return false;
    if (c && f.codeNorm !== c) return false;
    if (terms.length) {
      const hay = normalize(`${f.marque} ${f.modele} ${f.code} ${f.codeNorm} ${f.titre} ${f.organe}`);
      return terms.every((t) => hay.includes(t) || normalizeCode(t) === f.codeNorm);
    }
    return true;
  });
}

// Marques courantes en France (PAC, clim, chaudières, ballons).
export const MARQUES = [
  "Airwell", "Aldes", "Ariston", "Atlantic", "Auer", "Baxi", "Bosch", "Bulex", "Buderus", "Carrier", "Chaffoteaux",
  "Chappée", "Clivet", "Cuenod", "Daikin", "De Dietrich", "Elco", "ELM Leblanc", "Ferroli", "Frisquet", "Fujitsu",
  "Geminox", "Gree", "Haier", "Hermann", "Hisense", "Hitachi", "Immergas", "Lennox", "LG", "Midea",
  "Mitsubishi Electric", "Mitsubishi Heavy Industries", "Nibe", "Oertli", "Panasonic", "Remeha", "Riello", "Rotex",
  "Samsung", "Saunier Duval", "Sime", "Stiebel Eltron", "Thermor", "Toshiba", "Unical", "Vaillant", "Viessmann",
  "Waterkotte", "Weishaupt", "Wolf", "Ygnis",
];
