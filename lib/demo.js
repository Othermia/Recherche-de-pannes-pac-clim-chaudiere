// Mode démo : sans clé API, les fonctions d'IA renvoient des réponses
// d'exemple (clairement signalées) pour découvrir l'application gratuitement.
import { EXPERT_SYSTEM, CODE_SYSTEM, DOCS_SYSTEM, PIECES_SYSTEM } from "./prompts.js";

export const DEMO = process.env.DEMO === "1" || !(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const BANNER = "> 🧪 **Mode démo** : réponse d'exemple, l'appareil et les mesures saisis ne sont pas analysés.\n\n";

const DIAGNOSTIC = `${BANNER}## Défaut d'allumage (exemple : chaudière gaz Saunier Duval, code F28)

**Sécurité** : coupez l'alimentation électrique avant d'ouvrir l'appareil et contrôlez l'étanchéité gaz à la fin de l'intervention.

### Signification
Le brûleur ne s'allume pas : aucune flamme n'est détectée par l'électrode d'ionisation après les tentatives d'allumage, et la chaudière se met en sécurité.

### Hypothèses, de la plus probable à la moins probable
1. Arrivée de gaz coupée ou pression gaz insuffisante
2. Électrode d'allumage ou d'ionisation encrassée, déréglée ou câble endommagé
3. Problème d'alimentation électrique : inversion phase/neutre ou mauvaise terre (l'ionisation en dépend)
4. Vanne gaz défaillante ou bobine HS
5. Carte électronique

### Étape 1 : arrivée et pression gaz
- **Action** : vérifiez que le robinet gaz est ouvert, puis mesurez la pression d'alimentation à la prise de pression amont de la vanne gaz, brûleur en demande.
- **Valeur attendue** : environ 20 mbar en gaz naturel (G20), 37 mbar en propane.
- **Si OK →** passez à l'étape 2.
- **Si NOK →** recherchez la cause en amont (compteur, détendeur, robinet, purge d'air après travaux).

### Étape 2 : électrodes
- **Action** : déposez l'électrode et contrôlez son état, l'écartement et l'isolant céramique.
- **Valeur attendue** : pointes propres, céramique non fêlée, écartement conforme à la notice (souvent 3 à 4 mm).
- **Si OK →** étape 3.
- **Si NOK →** nettoyez, réglez ou remplacez l'électrode.

### Étape 3 : polarité et terre
- **Action** : mesurez la tension phase/terre et neutre/terre au bornier.
- **Valeur attendue** : environ 230 V phase/terre, moins de 5 V neutre/terre.

**Donnez-moi les résultats de ces mesures et je vous guide pour la suite.**`;

const PARAMETRAGE = `${BANNER}## Mise en service d'une PAC air/eau sur plancher chauffant (exemple : 8 kW)

### 1. Débit nominal
Q = P / (1,163 × ΔT) = 8 / (1,163 × 5) ≈ **1,38 m³/h** (23 l/min).

### 2. Circulateur
Mode Δp constant ou vitesse fixe. Réglez pour obtenir un ΔT de 5 K à pleine charge ; contrôlez le débit lu sur la régulation ou mesuré.

### 3. Loi d'eau
| Paramètre | Valeur | Justification |
|---|---|---|
| T ext. de base | −7 °C | zone climatique de l'exemple |
| T départ à T base | 35 °C | plancher chauffant |
| T départ à +15 °C | ≈ 24 °C | courbe des émetteurs (n = 1,1) |
| T départ maxi | 45 °C | protection de la chape |
| Arrêt chauffage | 16 °C ext. | inutile au-delà |

### 4. Contrôles
Volume d'eau mini (anti-court-cycle et dégivrage), pression à froid 1,2 à 1,5 bar, purge, filtre propre.

_En mode réel, l'assistant adapte chaque valeur à votre appareil, à sa notice et à vos calculs._`;

const QUESTION = `${BANNER}En mode réel, l'ingénieur virtuel répond ici à toute question technique : hydraulique, régulation, frigorifique, électricité, réglementation. Il s'appuie sur vos documentations et sur les sites des constructeurs.`;

const FICHE = {
  demo: true,
  marque: "Saunier Duval",
  modele: "Exemple (mode démo)",
  code: "F28",
  titre: "[EXEMPLE DÉMO] Défaut d'allumage",
  categorie: "verrouillage",
  signification:
    "Fiche d'exemple : aucune flamme n'est détectée après les tentatives d'allumage, la chaudière se verrouille. En mode réel, la fiche correspond exactement à la marque, au modèle et au code saisis.",
  organe: "Allumage / détection de flamme par ionisation",
  declenchement: "Absence de courant d'ionisation à la fin des essais d'allumage",
  causes: [
    { cause: "Gaz coupé ou pression insuffisante", probabilite: "élevée", verification: "Pression d'alimentation ≈ 20 mbar en G20 brûleur en demande" },
    { cause: "Électrode encrassée ou déréglée", probabilite: "élevée", verification: "État, écartement selon la notice, câble et céramique" },
    { cause: "Polarité ou terre incorrecte", probabilite: "moyenne", verification: "Phase/terre ≈ 230 V, neutre/terre < 5 V" },
    { cause: "Vanne gaz ou bobine défaillante", probabilite: "faible", verification: "Tension présente à la bobine au démarrage, résistance de bobine" },
  ],
  pieces: [
    { designation: "Électrode d'allumage / ionisation", reference: "" },
    { designation: "Vanne gaz", reference: "" },
  ],
  procedure: [
    "Couper l'alimentation électrique",
    "Contrôler l'arrivée et la pression gaz",
    "Contrôler les électrodes",
    "Contrôler la polarité et la terre",
    "Réarmer, puis vérifier l'étanchéité gaz",
  ],
  reinitialisation: "Bouton de réarmement de la chaudière, une fois la cause corrigée",
  securite: "Gaz : contrôle d'étanchéité obligatoire après intervention",
  sources: [],
  confiance: "faible",
};

const PIECES = [
  {
    designation: "[EXEMPLE DÉMO] Électrode d'allumage",
    reference: "",
    compatibilite: "En mode réel : modèles et n° de série compatibles",
    remarque: "Mode démo : aucune recherche effectuée",
    url: "",
    source: "",
    prix: "",
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Simule une réponse en streaming, mot par mot. */
export async function demoStreaming({ system, messages, emit, signal }) {
  let text;
  if (system === EXPERT_SYSTEM) {
    const last = JSON.stringify(messages.at(-1).content);
    text = last.includes("PARAMÉTRAGE") ? PARAMETRAGE : last.includes("QUESTION TECHNIQUE") ? QUESTION : DIAGNOSTIC;
  } else if (system === CODE_SYSTEM) {
    text = `Mode démo : fiche d'exemple affichée, sans recherche réelle.\n\`\`\`json\n${JSON.stringify(FICHE)}\n\`\`\``;
  } else if (system === PIECES_SYSTEM) {
    text = `Mode démo : exemple de résultat, sans recherche réelle.\n\`\`\`json\n${JSON.stringify(PIECES)}\n\`\`\``;
  } else if (system === DOCS_SYSTEM) {
    text =
      "Mode démo : la recherche de notices en ligne nécessite la clé API. En attendant, importez vos PDF avec le bouton « Importer un PDF » : la recherche dans vos documents fonctionne.\n```json\n[]\n```";
  } else text = BANNER;

  emit({ type: "status", text: "Mode démo…" });
  await sleep(400);
  const visible = text.split("```json")[0];
  for (const chunk of visible.match(/\S+\s*/g) || []) {
    if (signal?.aborted) break;
    emit({ type: "text", text: chunk });
    await sleep(12);
  }
  return text;
}

/** Lecture de plaque fictive. */
export async function demoParse() {
  await sleep(600);
  return {
    type_equipement: "PAC air/eau",
    fabricant: "Exemple",
    gamme: "Mode démo",
    modele: "PAC DÉMO 8 kW",
    reference: "DEMO-0000",
    numero_serie: "DEMO-000000",
    annee_fabrication: "",
    fluide_frigorigene: "R32",
    charge_fluide: "",
    puissance_calorifique: "8 kW",
    puissance_frigorifique: "",
    puissance_electrique: "",
    alimentation_electrique: "230 V ~ 50 Hz",
    pressions_service: "",
    gaz_categorie: "",
    indice_protection: "",
    autres_infos: "Données d'exemple (mode démo) : la photo n'a pas été analysée.",
    confiance: "faible",
  };
}
