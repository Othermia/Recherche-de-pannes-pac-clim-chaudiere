# O'Thermia : dépannage PAC, climatisation et chaudières

Application web professionnelle aux couleurs d'O'Thermia (logo, bleu #082da0, rouge #b70b2c), installable sur téléphone (PWA), pour les techniciens chauffagistes et frigoristes. Son principe s'inspire d'Editherm Mobility : marque, code erreur, fiche de panne, pièces à contrôler et notices. Elle y ajoute un assistant de diagnostic, la lecture de plaques signalétiques et les calculs de réglage.

| Module | Ce qu'il fait |
|---|---|
| **Accueil** | Recherche unique (code, marque, modèle, client, mot-clé dans les notices), tuiles d'accès rapide, fiches favorites et dernières fiches consultées. |
| **Codes erreur** | Marque + modèle + code, puis **fiche de panne** : signification, organe surveillé, condition de déclenchement, causes classées par probabilité avec le contrôle à faire, procédure, pièces à contrôler (ajout direct à la liste de pièces), réinitialisation, sources. Chaque fiche est enregistrée dans **votre base de codes**, consultable ensuite hors ligne et instantanément (« E-09 », « e9 » et « E9 » sont reconnus comme le même code). |
| **Pièces détachées** | Recherche de la référence constructeur d'une pièce (vues éclatées, distributeurs), puis liste de pièces avec statut (à commander, commandée, reçue, posée) et copie de la liste pour la commande. |
| **Rapport d'intervention** | Depuis un diagnostic : rapport imprimable ou en PDF, avec votre logo et vos coordonnées, l'appareil, le déroulé, les pièces et les cadres de signature. |
| **Diagnostic** | Assistant « ingénieur CVC » : vous décrivez la panne ou le code erreur, il vous guide pas à pas (mesure à faire, valeur attendue, si OK / si NOK). Il s'appuie en priorité sur **vos** documentations enregistrées (avec la page citée) et vérifie sur le web les données constructeur. Il accepte les photos (afficheur, carte électronique, câblage). Trois modes : *Panne*, *Réglage* (mise en service et paramétrage complet) et *Question*. Les diagnostics sont gardés dans l'historique. |
| **Scanner** | Photo de la plaque signalétique, puis lecture automatique (marque, modèle, référence, n° de série, fluide, charge, puissances, alimentation, gaz…). L'appareil peut ensuite être enregistré dans le parc, ses docs recherchées, ou un diagnostic lancé. |
| **Docs** | Recherche en ligne des notices officielles (installation, service, codes erreur, schémas électriques, paramétrage, pièces) puis **stockage** dans la bibliothèque en un clic. Import de vos propres PDF. Recherche plein texte dans tous les PDF (ex. « E9 », « A11 », « sonde départ ») avec renvoi direct à la page. |
| **Parc** | Fiches des appareils (client, site, données de plaque, notes), docs liées, accès direct au diagnostic ou au paramétrage. |
| **Calculs** | Débit (eau ou eau glycolée), contrôle de puissance transmise, dimensionnement des tuyauteries (vitesse et Pa/m : cuivre, multicouche, PER, acier), **loi d'eau** physique selon les émetteurs (courbe, tableau, réglage 2 points et pente équivalente), vase d'expansion (pré-gonflage, pression de remplissage), volume mini / ballon tampon anti-court-cycle, surchauffe et sous-refroidissement avec pré-diagnostic, Kv de vanne, déperditions rapides, conversions. Un bouton envoie les calculs à l'expert pour obtenir une fiche de réglage complète. Les calculs fonctionnent hors ligne. |

## Installation

Il faut Node.js 22 ou plus récent et une clé API Anthropic (https://console.anthropic.com).

```bash
npm install
cp .env.example .env      # puis renseignez ANTHROPIC_API_KEY et APP_PASSWORD
npm start                 # http://localhost:3000
```

Tests des calculs : `npm test`.

### Mise en ligne (pour l'utiliser sur chantier)

L'application doit être servie en **HTTPS** pour être installable sur le téléphone (menu du navigateur, « Ajouter à l'écran d'accueil »).

- **Docker** : `docker build -t cvc-doctor . && docker run -p 3000:3000 -v cvc-data:/data --env-file .env cvc-doctor`
- **Render / Railway / Fly.io / VPS** : déployez le dépôt et définissez `ANTHROPIC_API_KEY` et `APP_PASSWORD`. Montez un **disque persistant** sur `DATA_DIR`, sinon les docs et le parc seront perdus à chaque redéploiement.

Si `APP_PASSWORD` est défini, le navigateur demande un mot de passe (n'importe quel identifiant, ce mot de passe). Définissez-le toujours quand l'application est en ligne : elle utilise votre clé API.

## Personnaliser le logo et les couleurs

Touchez la roue dentée ⚙️ en haut à droite : logo (PNG/JPEG/WebP), nom, slogan, couleur principale, couleur d'accent, téléphone, e-mail, adresse et site. Les changements s'appliquent immédiatement à l'appli, à l'icône du téléphone et aux rapports. Le logo O'Thermia est installé par défaut (`public/brand/logo.png`, icônes `icon-192.png` et `icon-512.png`).

## Données

Tout est stocké dans `DATA_DIR` (par défaut `./data`) :
- `docs/*.pdf` : les documentations ;
- `text/*.json` : le texte extrait page par page (index de recherche) ;
- `db.json` : le parc d'équipements, le catalogue des documents, la base de codes erreur et la liste de pièces ;
- `brand.json` et `brand/` : vos paramètres d'entreprise et votre logo.

Sauvegardez ce dossier régulièrement. L'historique des diagnostics est conservé dans le navigateur de chaque appareil.

## Bon à savoir

- Certains fabricants ne publient leurs notices que derrière un espace pro (Daikin Business Portal, Atlantic Pro, Viessmann…). Dans ce cas, le bouton « Enregistrer » échoue. Ouvrez le lien, téléchargez le PDF, puis importez-le dans la bibliothèque.
- Les PDF scannés sans couche texte apparaissent « non indexé » : ils restent consultables mais pas interrogeables par la recherche.
- L'assistant donne des valeurs indicatives. Les consignes du fabricant et les règles de sécurité (gaz, électricité, fluides frigorigènes et attestation de capacité) priment toujours.
- Modèle utilisé : Claude Opus 5.5 (modifiable via la variable `CLAUDE_MODEL`). Le repli automatique côté serveur est activé si une requête est déclinée.

## Architecture

- `server.js` : API Express (assistant en streaming SSE, lecture de plaque, docs, parc).
- `lib/claude.js` : appels à l'API Claude (streaming, recherche et lecture web, sorties structurées).
- `lib/prompts.js` : prompts experts.
- `lib/codes.js` : base de codes erreur (normalisation des codes, liste des marques).
- `lib/docs.js` : téléchargement sécurisé, extraction du texte des PDF (pdf.js), recherche plein texte.
- `public/` : interface PWA (HTML/CSS/JS sans étape de build), `calc.js` regroupe les calculs.
