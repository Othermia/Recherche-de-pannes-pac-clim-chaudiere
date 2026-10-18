// Mode démo : sans clé API, les fonctions d'IA renvoient des réponses
// d'exemple (clairement signalées) pour découvrir l'application gratuitement.
import { EXPERT_SYSTEM, DOCS_SYSTEM, PIECES_SYSTEM } from "./prompts.js";

export const DEMO = process.env.DEMO === "1" || !(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const BANNER = "> 🧪 **Mode démo** : réponse d'exemple, l'appareil et les mesures saisis ne sont pas analysés.\n\n";

const DIAGNOSTIC = `${BANNER}## Exemple : défaut d'allumage (exemple : chaudière gaz Saunier Duval, code F28)

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

/**
 * Fiche de démo pour la marque et le code saisis. La signification n'est
 * pas inventée : seuls les passages trouvés dans les notices importées
 * (recherche plein texte, sans IA) sont montrés.
 */
export function demoCodeFiche(q, hits) {
  const found = hits.length > 0;
  return {
    demo: true,
    id: `demo-${Date.now()}`,
    marque: q.marque,
    modele: q.modele,
    code: q.code,
    titre: found ? `Code ${q.code} trouvé dans vos notices` : `Code ${q.code} : signification non recherchée (mode démo)`,
    categorie: "inconnu",
    signification: found
      ? `Le code ${q.code} apparaît dans ${hits.length} passage(s) de vos notices ${q.marque} : voir les extraits ci-dessous. Avec la clé API, l'IA lit ces passages et les sites ${q.marque} pour rédiger la fiche complète (causes classées, contrôles, pièces).`
      : `Mode démo : la signification exacte du code ${q.code} chez ${q.marque} n'est pas recherchée. Importez la notice ${q.marque} (onglet Docs) pour que l'appli y trouve le code, ou ajoutez la clé API pour obtenir la fiche complète depuis les notices et les sites constructeurs.`,
    organe: "",
    declenchement: "",
    causes: [],
    pieces: [],
    procedure: [
      "Relever le code exact et l'état de l'appareil (mode, températures, pressions)",
      `Consulter la liste des codes défaut de la notice ${q.marque} ${q.modele || ""}`.trim(),
      "Couper l'alimentation avant toute intervention, puis contrôler l'organe concerné",
    ],
    reinitialisation: "",
    securite: "",
    sources: [],
    docsLocales: hits.slice(0, 5).map(({ docId, titre, page, extrait }) => ({ docId, titre, page, extrait })),
    confiance: "faible",
  };
}

const PIECES = [
  {
    designation: "[EXEMPLE DÉMO] Pièce recherchée",
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
    const question = (last.split("</contexte>\\n\\n")[1] || "").replace(/"\}\]$/, "").replace(/\\n/g, " ").slice(0, 300);
    const extraits = (last.match(/<extrait /g) || []).length;
    const intro =
      `${BANNER}**Votre demande :** « ${question} »\n\n` +
      (extraits
        ? `📚 J'ai trouvé **${extraits} passage(s)** dans vos notices (liens « Docs consultées » ci-dessous). Avec la clé API, l'IA les lit et vous guide spécifiquement sur votre appareil.\n\n`
        : "Aucun passage correspondant dans vos notices importées. Avec la clé API, l'IA cherche aussi sur les sites constructeurs.\n\n") +
      "Voici à quoi ressemble un guidage réel, **sur un autre exemple** :\n\n---\n\n";
    const example = last.includes("PARAMÉTRAGE") ? PARAMETRAGE : last.includes("QUESTION TECHNIQUE") ? QUESTION : DIAGNOSTIC;
    text = intro + example.replace(BANNER, "");
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
