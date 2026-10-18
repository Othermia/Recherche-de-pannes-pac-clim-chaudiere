// Calculs hydrauliques et de régulation. Fonctions pures, partagées
// entre le navigateur et les tests Node.

/** Masse volumique de l'eau (kg/m³), formule de Thiesen, T en °C. */
export function waterDensity(t) {
  return 1000 * (1 - ((t + 288.9414) / (508929.2 * (t + 68.12963))) * (t - 3.9863) ** 2);
}

/** Viscosité dynamique de l'eau (Pa·s), équation de Vogel, T en °C. */
export function waterViscosity(t) {
  return 2.414e-5 * 10 ** (247.8 / (t + 273.15 - 140));
}

// Fluides caloporteurs : ρ (kg/m³), cp (kJ/kg.K) approximatifs vers 20-40 °C ;
// visc = facteur multiplicatif de viscosité par rapport à l'eau.
export const FLUIDES = {
  eau: { label: "Eau", rho: null, cp: 4.18, visc: 1 },
  mpg20: { label: "Monopropylène glycol 20 %", rho: 1018, cp: 3.93, visc: 1.7 },
  mpg30: { label: "Monopropylène glycol 30 %", rho: 1027, cp: 3.85, visc: 2.4 },
  mpg40: { label: "Monopropylène glycol 40 %", rho: 1036, cp: 3.73, visc: 3.5 },
};

function fluidProps(fluide, t) {
  const f = FLUIDES[fluide] || FLUIDES.eau;
  const rho = f.rho ?? waterDensity(t);
  return { rho, cp: f.cp, mu: waterViscosity(t) * f.visc };
}

/**
 * Débit nécessaire pour transporter une puissance.
 * P en kW, ΔT en K → débit en m³/h, l/h, l/min.
 */
export function debit({ puissance, deltaT, fluide = "eau", temperature = 40 }) {
  if (!(puissance > 0) || !(deltaT > 0)) return null;
  const { rho, cp } = fluidProps(fluide, temperature);
  const m3s = puissance / (rho * cp * deltaT); // kW / (kg/m³ · kJ/kg.K · K) = m³/s
  const m3h = m3s * 3600;
  return { m3h, lh: m3h * 1000, lmin: (m3h * 1000) / 60, kgs: m3s * rho };
}

/** Puissance transportée par un débit mesuré. Q en m³/h, ΔT en K → kW. */
export function puissanceDepuisDebit({ debitM3h, deltaT, fluide = "eau", temperature = 40 }) {
  if (!(debitM3h > 0) || !(deltaT > 0)) return null;
  const { rho, cp } = fluidProps(fluide, temperature);
  return (debitM3h / 3600) * rho * cp * deltaT;
}

// Diamètres intérieurs (mm) et rugosité absolue (mm).
export const TUBES = {
  cuivre: {
    label: "Cuivre",
    rugosite: 0.0015,
    tailles: [
      ["10x1", 8], ["12x1", 10], ["14x1", 12], ["16x1", 14], ["18x1", 16], ["22x1", 20],
      ["28x1", 26], ["35x1,2", 32.6], ["42x1,2", 39.6], ["54x1,5", 51],
    ],
  },
  multicouche: {
    label: "Multicouche",
    rugosite: 0.007,
    tailles: [
      ["16x2", 12], ["20x2", 16], ["26x3", 20], ["32x3", 26], ["40x3,5", 33], ["50x4", 42], ["63x4,5", 54],
    ],
  },
  per: {
    label: "PER",
    rugosite: 0.007,
    tailles: [["12x1,1", 9.8], ["16x1,5", 13], ["20x1,9", 16.2], ["25x2,3", 20.4], ["32x2,9", 26.2]],
  },
  acier: {
    label: "Acier (tarif)",
    rugosite: 0.045,
    tailles: [
      ['3/8"', 12.5], ['1/2"', 16.1], ['3/4"', 21.7], ['1"', 27.3], ['1"1/4', 36], ['1"1/2', 41.9], ['2"', 53.1],
      ['2"1/2', 68.9],
    ],
  },
};

/** Coefficient de frottement de Darcy (laminaire ou Swamee-Jain). */
export function frictionFactor(re, relRough) {
  if (re < 2300) return 64 / re;
  return 0.25 / Math.log10(relRough / 3.7 + 5.74 / re ** 0.9) ** 2;
}

/**
 * Vitesse et perte de charge linéique dans un tube.
 * Q en m³/h, diamètre intérieur en mm → v (m/s), R (Pa/m), Re.
 */
export function perteCharge({ debitM3h, diametreMm, rugositeMm, fluide = "eau", temperature = 40 }) {
  const { rho, mu } = fluidProps(fluide, temperature);
  const d = diametreMm / 1000;
  const area = (Math.PI * d * d) / 4;
  const v = debitM3h / 3600 / area;
  const re = (rho * v * d) / mu;
  const f = frictionFactor(re, rugositeMm / diametreMm);
  const r = ((f / d) * rho * v * v) / 2;
  return { v, r, re, mceParM: r / (rho * 9.81) };
}

/** Évalue toutes les tailles d'un matériau et recommande la plus petite acceptable. */
export function dimensionnerTube({ debitM3h, materiau = "cuivre", fluide = "eau", temperature = 40, vMax = 1.0, rMax = 200 }) {
  const tube = TUBES[materiau];
  const lignes = tube.tailles.map(([nom, di]) => ({
    nom,
    di,
    ...perteCharge({ debitM3h, diametreMm: di, rugositeMm: tube.rugosite, fluide, temperature }),
  }));
  const conseil = lignes.find((l) => l.v <= vMax && l.r <= rMax);
  return { lignes, conseil: conseil?.nom ?? null };
}

/**
 * Loi d'eau physique fondée sur la caractéristique des émetteurs
 * (puissance ∝ ΔTm^n) à débit constant.
 * Retourne la température de départ et de retour pour une T extérieure.
 */
export function loiEauPoint({ text, tint, textBase, tdepBase, deltaTBase, n }) {
  const charge = Math.max(0, (tint - text) / (tint - textBase));
  const dtmBase = tdepBase - deltaTBase / 2 - tint;
  const dtm = dtmBase * charge ** (1 / n);
  const dt = deltaTBase * charge;
  const depart = tint + dtm + dt / 2;
  return { charge, depart, retour: depart - dt };
}

export const EMETTEURS = {
  plancher: { label: "Plancher chauffant", n: 1.1, deltaT: 5, depart: 35 },
  radiateurs_bt: { label: "Radiateurs basse température", n: 1.3, deltaT: 7, depart: 45 },
  radiateurs: { label: "Radiateurs acier/fonte (HT)", n: 1.3, deltaT: 15, depart: 70 },
  ventilo: { label: "Ventilo-convecteurs", n: 1.0, deltaT: 5, depart: 45 },
};

/**
 * Courbe de chauffe complète + paramètres équivalents pour les régulations
 * « pente / parallèle » et « 2 points ».
 */
export function loiEau({ textBase, tint, tdepBase, deltaTBase, n, textArret = 16, tdepMin = 20, tdepMax = 80, pas = 1 }) {
  const params = { tint, textBase, tdepBase, deltaTBase, n };
  const points = [];
  for (let te = Math.ceil(textBase - 5); te <= textArret; te += pas) {
    const p = loiEauPoint({ ...params, text: te });
    points.push({
      text: te,
      depart: Math.min(tdepMax, Math.max(tdepMin, p.depart)),
      departBrut: p.depart,
      retour: p.retour,
      charge: p.charge,
    });
  }
  const at = (te) => loiEauPoint({ ...params, text: te }).depart;
  // Pente linéaire équivalente entre T base et +15 °C (usage courant des régulations).
  const pente = (at(textBase) - at(15)) / (15 - textBase);
  // Pente « constructeur » rapportée à l'ambiance : (Tdep - Tint) / (Tint - Text)
  const penteAmbiance = (tdepBase - tint) / (tint - textBase);
  return {
    points,
    pente,
    penteAmbiance,
    deuxPoints: [
      { text: textBase, depart: at(textBase) },
      { text: 15, depart: at(15) },
    ],
    pointsCles: [-15, -10, -7, -5, 0, 5, 10, 15].filter((t) => t >= textBase - 5).map((t) => ({ text: t, depart: at(t) })),
  };
}

/**
 * Vase d'expansion fermé.
 * volume en L, hauteur statique en m, pression soupape en bar.
 */
export function vaseExpansion({ volume, tMax = 80, tRemplissage = 10, hauteurStatique = 5, soupape = 3, glycol = false }) {
  if (!(volume > 0)) return null;
  let e = waterDensity(tRemplissage) / waterDensity(tMax) - 1;
  if (glycol) e *= 1.25;
  const vExpansion = volume * e;
  const vReserve = Math.max(3, volume * 0.005);
  const pi = Math.max(0.5, hauteurStatique / 10 + 0.3); // pré-gonflage
  const pf = soupape <= 5 ? soupape - 0.5 : soupape * 0.9; // pression finale
  if (pf <= pi) return { erreur: "Pression finale ≤ pré-gonflage : soupape trop basse ou hauteur trop importante." };
  const vn = (vExpansion + vReserve) * ((pf + 1) / (pf - pi));
  return { e, vExpansion, vReserve, pi, pf, pRemplissage: pi + 0.3, vn };
}

const VASES_STANDARD = [8, 12, 18, 25, 35, 50, 80, 100, 140, 200, 250, 300, 400, 500];
export function vaseCommercial(vn) {
  return VASES_STANDARD.find((v) => v >= vn) ?? null;
}

/**
 * Volume d'eau minimal pour limiter les courts cycles.
 * P mini du générateur en kW, durée mini de fonctionnement en min,
 * différentiel (hystérésis) en K → litres.
 */
export function volumeMini({ puissanceMin, dureeMin = 6, hysteresis = 5, volumeExistant = 0 }) {
  if (!(puissanceMin > 0) || !(hysteresis > 0)) return null;
  const litres = (puissanceMin * (dureeMin / 60) * 1000) / (1.163 * hysteresis);
  return { litres, tampon: Math.max(0, litres - volumeExistant) };
}

/** Kv d'une vanne : Q en m³/h, Δp en bar. */
export const kvRequis = (debitM3h, dpBar) => debitM3h / Math.sqrt(dpBar);
export const dpVanne = (debitM3h, kv) => (debitM3h / kv) ** 2;

/** Estimation rapide des déperditions : G (W/m³.K) × V × ΔT. */
export const ISOLATION = {
  bbc: { label: "Récente BBC / RE2020", g: 0.5 },
  rt2005: { label: "RT 2005 / RT 2012", g: 0.75 },
  "1990": { label: "1990 – 2005, isolation correcte", g: 1.0 },
  "1975": { label: "1975 – 1990, isolation moyenne", g: 1.3 },
  ancienne: { label: "Avant 1975, peu isolée", g: 1.7 },
  nonisolee: { label: "Non isolée", g: 2.2 },
};
export function deperditions({ surface, hauteur = 2.5, g, tint = 20, tbase = -7 }) {
  if (!(surface > 0) || !(g > 0)) return null;
  const w = g * surface * hauteur * (tint - tbase);
  return { kw: w / 1000, wm2: w / surface };
}

/** Surchauffe / sous-refroidissement et pré-diagnostic frigorifique. */
export function frigo({ tSatEvap, tAspiration, tSatCond, tLiquide }) {
  const sh = tAspiration - tSatEvap;
  const sc = tSatCond - tLiquide;
  const shNiv = sh < 3 ? "bas" : sh > 10 ? "haut" : "normal";
  const scNiv = sc < 2 ? "bas" : sc > 10 ? "haut" : "normal";
  const table = {
    "haut-bas": "Manque de fluide probable (fuite) : rechercher la fuite avant toute recharge.",
    "haut-haut": "Restriction côté liquide : filtre déshydrateur colmaté, détendeur bloqué fermé, vanne partiellement fermée.",
    "haut-normal": "Sous-alimentation de l'évaporateur : détendeur mal réglé ou sonde de surchauffe, début de manque de charge.",
    "bas-haut": "Excès de charge probable, ou condenseur peu ventilé faussant le SC.",
    "bas-bas": "Détendeur trop ouvert / bloqué ouvert, ou compresseur peu performant (clapets). Risque de retour liquide.",
    "bas-normal": "Évaporateur suralimenté : détendeur trop ouvert, sonde d'aspiration mal fixée. Risque de coup de liquide.",
    "normal-haut": "Charge légèrement excessive ou condensation basse : contrôler la HP et la ventilation du condenseur.",
    "normal-bas": "Charge légèrement faible ou condenseur encrassé : vérifier HP et propreté des batteries.",
    "normal-normal": "Valeurs cohérentes : circuit frigorifique a priori correctement chargé.",
  };
  return { sh, sc, shNiv, scNiv, interpretation: table[`${shNiv}-${scNiv}`] };
}

export const conversions = {
  barToMce: (bar) => bar * 10.197,
  mceToBar: (m) => m / 10.197,
  kwToKcalh: (kw) => kw * 859.85,
  kwToBtuh: (kw) => kw * 3412.14,
};
