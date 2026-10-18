import { marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/purify.js";
import * as calc from "/calc.js";

// ---------- Utilitaires ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toLocaleString("fr-FR", { maximumFractionDigits: d, minimumFractionDigits: 0 }) : "–");
const md = (text) => DOMPurify.sanitize(marked.parse(text || ""));
const num = (id) => parseFloat($(`#${id}`).value.replace(",", "."));

function toast(text, ms = 3000) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}

const storage = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

async function api(url, options = {}) {
  const init = { ...options };
  if (options.json !== undefined) {
    init.method = init.method || "POST";
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(options.json);
  }
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

/** POST qui renvoie un flux SSE ; onEvent reçoit chaque objet JSON. */
async function streamPost(url, body, onEvent, signal) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Erreur ${res.status}`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (chunk.startsWith("data: ")) onEvent(JSON.parse(chunk.slice(6)));
    }
  }
}

/** Réduit une photo (max 1600 px) et la renvoie en base64 JPEG. */
function loadImage(file, maxSide = 1600) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL("image/jpeg", 0.85);
      URL.revokeObjectURL(img.src);
      resolve({ media_type: "image/jpeg", data: url.split(",")[1], preview: url });
    };
    img.onerror = () => reject(new Error("Image illisible"));
    img.src = URL.createObjectURL(file);
  });
}

// ---------- État ----------
const state = {
  equipements: [],
  docs: [],
  codes: [],
  pieces: [],
  brand: {},
  currentEquip: storage.get("cvc.equip", ""),
  mode: "diagnostic",
  sessions: storage.get("cvc.sessions", []),
  session: null,
  pendingImages: [],
  busy: false,
};

const EQUIP_FIELDS = [
  ["client", "Client"],
  ["adresse", "Adresse / site"],
  ["type_equipement", "Type"],
  ["fabricant", "Fabricant"],
  ["gamme", "Gamme"],
  ["modele", "Modèle"],
  ["reference", "Référence"],
  ["numero_serie", "N° de série"],
  ["annee_fabrication", "Année"],
  ["fluide_frigorigene", "Fluide frigorigène"],
  ["charge_fluide", "Charge fluide"],
  ["puissance_calorifique", "Puissance calorifique"],
  ["puissance_frigorifique", "Puissance frigorifique"],
  ["puissance_electrique", "Puissance électrique"],
  ["alimentation_electrique", "Alimentation électrique"],
  ["pressions_service", "Pressions de service"],
  ["gaz_categorie", "Gaz / catégorie"],
  ["indice_protection", "Indice IP"],
  ["autres_infos", "Autres infos"],
  ["notes", "Notes d'intervention"],
];

const equipLabel = (e) =>
  [e.fabricant, e.modele || e.gamme || e.reference, e.client && `· ${e.client}`].filter(Boolean).join(" ") || "Appareil sans nom";
const getEquip = (id) => state.equipements.find((e) => e.id === id);

function setCurrentEquip(id) {
  state.currentEquip = getEquip(id) ? id : "";
  storage.set("cvc.equip", state.currentEquip);
  const e = getEquip(state.currentEquip);
  $("#equip-chip").textContent = e ? equipLabel(e) : "Aucun";
  $("#chat-equip").value = state.currentEquip;
}

async function refreshData() {
  let marques;
  [state.equipements, state.docs, state.codes, state.pieces, marques] = await Promise.all([
    api("/api/equipements"),
    api("/api/docs"),
    api("/api/codes"),
    api("/api/pieces"),
    api("/api/marques"),
  ]);
  $("#marques").innerHTML = marques.map((m) => `<option value="${esc(m)}">`).join("");
  renderCodes();
  renderPieces();
  const sel = $("#chat-equip");
  sel.innerHTML =
    `<option value="">— Appareil non précisé —</option>` +
    state.equipements.map((e) => `<option value="${esc(e.id)}">${esc(equipLabel(e))}</option>`).join("");
  setCurrentEquip(state.currentEquip);
  renderParc();
  renderLibrary();
}

// ---------- Navigation ----------
function showView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $("main").scrollTop = 0;
}
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (b) showView(b.dataset.view);
});
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-goto]");
  if (!b) return;
  if (b.dataset.goto === "assistant" && b.dataset.mode) {
    setMode(b.dataset.mode);
    newSession();
  }
  showView(b.dataset.goto);
});
$("#brand-home").addEventListener("click", () => showView("home"));

// ---------- Assistant ----------
const STARTERS = {
  diagnostic: [
    "PAC air/eau en défaut, code erreur affiché : ",
    "Chaudière gaz qui se met en sécurité au démarrage",
    "Clim : unité extérieure qui ne démarre pas, voyant qui clignote",
    "PAC : défaut haute pression en mode chauffage",
    "Pas d'eau chaude sanitaire mais le chauffage fonctionne",
    "Circulateur bruyant / manque de débit",
  ],
  parametrage: [
    "Mise en service complète de cette PAC air/eau sur plancher chauffant",
    "Régler la loi d'eau d'une chaudière condensation sur radiateurs",
    "Calcul et réglage du débit circulateur et équilibrage",
    "Paramétrage ECS et anti-légionelle",
  ],
  question: [
    "Différence entre bouteille de découplage et ballon tampon",
    "Comment vérifier une sonde CTN 10 kΩ ?",
    "Règles de remplacement d'une PAC au R410A par du R32",
  ],
};

function newSession() {
  state.session = { id: crypto.randomUUID(), title: "", mode: state.mode, equipId: state.currentEquip, messages: [], updatedAt: Date.now() };
  renderChat();
}

function saveSession() {
  const s = state.session;
  if (!s.messages.length) return;
  s.updatedAt = Date.now();
  s.title ||= s.messages[0].content.slice(0, 80);
  state.sessions = [s, ...state.sessions.filter((x) => x.id !== s.id)].slice(0, 60);
  storage.set("cvc.sessions", state.sessions);
}

function renderChat() {
  const log = $("#chat-log");
  const s = state.session;
  if (!s.messages.length) {
    log.innerHTML = `
      <div class="msg assistant">
        <p><strong>Bonjour, je suis votre ingénieur CVC.</strong> Décrivez le problème ou donnez le code erreur : je vous guide pas à pas, avec les mesures à faire et les valeurs attendues.</p>
        <p class="muted">Astuce : scannez d'abord la plaque signalétique et enregistrez les docs de l'appareil, le diagnostic s'appuiera dessus.</p>
      </div>
      <div class="starters">${STARTERS[state.mode].map((t) => `<button class="btn small" data-starter="${esc(t)}">${esc(t)}</button>`).join("")}</div>`;
    return;
  }
  log.innerHTML = s.messages.map(renderMessage).join("");
  log.scrollTop = log.scrollHeight;
}

function renderSources(sources) {
  if (!sources?.length) return "";
  return `<div class="sources">📚 Docs consultées : ${sources
    .map((h) => `<a href="/api/docs/${encodeURIComponent(h.docId)}/file#page=${h.page}" target="_blank">${esc(h.titre)} p.${h.page}</a>`)
    .join(" · ")}</div>`;
}

function renderMessage(m) {
  if (m.role === "user") {
    return `<div class="msg user">${esc(m.content)}${m.photos ? `<div class="muted" style="color:#dbe7ff">📷 ${m.photos} photo(s) jointe(s)</div>` : ""}</div>`;
  }
  return `<div class="msg assistant">${md(m.content)}${renderSources(m.sources)}</div>`;
}

$("#chat-log").addEventListener("click", (e) => {
  const b = e.target.closest("[data-starter]");
  if (!b) return;
  $("#chat-input").value = b.dataset.starter;
  $("#chat-input").focus();
});

$("#mode-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-mode]");
  if (!b) return;
  setMode(b.dataset.mode);
});
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll("#mode-seg button").forEach((x) => x.classList.toggle("active", x.dataset.mode === mode));
  if (state.session) state.session.mode = mode;
  if (!state.session?.messages.length) renderChat();
}

$("#chat-equip").addEventListener("change", (e) => {
  setCurrentEquip(e.target.value);
  if (state.session) state.session.equipId = state.currentEquip;
});
$("#chat-new").addEventListener("click", newSession);

$("#chat-photo").addEventListener("change", async (e) => {
  for (const file of [...e.target.files].slice(0, 4 - state.pendingImages.length)) {
    state.pendingImages.push(await loadImage(file, 1400));
  }
  e.target.value = "";
  renderAttachments();
});
function renderAttachments() {
  $("#attach-preview").innerHTML = state.pendingImages
    .map((img, i) => `<img src="${img.preview}" alt="" data-rm="${i}" title="Retirer">`)
    .join("");
}
$("#attach-preview").addEventListener("click", (e) => {
  const i = e.target.dataset.rm;
  if (i === undefined) return;
  state.pendingImages.splice(Number(i), 1);
  renderAttachments();
});

const input = $("#chat-input");
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(160, input.scrollHeight)}px`;
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer: coarse)").matches) {
    e.preventDefault();
    $("#composer").requestSubmit();
  }
});

$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || state.busy) return;
  await sendChat(text);
});

async function sendChat(text) {
  const s = state.session;
  const images = state.pendingImages.map(({ media_type, data }) => ({ media_type, data }));
  s.messages.push({ role: "user", content: text, photos: images.length || undefined });
  s.equipId = state.currentEquip;
  input.value = "";
  input.style.height = "";
  state.pendingImages = [];
  renderAttachments();
  renderChat();

  const log = $("#chat-log");
  const bubble = document.createElement("div");
  bubble.className = "msg assistant";
  bubble.innerHTML = `<div class="status"><span class="spinner"></span> Réflexion…</div>`;
  log.append(bubble);
  log.scrollTop = log.scrollHeight;

  const reply = { role: "assistant", content: "", sources: [] };
  let status = "Réflexion…";
  let scheduled = false;
  const paint = () => {
    scheduled = false;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    bubble.innerHTML =
      md(reply.content) +
      (state.busy ? `<div class="status"><span class="spinner"></span> ${esc(status)}</div>` : "") +
      renderSources(reply.sources);
    if (nearBottom) log.scrollTop = log.scrollHeight;
  };
  const schedule = () => {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(paint);
    }
  };

  state.busy = true;
  $("#chat-send").disabled = true;
  try {
    await streamPost(
      "/api/chat",
      {
        mode: state.mode,
        equipementId: state.currentEquip || undefined,
        messages: s.messages.map(({ role, content }) => ({ role, content })),
        images,
      },
      (ev) => {
        if (ev.type === "text") reply.content += ev.text;
        else if (ev.type === "status") status = ev.text;
        else if (ev.type === "sources") reply.sources = ev.sources;
        else if (ev.type === "error") reply.content += `\n\n**Erreur :** ${ev.text}`;
        schedule();
      },
    );
  } catch (err) {
    reply.content += `\n\n**Erreur :** ${err.message}`;
  } finally {
    state.busy = false;
    $("#chat-send").disabled = false;
  }
  if (!reply.content.trim()) reply.content = "_Pas de réponse reçue._";
  s.messages.push(reply);
  paint();
  saveSession();
}

$("#chat-history-btn").addEventListener("click", () => {
  const dlg = $("#dlg");
  dlg.innerHTML = `
    <h2 style="margin-top:0">Historique des diagnostics</h2>
    <div class="list">${
      state.sessions
        .map(
          (s) => `<div class="item"><div class="grow"><div class="title">${esc(s.title)}</div>
          <div class="muted">${new Date(s.updatedAt).toLocaleString("fr-FR")} · ${esc(getEquip(s.equipId) ? equipLabel(getEquip(s.equipId)) : "sans appareil")}</div></div>
          <button class="btn small" data-open="${esc(s.id)}">Ouvrir</button>
          <button class="btn small danger" data-del="${esc(s.id)}">✕</button></div>`,
        )
        .join("") || `<p class="muted">Aucun diagnostic enregistré.</p>`
    }</div>
    <div class="row" style="margin-top:12px;justify-content:flex-end"><button class="btn" data-close>Fermer</button></div>`;
  dlg.onclick = (e) => {
    const t = e.target;
    if (t.dataset.close !== undefined) dlg.close();
    if (t.dataset.open) {
      state.session = structuredClone(state.sessions.find((s) => s.id === t.dataset.open));
      setMode(state.session.mode || "diagnostic");
      setCurrentEquip(state.session.equipId || "");
      renderChat();
      dlg.close();
      showView("assistant");
    }
    if (t.dataset.del) {
      state.sessions = state.sessions.filter((s) => s.id !== t.dataset.del);
      storage.set("cvc.sessions", state.sessions);
      t.closest(".item").remove();
    }
  };
  dlg.showModal();
});

function startChatWith(mode, text, equipId) {
  if (equipId !== undefined) setCurrentEquip(equipId);
  setMode(mode);
  newSession();
  showView("assistant");
  input.value = text;
  input.dispatchEvent(new Event("input"));
  input.focus();
}

// ---------- Scanner de plaque ----------
let scanned = null;
let scannedId = null; // évite d'enregistrer deux fois le même scan

async function handleScan(file) {
  if (!file) return;
  $("#scan-result").hidden = true;
  const img = await loadImage(file, 2000);
  $("#scan-preview").src = img.preview;
  $("#scan-preview").hidden = false;
  $("#scan-status").innerHTML = `<span class="spinner"></span> Lecture de la plaque…`;
  try {
    scannedId = null;
    scanned = await api("/api/plaque", { json: { image: { media_type: img.media_type, data: img.data } } });
    $("#scan-status").innerHTML = `Lecture terminée · confiance <span class="badge ${scanned.confiance === "haute" ? "ok" : "warn"}">${esc(scanned.confiance)}</span> — vérifiez et corrigez si besoin.`;
    $("#scan-form").innerHTML = EQUIP_FIELDS.map(
      ([k, label]) =>
        `<label class="f ${["autres_infos", "notes", "alimentation_electrique"].includes(k) ? "full" : ""}">${label}<input name="${k}" value="${esc(scanned[k] || "")}"></label>`,
    ).join("");
    $("#scan-result").hidden = false;
  } catch (err) {
    $("#scan-status").textContent = `Échec : ${err.message}`;
  }
}
$("#scan-input").addEventListener("change", (e) => handleScan(e.target.files[0]));
$("#scan-input-gallery").addEventListener("change", (e) => handleScan(e.target.files[0]));

const formData = (form) => Object.fromEntries(new FormData(form).entries());

async function saveScanned() {
  const data = formData($("#scan-form"));
  const saved = scannedId
    ? await api(`/api/equipements/${scannedId}`, { method: "PATCH", json: data })
    : await api("/api/equipements", { json: data });
  scannedId = saved.id;
  await refreshData();
  setCurrentEquip(saved.id);
  return saved;
}
$("#scan-save").addEventListener("click", async () => {
  await saveScanned();
  toast("Appareil enregistré dans le parc");
});
$("#scan-docs").addEventListener("click", async () => {
  const saved = await saveScanned();
  prefillFinder(saved);
  showView("docs");
  findDocs();
});
$("#scan-diag").addEventListener("click", async () => {
  const saved = await saveScanned();
  startChatWith("diagnostic", "", saved.id);
});

// ---------- Documentations ----------
function prefillFinder(e) {
  $("#find-fab").value = e?.fabricant || "";
  $("#find-mod").value = [e?.gamme, e?.modele].filter(Boolean).join(" ");
  $("#find-ref").value = e?.reference || "";
  $("#find-type").value = e?.type_equipement || "";
}

async function findDocs() {
  const body = {
    fabricant: $("#find-fab").value.trim(),
    modele: $("#find-mod").value.trim(),
    reference: $("#find-ref").value.trim(),
    type_equipement: $("#find-type").value.trim(),
    besoin: $("#find-need").value.trim(),
  };
  if (!body.fabricant && !body.modele && !body.reference) return toast("Indiquez au moins un fabricant, un modèle ou une référence.");
  const status = $("#find-status");
  const results = $("#find-results");
  results.innerHTML = "";
  $("#find-btn").disabled = true;
  status.innerHTML = `<span class="spinner"></span> Recherche…`;
  let summary = "";
  try {
    await streamPost("/api/docs/trouver", body, (ev) => {
      if (ev.type === "status") status.innerHTML = `<span class="spinner"></span> ${esc(ev.text)}`;
      if (ev.type === "text") summary += ev.text;
      if (ev.type === "error") toast(ev.text, 6000);
      if (ev.type === "result") {
        const intro = summary.split("```json")[0].trim();
        results.innerHTML =
          (intro ? `<div class="muted">${md(intro)}</div>` : "") +
          (ev.docs.length
            ? ev.docs.map((d, i) => renderFound(d, i)).join("")
            : `<p class="muted">Aucun document trouvé. Essayez avec la référence exacte de la plaque.</p>`);
        results._docs = ev.docs;
        results._meta = body;
      }
    });
    status.textContent = "";
  } catch (err) {
    status.textContent = `Échec : ${err.message}`;
  } finally {
    $("#find-btn").disabled = false;
  }
}

function renderFound(d, i) {
  return `<div class="item">
    <div class="grow">
      <div class="title">${esc(d.titre)}</div>
      <div class="muted">${esc(d.type || "")} · ${esc(d.langue || "")} · ${esc(d.source || new URL(d.url).hostname)} ${d.pdf ? `<span class="badge">PDF</span>` : ""}</div>
    </div>
    <a class="btn small" href="${esc(d.url)}" target="_blank" rel="noopener">Ouvrir</a>
    <button class="btn small primary" data-import="${i}">Enregistrer</button>
  </div>`;
}

$("#find-btn").addEventListener("click", findDocs);
$("#find-results").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-import]");
  if (!b) return;
  const list = $("#find-results");
  const d = list._docs[Number(b.dataset.import)];
  b.disabled = true;
  b.innerHTML = `<span class="spinner"></span>`;
  try {
    const { duplicate } = await api("/api/docs/import", {
      json: {
        url: d.url,
        titre: d.titre,
        type: d.type,
        langue: d.langue,
        fabricant: list._meta.fabricant,
        modele: [list._meta.modele, list._meta.reference].filter(Boolean).join(" "),
        equipementId: state.currentEquip || undefined,
      },
    });
    b.textContent = duplicate ? "Déjà là" : "✓ Enregistré";
    await refreshData();
  } catch (err) {
    b.disabled = false;
    b.textContent = "Réessayer";
    toast(`${err.message} Ouvrez le lien, téléchargez le PDF puis importez-le dans la bibliothèque.`, 7000);
  }
});

$("#lib-upload").addEventListener("change", async (e) => {
  for (const file of e.target.files) {
    const fd = new FormData();
    fd.append("file", file);
    const eq = getEquip(state.currentEquip);
    if (eq) {
      fd.append("equipementId", eq.id);
      fd.append("fabricant", eq.fabricant || "");
      fd.append("modele", [eq.modele, eq.reference].filter(Boolean).join(" "));
    }
    toast(`Import de ${file.name}…`);
    try {
      const res = await fetch("/api/docs/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast(data.duplicate ? `${file.name} : déjà présent` : `${file.name} importé (${data.doc.pages} pages)`);
    } catch (err) {
      toast(`${file.name} : ${err.message}`, 5000);
    }
  }
  e.target.value = "";
  refreshData();
});

const TYPE_LABELS = {
  installation: "Installation",
  utilisation: "Utilisation",
  service: "Service / SAV",
  codes_erreur: "Codes erreur",
  schema_electrique: "Schéma électrique",
  technique: "Données techniques",
  pieces: "Pièces détachées",
  parametrage: "Paramétrage",
  autre: "Autre",
};

function renderLibrary() {
  $("#lib-list").innerHTML =
    state.docs
      .map(
        (d) => `<div class="item">
      <div class="grow">
        <div class="title">${esc(d.titre)}</div>
        <div class="muted">${esc([d.fabricant, d.modele].filter(Boolean).join(" "))} · ${esc(TYPE_LABELS[d.type] || d.type)} · ${d.pages} p.
          ${d.texteIndexe ? "" : `<span class="badge warn" title="PDF scanné sans texte : non consultable par la recherche">non indexé</span>`}
          ${getEquip(d.equipementId) ? `· 🔗 ${esc(equipLabel(getEquip(d.equipementId)))}` : ""}</div>
      </div>
      <a class="btn small" href="/api/docs/${encodeURIComponent(d.id)}/file" target="_blank">Ouvrir</a>
      <button class="btn small" data-edit-doc="${esc(d.id)}">✎</button>
    </div>`,
      )
      .join("") || `<p class="muted">Aucune documentation. Recherchez-en ci-dessus ou importez vos PDF.</p>`;
}

let searchTimer;
$("#lib-search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  searchTimer = setTimeout(async () => {
    if (q.length < 2) return ($("#lib-hits").innerHTML = "");
    const hits = await api(`/api/docs/recherche?q=${encodeURIComponent(q)}`);
    $("#lib-hits").innerHTML =
      hits
        .map(
          (h) => `<div class="hit"><a href="/api/docs/${encodeURIComponent(h.docId)}/file#page=${h.page}" target="_blank">${esc(h.titre)} — page ${h.page}</a><div>${esc(h.extrait)}</div></div>`,
        )
        .join("") || `<p class="muted">Aucun résultat dans les documents indexés.</p>`;
  }, 300);
});

$("#lib-list").addEventListener("click", (e) => {
  const id = e.target.closest("[data-edit-doc]")?.dataset.editDoc;
  if (!id) return;
  const d = state.docs.find((x) => x.id === id);
  const dlg = $("#dlg");
  dlg.innerHTML = `
    <h2 style="margin-top:0">Document</h2>
    <form class="grid" id="doc-form">
      <label class="f full">Titre<input name="titre" value="${esc(d.titre)}"></label>
      <label class="f">Type<select name="type">${Object.entries(TYPE_LABELS)
        .map(([k, v]) => `<option value="${k}" ${k === d.type ? "selected" : ""}>${v}</option>`)
        .join("")}</select></label>
      <label class="f">Langue<input name="langue" value="${esc(d.langue)}"></label>
      <label class="f">Fabricant<input name="fabricant" value="${esc(d.fabricant)}"></label>
      <label class="f">Modèle<input name="modele" value="${esc(d.modele)}"></label>
      <label class="f full">Appareil lié<select name="equipementId"><option value="">—</option>${state.equipements
        .map((e) => `<option value="${esc(e.id)}" ${e.id === d.equipementId ? "selected" : ""}>${esc(equipLabel(e))}</option>`)
        .join("")}</select></label>
    </form>
    ${d.sourceUrl ? `<p class="muted">Source : <a href="${esc(d.sourceUrl)}" target="_blank" rel="noopener">${esc(d.sourceUrl)}</a></p>` : ""}
    <div class="row" style="margin-top:12px;justify-content:space-between">
      <button class="btn danger" data-act="del">Supprimer</button>
      <span class="row"><button class="btn" data-act="close">Annuler</button><button class="btn primary" data-act="save">Enregistrer</button></span>
    </div>`;
  dlg.onclick = async (ev) => {
    const act = ev.target.dataset.act;
    if (act === "close") dlg.close();
    if (act === "save") {
      await api(`/api/docs/${id}`, { method: "PATCH", json: formData($("#doc-form")) });
      dlg.close();
      refreshData();
    }
    if (act === "del" && confirm("Supprimer définitivement ce document ?")) {
      await api(`/api/docs/${id}`, { method: "DELETE" });
      dlg.close();
      refreshData();
    }
  };
  dlg.showModal();
});

// ---------- Parc ----------
function renderParc() {
  const f = $("#parc-filter").value.trim().toLowerCase();
  const items = state.equipements.filter((e) => !f || JSON.stringify(e).toLowerCase().includes(f));
  $("#parc-list").innerHTML =
    items
      .map((e) => {
        const nDocs = state.docs.filter((d) => d.equipementId === e.id).length;
        return `<div class="item">
        <div class="grow">
          <div class="title">${esc(equipLabel(e))}</div>
          <div class="muted">${esc([e.type_equipement, e.reference, e.numero_serie && `S/N ${e.numero_serie}`, e.fluide_frigorigene].filter(Boolean).join(" · "))}
            ${nDocs ? `<span class="badge">${nDocs} doc(s)</span>` : ""}</div>
        </div>
        <button class="btn small" data-equip="${esc(e.id)}">Ouvrir</button>
      </div>`;
      })
      .join("") || `<p class="muted">Aucun appareil. Scannez une plaque ou ajoutez-en un manuellement.</p>`;
}
$("#parc-filter").addEventListener("input", renderParc);
$("#parc-add").addEventListener("click", () => openEquip(null));
$("#parc-list").addEventListener("click", (e) => {
  const id = e.target.closest("[data-equip]")?.dataset.equip;
  if (id) openEquip(id);
});

function openEquip(id) {
  const e = id ? getEquip(id) : {};
  const docs = id ? state.docs.filter((d) => d.equipementId === id) : [];
  const dlg = $("#dlg");
  dlg.innerHTML = `
    <h2 style="margin-top:0">${id ? esc(equipLabel(e)) : "Nouvel appareil"}</h2>
    ${
      id
        ? `<div class="row" style="margin-bottom:12px">
      <button class="btn small primary" data-act="diag">Diagnostiquer</button>
      <button class="btn small" data-act="param">Paramétrer</button>
      <button class="btn small" data-act="docs">Trouver les docs</button>
      <button class="btn small" data-act="select">Sélectionner</button>
    </div>`
        : ""
    }
    <form class="grid" id="equip-form">${EQUIP_FIELDS.map(
      ([k, label]) =>
        `<label class="f ${["autres_infos", "notes", "adresse"].includes(k) ? "full" : ""}">${label}${
          k === "notes"
            ? `<textarea name="${k}" rows="3">${esc(e[k] || "")}</textarea>`
            : `<input name="${k}" value="${esc(e[k] || "")}">`
        }</label>`,
    ).join("")}</form>
    ${
      docs.length
        ? `<h3>Documentations liées</h3><div class="list">${docs
            .map((d) => `<a class="hit" href="/api/docs/${encodeURIComponent(d.id)}/file" target="_blank">${esc(d.titre)}</a>`)
            .join("")}</div>`
        : ""
    }
    <div class="row" style="margin-top:12px;justify-content:space-between">
      ${id ? `<button class="btn danger" data-act="del">Supprimer</button>` : "<span></span>"}
      <span class="row"><button class="btn" data-act="close">Fermer</button><button class="btn primary" data-act="save">Enregistrer</button></span>
    </div>`;
  dlg.onclick = async (ev) => {
    const act = ev.target.dataset.act;
    if (!act) return;
    if (act === "close") return dlg.close();
    if (act === "del") {
      if (!confirm("Supprimer cet appareil du parc ?")) return;
      await api(`/api/equipements/${id}`, { method: "DELETE" });
      dlg.close();
      return refreshData();
    }
    const data = formData($("#equip-form"));
    const saved = id
      ? await api(`/api/equipements/${id}`, { method: "PATCH", json: data })
      : await api("/api/equipements", { json: data });
    await refreshData();
    dlg.close();
    if (act === "save") toast("Appareil enregistré");
    if (act === "select") setCurrentEquip(saved.id);
    if (act === "diag") startChatWith("diagnostic", "", saved.id);
    if (act === "param")
      startChatWith("parametrage", "Fais-moi la démarche complète de mise en service et de paramétrage de cet appareil.", saved.id);
    if (act === "docs") {
      setCurrentEquip(saved.id);
      prefillFinder(saved);
      showView("docs");
      findDocs();
    }
  };
  dlg.showModal();
}

// ---------- Calculs ----------
const fillSelect = (id, entries, selected) => {
  $(`#${id}`).innerHTML = Object.entries(entries)
    .map(([k, v]) => `<option value="${k}" ${k === selected ? "selected" : ""}>${esc(v.label)}</option>`)
    .join("");
};
fillSelect("c-deb-fl", calc.FLUIDES, "eau");
fillSelect("c-tub-fl", calc.FLUIDES, "eau");
fillSelect("c-tub-mat", calc.TUBES, "cuivre");
fillSelect("c-le-em", calc.EMETTEURS, "plancher");
fillSelect("c-dp-g", calc.ISOLATION, "1990");

const summaries = {};

function calcDebit() {
  const p = num("c-deb-p");
  const dt = num("c-deb-dt");
  const r = calc.debit({ puissance: p, deltaT: dt, fluide: $("#c-deb-fl").value, temperature: num("c-deb-t") });
  $("#r-deb").innerHTML = r
    ? `<div class="big">${fmt(r.m3h, 3)} m³/h</div><div>${fmt(r.lh, 0)} l/h · ${fmt(r.lmin, 1)} l/min</div>
       <div class="muted">Q = P / (ρ·cp·ΔT). Réglez le circulateur pour obtenir ce débit au point de fonctionnement (lecture débitmètre / ΔT mesuré).</div>`
    : "Renseignez puissance et ΔT.";
  if (r) {
    summaries.debit = `Débit nominal : ${fmt(p)} kW à ΔT ${fmt(dt)} K (${calc.FLUIDES[$("#c-deb-fl").value].label}) → ${fmt(r.m3h, 3)} m³/h (${fmt(r.lmin, 1)} l/min)`;
    if (!$("#c-tub-q").dataset.touched) $("#c-tub-q").value = r.m3h.toFixed(2);
  }

  const pm = calc.puissanceDepuisDebit({ debitM3h: num("c-pm-q"), deltaT: num("c-pm-dt"), fluide: $("#c-deb-fl").value });
  $("#r-pm").innerHTML = pm
    ? `<div class="big">${fmt(pm, 2)} kW</div><div class="muted">transmis par l'eau${p > 0 ? ` · ${fmt((pm / p) * 100, 0)} % de la puissance saisie` : ""}</div>`
    : `<span class="muted">Saisissez un débit et un ΔT mesurés.</span>`;
  calcTube();
}

function calcTube() {
  const q = num("c-tub-q");
  if (!(q > 0)) return ($("#r-tub").innerHTML = "Renseignez un débit.");
  const vMax = num("c-tub-v");
  const rMax = num("c-tub-r");
  const l = num("c-tub-l") || 0;
  const r = calc.dimensionnerTube({
    debitM3h: q,
    materiau: $("#c-tub-mat").value,
    fluide: $("#c-tub-fl").value,
    temperature: num("c-tub-t"),
    vMax,
    rMax,
  });
  $("#r-tub").innerHTML = `
    <div>Diamètre conseillé : <strong class="big">${esc(r.conseil || "hors gamme")}</strong></div>
    <table><thead><tr><th>Tube</th><th>Ø int.</th><th>v (m/s)</th><th>R (Pa/m)</th><th>ΔP ${fmt(l, 0)} m (kPa)</th></tr></thead><tbody>
    ${r.lignes
      .map(
        (x) =>
          `<tr class="${x.nom === r.conseil ? "ok" : x.v > vMax || x.r > rMax ? "warn" : ""}"><td>${esc(x.nom)}</td><td>${fmt(x.di, 1)}</td><td>${fmt(x.v, 2)}</td><td>${fmt(x.r, 0)}</td><td>${fmt((x.r * l) / 1000, 1)}</td></tr>`,
      )
      .join("")}
    </tbody></table>
    <p class="muted">Repères : 0,3 – 1 m/s en logement (≤ 0,7 m/s en petits diamètres pour le bruit), 100 – 200 Pa/m. Ajouter les singularités (+30 à 50 % en première approche) et les pertes des appareils (échangeur PAC, vanne 3 voies, filtre).</p>`;
  if (r.conseil) {
    const best = r.lignes.find((x) => x.nom === r.conseil);
    summaries.tube = `Tuyauterie : ${fmt(q, 2)} m³/h en ${calc.TUBES[$("#c-tub-mat").value].label} ${r.conseil} → ${fmt(best.v, 2)} m/s, ${fmt(best.r, 0)} Pa/m, ≈ ${fmt((best.r * l) / 1000, 1)} kPa pour ${fmt(l, 0)} m (hors singularités)`;
  }
}

function calcLoiEau() {
  const params = {
    textBase: num("c-le-tb"),
    tint: num("c-le-ti"),
    tdepBase: num("c-le-td"),
    deltaTBase: num("c-le-dt"),
    n: num("c-le-n"),
    textArret: num("c-le-ta"),
    tdepMin: num("c-le-min"),
    tdepMax: num("c-le-max"),
  };
  if (Object.values(params).some((v) => !Number.isFinite(v)) || params.tint <= params.textBase || params.tdepBase <= params.tint) {
    $("#r-le").innerHTML = "Valeurs incohérentes (T départ base > T ambiante > T ext. base).";
    return;
  }
  const r = calc.loiEau(params);
  $("#r-le").innerHTML = `
    ${loiEauChart(r, params)}
    <table><thead><tr><th>T ext.</th><th>T départ</th><th>T retour</th><th>Charge</th></tr></thead><tbody>
    ${r.pointsCles
      .map((p) => {
        const pt = calc.loiEauPoint({ ...params, text: p.text });
        const dep = Math.min(params.tdepMax, Math.max(params.tdepMin, pt.depart));
        return `<tr><td>${fmt(p.text, 0)} °C</td><td>${fmt(dep, 1)} °C</td><td>${fmt(pt.retour, 1)} °C</td><td>${fmt(pt.charge * 100, 0)} %</td></tr>`;
      })
      .join("")}
    </tbody></table>
    <h3>Réglage sur la régulation</h3>
    <ul>
      <li><strong>Régulation 2 points</strong> : ${fmt(r.deuxPoints[0].text, 0)} °C ext. → ${fmt(r.deuxPoints[0].depart, 1)} °C départ ; ${fmt(r.deuxPoints[1].text, 0)} °C ext. → ${fmt(r.deuxPoints[1].depart, 1)} °C départ.</li>
      <li><strong>Pente linéaire équivalente</strong> : ${fmt(r.pente, 2)} K/K (entre T base et +15 °C).</li>
      <li><strong>Pente rapportée à l'ambiance</strong> : ${fmt(r.penteAmbiance, 2)} (= (Tdép − Tamb)/(Tamb − Text)). Les échelles de pente diffèrent selon les marques : vérifiez dans la notice de la régulation.</li>
      <li>Limites : départ mini ${fmt(params.tdepMin, 0)} °C, maxi ${fmt(params.tdepMax, 0)} °C, arrêt chauffage au-dessus de ${fmt(params.textArret, 0)} °C ext.</li>
    </ul>
    <p class="muted">Courbe calculée à débit constant avec la loi d'émission P ∝ ΔTm<sup>n</sup>. Ajustez ensuite par paliers de 1 à 2 K selon le ressenti, après 24 à 48 h.</p>`;
  summaries.loi = `Loi d'eau (${calc.EMETTEURS[$("#c-le-em").value].label}, n=${params.n}) : T base ${params.textBase} °C → départ ${params.tdepBase} °C, ΔT ${params.deltaTBase} K, ambiance ${params.tint} °C ; points 2 pts : ${r.deuxPoints
    .map((p) => `${p.text} °C → ${p.depart.toFixed(1)} °C`)
    .join(" / ")} ; pente équivalente ${r.pente.toFixed(2)} ; mini ${params.tdepMin} °C / maxi ${params.tdepMax} °C ; arrêt à ${params.textArret} °C ext.`;
}

function loiEauChart(r, params) {
  const W = 600, H = 260, L = 40, R = 12, T = 12, B = 30;
  const xs = r.points.map((p) => p.text);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.floor(Math.min(params.tdepMin, ...r.points.map((p) => p.depart)) / 5) * 5;
  const y1 = Math.ceil((Math.max(...r.points.map((p) => p.depart)) + 2) / 5) * 5;
  const sx = (x) => L + ((x - x0) / (x1 - x0)) * (W - L - R);
  const sy = (y) => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B);
  const path = r.points.map((p, i) => `${i ? "L" : "M"}${sx(p.text).toFixed(1)},${sy(p.depart).toFixed(1)}`).join("");
  const [a, b] = r.deuxPoints;
  const lin = (x) => Math.min(params.tdepMax, Math.max(params.tdepMin, a.depart + ((b.depart - a.depart) * (x - a.text)) / (b.text - a.text)));
  const linPath = `M${sx(x0)},${sy(lin(x0))}L${sx(x1)},${sy(lin(x1))}`;
  let grid = "";
  for (let x = Math.ceil(x0 / 5) * 5; x <= x1; x += 5)
    grid += `<line class="axis" x1="${sx(x)}" x2="${sx(x)}" y1="${T}" y2="${H - B}"/><text x="${sx(x)}" y="${H - 10}" text-anchor="middle">${x}</text>`;
  for (let y = y0; y <= y1; y += 5)
    grid += `<line class="axis" x1="${L}" x2="${W - R}" y1="${sy(y)}" y2="${sy(y)}"/><text x="${L - 6}" y="${sy(y) + 4}" text-anchor="end">${y}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Courbe de chauffe">
    ${grid}<path class="curve2" d="${linPath}"/><path class="curve" d="${path}"/>
    <text x="${W - R}" y="${T + 10}" text-anchor="end">— courbe émetteurs · - - droite 2 points · axe X : T ext. (°C), Y : T départ (°C)</text>
  </svg>`;
}

$("#c-le-em").addEventListener("change", (e) => {
  const em = calc.EMETTEURS[e.target.value];
  $("#c-le-n").value = em.n;
  $("#c-le-dt").value = em.deltaT;
  $("#c-le-td").value = em.depart;
  $("#c-le-max").value = em.depart + 10;
  calcLoiEau();
});

function calcVase() {
  const r = calc.vaseExpansion({
    volume: num("c-ve-v"),
    tMax: num("c-ve-t"),
    hauteurStatique: num("c-ve-h"),
    soupape: num("c-ve-s"),
    glycol: $("#c-ve-g").value === "1",
  });
  if (!r) return ($("#r-ve").innerHTML = "Renseignez le volume.");
  if (r.erreur) return ($("#r-ve").innerHTML = esc(r.erreur));
  const commercial = calc.vaseCommercial(r.vn);
  $("#r-ve").innerHTML = `
    <div class="big">${fmt(r.vn, 1)} L → vase de ${commercial ?? "> 500"} L</div>
    <ul>
      <li>Coefficient de dilatation : ${fmt(r.e * 100, 2)} % · volume dilaté ${fmt(r.vExpansion, 1)} L + réserve ${fmt(r.vReserve, 1)} L</li>
      <li><strong>Pré-gonflage du vase : ${fmt(r.pi, 2)} bar</strong> (à régler vase isolé et vidé côté eau)</li>
      <li><strong>Pression de remplissage à froid : ${fmt(r.pRemplissage, 2)} bar</strong></li>
      <li>Pression finale admissible : ${fmt(r.pf, 2)} bar</li>
    </ul>
    <p class="muted">Vn = (Ve + Vr) × (Pf + 1) / (Pf − Pi). Pour une PAC, ajouter le volume du ballon tampon et vérifier le vase intégré.</p>`;
  summaries.vase = `Vase d'expansion : installation ${num("c-ve-v")} L, T maxi ${num("c-ve-t")} °C, hauteur ${num("c-ve-h")} m, soupape ${num("c-ve-s")} bar → Vn ${fmt(r.vn, 1)} L (vase ${commercial} L), pré-gonflage ${fmt(r.pi, 2)} bar, remplissage ${fmt(r.pRemplissage, 2)} bar`;
}

function calcVolumeMini() {
  const r = calc.volumeMini({
    puissanceMin: num("c-vm-p"),
    dureeMin: num("c-vm-d"),
    hysteresis: num("c-vm-h"),
    volumeExistant: num("c-vm-e") || 0,
  });
  if (!r) return ($("#r-vm").innerHTML = "Renseignez puissance mini et différentiel.");
  $("#r-vm").innerHTML = `<div class="big">${fmt(r.litres, 0)} L de volume utile</div>
    <div>Ballon tampon à prévoir : <strong>${fmt(r.tampon, 0)} L</strong> (taille commerciale supérieure)</div>
    <p class="muted">V = P × t / (1,163 × ΔT). Le volume « toujours en circulation » exclut les circuits pouvant se fermer (robinets thermostatiques, zones).</p>`;
  summaries.volume = `Volume mini anti-court-cycle : P mini ${num("c-vm-p")} kW, marche mini ${num("c-vm-d")} min, différentiel ${num("c-vm-h")} K → ${fmt(r.litres, 0)} L, tampon ≈ ${fmt(r.tampon, 0)} L`;
}

function calcFrigo() {
  const r = calc.frigo({ tSatEvap: num("c-fr-te"), tAspiration: num("c-fr-ta"), tSatCond: num("c-fr-tc"), tLiquide: num("c-fr-tl") });
  if (!Number.isFinite(r.sh) || !Number.isFinite(r.sc)) return ($("#r-fr").innerHTML = "Renseignez les 4 températures.");
  $("#r-fr").innerHTML = `
    <div class="row"><div><div class="muted">Surchauffe</div><div class="big">${fmt(r.sh, 1)} K</div><span class="badge">${r.shNiv}</span></div>
    <div style="margin-left:24px"><div class="muted">Sous-refroidissement</div><div class="big">${fmt(r.sc, 1)} K</div><span class="badge">${r.scNiv}</span></div></div>
    <p><strong>Pré-diagnostic :</strong> ${esc(r.interpretation)}</p>
    <p class="muted">Repères usuels : SH 4 – 8 K (détendeur électronique), 5 – 10 K (capillaire) ; SC 3 – 8 K. Les valeurs cibles exactes figurent dans la notice constructeur et dépendent des conditions (T ext., mode chaud/froid).</p>`;
  summaries.frigo = `Frigo : BP sat ${num("c-fr-te")} °C, aspiration ${num("c-fr-ta")} °C, HP sat ${num("c-fr-tc")} °C, liquide ${num("c-fr-tl")} °C → SH ${fmt(r.sh, 1)} K, SC ${fmt(r.sc, 1)} K`;
}

function calcKv() {
  const q = num("c-kv-q");
  const dpKpa = num("c-kv-dp");
  const kv = num("c-kv-kv");
  const parts = [];
  if (q > 0 && dpKpa > 0) parts.push(`<div>Kv nécessaire : <span class="big">${fmt(calc.kvRequis(q, dpKpa / 100), 2)}</span></div>`);
  if (q > 0 && kv > 0) parts.push(`<div>Δp dans la vanne Kv ${fmt(kv, 2)} : <strong>${fmt(calc.dpVanne(q, kv) * 100, 1)} kPa</strong> (${fmt(calc.dpVanne(q, kv) * 10.197, 2)} mCE)</div>`);
  parts.push(`<p class="muted">Kv = Q / √Δp (Q en m³/h, Δp en bar). Une vanne 3 voies a une bonne autorité si sa Δp ≥ celle du circuit à débit variable.</p>`);
  $("#r-kv").innerHTML = parts.join("");
}

function calcDeperditions() {
  const key = $("#c-dp-g").value;
  const r = calc.deperditions({ surface: num("c-dp-s"), hauteur: num("c-dp-h"), g: calc.ISOLATION[key].g, tint: num("c-dp-ti"), tbase: num("c-dp-tb") });
  if (!r) return ($("#r-dp").innerHTML = "Renseignez la surface.");
  $("#r-dp").innerHTML = `<div class="big">≈ ${fmt(r.kw, 1)} kW</div><div class="muted">${fmt(r.wm2, 0)} W/m² · G = ${calc.ISOLATION[key].g} W/m³.K</div>`;
  summaries.deperditions = `Déperditions estimées : ${num("c-dp-s")} m², ${calc.ISOLATION[key].label}, T base ${num("c-dp-tb")} °C → ≈ ${fmt(r.kw, 1)} kW`;
}

function calcConversions() {
  const bar = num("c-cv-bar");
  const kw = num("c-cv-kw");
  $("#r-cv").innerHTML = `
    <div>${fmt(bar, 2)} bar = ${fmt(calc.conversions.barToMce(bar), 2)} mCE = ${fmt(bar * 100, 0)} kPa</div>
    <div>${fmt(kw, 2)} kW = ${fmt(calc.conversions.kwToKcalh(kw), 0)} kcal/h = ${fmt(calc.conversions.kwToBtuh(kw), 0)} BTU/h</div>`;
}

const CALC_BINDINGS = [
  ["c-deb-", calcDebit],
  ["c-pm-", calcDebit],
  ["c-tub-", calcTube],
  ["c-le-", calcLoiEau],
  ["c-ve-", calcVase],
  ["c-vm-", calcVolumeMini],
  ["c-fr-", calcFrigo],
  ["c-kv-", calcKv],
  ["c-dp-", calcDeperditions],
  ["c-cv-", calcConversions],
];
$("#view-calc").addEventListener("input", (e) => {
  if (e.target.id === "c-tub-q") e.target.dataset.touched = "1";
  const binding = CALC_BINDINGS.find(([prefix]) => e.target.id.startsWith(prefix));
  binding?.[1]();
});
CALC_BINDINGS.forEach(([, fn]) => fn());

$("#calc-ask").addEventListener("click", () => {
  const lines = Object.values(summaries);
  startChatWith(
    "parametrage",
    `Voici mes calculs :\n- ${lines.join("\n- ")}\n\nVérifie-les et donne-moi la fiche de réglage complète (circulateur, débit, loi d'eau, sécurités, paramètres de la régulation).`,
  );
});

// ---------- Identité visuelle ----------
function applyBrand(b) {
  state.brand = b;
  const root = document.documentElement.style;
  root.setProperty("--brand", b.couleurPrimaire);
  root.setProperty("--brand-accent", b.couleurAccent);
  $('meta[name="theme-color"]').content = b.couleurPrimaire;
  $("#brand-name").textContent = b.nom;
  $("#brand-slogan").textContent = b.slogan;
  $("#brand-logo").src = `/brand/logo?t=${Date.now()}`;
  document.title = `${b.nom} – Dépannage CVC`;
}

$("#settings-btn").addEventListener("click", () => {
  const b = state.brand;
  const dlg = $("#dlg");
  dlg.innerHTML = `
    <h2 style="margin-top:0">Paramètres de l'entreprise</h2>
    <div class="row" style="gap:12px;margin-bottom:12px">
      <span class="logo-pill" style="border:1px solid var(--border)"><img id="set-logo" src="/brand/logo?t=${Date.now()}" alt="Logo"></span>
      <label class="btn small">Changer le logo<input type="file" accept="image/png,image/jpeg,image/webp" id="set-logo-file" hidden></label>
      ${b.logoPerso ? `<button class="btn small" data-act="logo-reset">Logo par défaut</button>` : ""}
    </div>
    <form class="grid" id="brand-form">
      <label class="f">Nom<input name="nom" value="${esc(b.nom)}"></label>
      <label class="f">Slogan<input name="slogan" value="${esc(b.slogan)}"></label>
      <label class="f">Couleur principale<input type="color" name="couleurPrimaire" value="${esc(b.couleurPrimaire)}"></label>
      <label class="f">Couleur d'accent<input type="color" name="couleurAccent" value="${esc(b.couleurAccent)}"></label>
      <label class="f">Téléphone<input name="telephone" value="${esc(b.telephone)}"></label>
      <label class="f">E-mail<input name="email" value="${esc(b.email)}"></label>
      <label class="f full">Adresse<input name="adresse" value="${esc(b.adresse)}"></label>
      <label class="f full">Site web<input name="site" value="${esc(b.site)}"></label>
    </form>
    <p class="muted">Logo : PNG ou JPEG, de préférence horizontal et sur fond transparent ou blanc. Il apparaît dans l'en-tête et sur les rapports d'intervention.</p>
    <div class="row" style="margin-top:12px;justify-content:flex-end">
      <button class="btn" data-act="close">Annuler</button><button class="btn primary" data-act="save">Enregistrer</button>
    </div>`;
  const form = $("#brand-form");
  form.addEventListener("input", () => {
    const d = formData(form);
    applyBrand({ ...state.brand, ...d });
    state.brand = b; // aperçu seulement tant que non enregistré
  });
  $("#set-logo-file").addEventListener("change", async (e) => {
    const fd = new FormData();
    fd.append("logo", e.target.files[0]);
    const res = await fetch("/api/brand/logo", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) return toast(data.error, 5000);
    b.logoPerso = true;
    $("#set-logo").src = `/brand/logo?t=${Date.now()}`;
    $("#brand-logo").src = `/brand/logo?t=${Date.now()}`;
    toast("Logo mis à jour");
  });
  dlg.onclick = async (ev) => {
    const act = ev.target.dataset.act;
    if (act === "close") {
      applyBrand(b);
      dlg.close();
    }
    if (act === "logo-reset") {
      await api("/api/brand/logo", { method: "DELETE" });
      b.logoPerso = false;
      applyBrand(b);
      dlg.close();
    }
    if (act === "save") {
      try {
        const saved = await api("/api/brand", { method: "PUT", json: formData(form) });
        applyBrand({ ...saved, logoPerso: b.logoPerso });
        dlg.close();
        toast("Paramètres enregistrés");
      } catch (err) {
        toast(err.message, 5000);
      }
    }
  };
  dlg.showModal();
});

// ---------- Codes erreur ----------
const CAT_LABELS = { verrouillage: "Verrouillage", blocage: "Blocage", avertissement: "Avertissement", information: "Information", inconnu: "Non classé" };

function ficheItem(f) {
  return `<div class="item" data-fiche="${esc(f.id)}" style="cursor:pointer">
    <span class="code-pill">${esc(f.code)}</span>
    <div class="grow"><div class="title">${esc(f.titre || f.signification || "")}</div>
      <div class="muted">${esc([f.marque, f.modele].filter(Boolean).join(" · "))}</div></div>
    ${f.favori ? "★" : ""}
  </div>`;
}

function renderFiche(f) {
  const has = (arr) => Array.isArray(arr) && arr.length > 0;
  return `<div class="card fiche" data-id="${esc(f.id)}">
    <div class="fiche-head">
      <div class="code-badge">${esc(f.code)}</div>
      <div class="grow">
        <h2 style="margin:0">${esc(f.titre || "Défaut")}</h2>
        <div class="muted">${esc([f.marque, f.modele].filter(Boolean).join(" · "))}</div>
        <div class="row" style="margin-top:4px"><span class="cat ${esc(f.categorie)}">${esc(CAT_LABELS[f.categorie] || f.categorie || "")}</span>
          <span class="badge ${f.confiance === "haute" ? "ok" : "warn"}">fiabilité ${esc(f.confiance || "?")}</span>${f.demo ? `<span class="badge warn">exemple démo</span>` : ""}</div>
      </div>
    </div>
    ${f.securite ? `<div class="banner" style="margin:12px 0 0">⚠️ ${esc(f.securite)}</div>` : ""}
    <h3>Signification</h3><p>${esc(f.signification)}</p>
    ${f.organe ? `<p><strong>Organe surveillé :</strong> ${esc(f.organe)}</p>` : ""}
    ${f.declenchement ? `<p><strong>Déclenchement :</strong> ${esc(f.declenchement)}</p>` : ""}
    ${has(f.causes) ? `<h3>Causes probables et contrôles</h3><ol class="causes">${f.causes
      .map((c) => `<li><span class="prob ${esc(c.probabilite)}">${esc(c.probabilite || "")}</span> <strong>${esc(c.cause)}</strong><br><span class="muted">${esc(c.verification)}</span></li>`)
      .join("")}</ol>` : ""}
    ${has(f.procedure) ? `<h3>Procédure de dépannage</h3><ol>${f.procedure.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>` : ""}
    ${has(f.pieces) ? `<h3>Pièces à contrôler / remplacer</h3><div class="list">${f.pieces
      .map(
        (p, i) => `<div class="item"><div class="grow"><div class="title">${esc(p.designation)}</div><div class="muted">${esc(p.reference || "réf. à confirmer")}</div></div>
        <button class="btn small" data-add-piece="${i}">+ Liste</button><button class="btn small" data-find-piece="${i}">Réf.</button></div>`,
      )
      .join("")}</div>` : ""}
    ${f.reinitialisation ? `<h3>Réinitialisation</h3><p>${esc(f.reinitialisation)}</p>` : ""}
    ${
      has(f.docsLocales) && f.docsLocales.some((d) => d.extrait)
        ? `<h3>📚 Dans vos notices</h3><div class="list">${f.docsLocales
            .map((d) => `<div class="hit"><a href="/api/docs/${encodeURIComponent(d.docId)}/file#page=${d.page}" target="_blank">${esc(d.titre)} — page ${d.page}</a><div>${esc(d.extrait || "")}</div></div>`)
            .join("")}</div>`
        : ""
    }
    ${
      has(f.docsLocales) || has(f.sources)
        ? `<div class="sources muted" style="margin-top:10px">Sources : ${[
            ...(f.docsLocales || []).map((d) => `<a href="/api/docs/${encodeURIComponent(d.docId)}/file#page=${d.page}" target="_blank">${esc(d.titre)} p.${d.page}</a>`),
            ...(f.sources || []).filter((u) => /^https?:\/\//.test(u)).map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(new URL(u).hostname)}</a>`),
          ].join(" · ")}</div>`
        : ""
    }
    <div class="row" style="margin-top:12px">
      <button class="btn primary" data-fact="diag">🩺 Diagnostic guidé</button>
      ${
        f.demo
          ? ""
          : `<button class="btn" data-fact="fav">${f.favori ? "★ Retirer des favoris" : "☆ Favori"}</button>
      <button class="btn" data-fact="refresh">Mettre à jour</button>
      <button class="btn danger" data-fact="del">Supprimer</button>`
      }
    </div>
  </div>`;
}

function showFiches(fiches) {
  $("#code-result").innerHTML = fiches.map(renderFiche).join("");
}

$("#code-result").addEventListener("click", async (e) => {
  const card = e.target.closest(".fiche");
  if (!card) return;
  const f = state.codes.find((x) => x.id === card.dataset.id) || (state.demoFiche?.id === card.dataset.id && state.demoFiche);
  if (!f) return;
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.addPiece !== undefined) {
    const p = f.pieces[Number(t.dataset.addPiece)];
    await api("/api/pieces", { json: { designation: p.designation, reference: p.reference || "", equipementId: state.currentEquip } });
    toast("Ajoutée à la liste de pièces");
    return refreshData();
  }
  if (t.dataset.findPiece !== undefined) {
    const p = f.pieces[Number(t.dataset.findPiece)];
    const form = $("#piece-form");
    form.marque.value = f.marque;
    form.modele.value = f.modele || "";
    form.piece.value = [p.designation, p.reference].filter(Boolean).join(" ");
    showView("pieces");
    return form.requestSubmit();
  }
  const act = t.dataset.fact;
  if (act === "diag")
    startChatWith(
      "diagnostic",
      `${f.marque} ${f.modele || ""} en défaut ${f.code} (${f.titre}). Guide-moi pas à pas pour trouver la cause.`.replace(/\s+/g, " "),
    );
  if (act === "fav") {
    await api(`/api/codes/${f.id}`, { method: "PATCH", json: { favori: !f.favori } });
    await refreshData();
    showFiches([state.codes.find((x) => x.id === f.id)]);
  }
  if (act === "refresh") lookupCode({ marque: f.marque, modele: f.modele, code: f.code }, true);
  if (act === "del" && confirm("Supprimer cette fiche de la base ?")) {
    await api(`/api/codes/${f.id}`, { method: "DELETE" });
    card.remove();
    refreshData();
  }
});

async function lookupCode(q, forceOnline = false) {
  const status = $("#code-status");
  if (!forceOnline) {
    const local = await api(`/api/codes?marque=${encodeURIComponent(q.marque)}&code=${encodeURIComponent(q.code)}`);
    if (local.length) {
      status.innerHTML = `${local.length} fiche(s) dans votre base. <button class="btn small" id="code-online">Chercher aussi en ligne</button>`;
      $("#code-online").onclick = () => lookupCode(q, true);
      return showFiches(local);
    }
  }
  $("#code-result").innerHTML = `<div class="card"><div class="msg assistant" id="code-live" style="border:0;padding:0"></div></div>`;
  let text = "";
  status.innerHTML = `<span class="spinner"></span> Recherche de ${esc(q.code)} chez ${esc(q.marque)}…`;
  try {
    await streamPost("/api/codes/recherche", q, (ev) => {
      if (ev.type === "status") status.innerHTML = `<span class="spinner"></span> ${esc(ev.text)}`;
      if (ev.type === "text") {
        text += ev.text;
        $("#code-live").innerHTML = md(text.split("```json")[0]);
      }
      if (ev.type === "error") toast(ev.text, 6000);
      if (ev.type === "fiche") {
        if (ev.fiche.demo) state.demoFiche = ev.fiche;
        else state.codes.unshift(ev.fiche);
        showFiches([ev.fiche]);
      }
    });
    status.textContent = state.demoFiche?.code === q.code
      ? "Mode démo : fiche non enregistrée. Ajoutez la clé API pour obtenir la fiche complète."
      : "Fiche enregistrée dans votre base (consultable hors ligne).";
    refreshData();
  } catch (err) {
    status.textContent = `Échec : ${err.message}`;
  }
}

$("#code-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = formData(e.target);
  lookupCode({ marque: q.marque.trim(), modele: q.modele.trim(), code: q.code.trim() });
});

function renderCodes() {
  const f = $("#code-filter").value.trim().toLowerCase();
  const items = state.codes.filter((c) => !f || `${c.marque} ${c.modele} ${c.code} ${c.titre}`.toLowerCase().includes(f));
  $("#code-list").innerHTML = items.map(ficheItem).join("") || `<p class="muted">Aucune fiche pour l'instant : chaque recherche enrichit votre base.</p>`;
  const favs = state.codes.filter((c) => c.favori);
  $("#home-favs-card").hidden = !favs.length;
  $("#home-favs").innerHTML = favs.slice(0, 8).map(ficheItem).join("");
  $("#home-recent").innerHTML =
    state.codes.slice(0, 6).map(ficheItem).join("") || `<p class="muted">Recherchez un code erreur pour créer votre première fiche.</p>`;
}
$("#code-filter").addEventListener("input", renderCodes);

function openFiche(id) {
  const f = state.codes.find((x) => x.id === id);
  if (!f) return;
  showView("codes");
  showFiches([f]);
}
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-fiche]");
  if (el && !e.target.closest("button")) openFiche(el.dataset.fiche);
});

// Pré-remplit la marque avec l'appareil en cours
function prefillCodeForm() {
  const eq = getEquip(state.currentEquip);
  const form = $("#code-form");
  if (eq && !form.marque.value) {
    form.marque.value = eq.fabricant || "";
    form.modele.value = [eq.gamme, eq.modele].filter(Boolean).join(" ");
  }
}
document.querySelector('#tabs [data-view="codes"]').addEventListener("click", prefillCodeForm);

// ---------- Recherche globale (accueil) ----------
let homeTimer;
$("#home-search").addEventListener("input", (e) => {
  clearTimeout(homeTimer);
  const q = e.target.value.trim();
  homeTimer = setTimeout(async () => {
    const box = $("#home-results");
    if (q.length < 2) return (box.innerHTML = "");
    const r = await api(`/api/recherche?q=${encodeURIComponent(q)}`);
    const looksLikeCode = /^[a-z]{0,3}[\s.-]?\d{1,4}[a-z]?$/i.test(q);
    box.innerHTML = [
      r.codes.length ? `<h4>Fiches codes erreur</h4>${r.codes.map(ficheItem).join("")}` : "",
      looksLikeCode
        ? `<button class="btn accent" id="home-code-btn">Chercher le code « ${esc(q)} » pour une marque…</button>`
        : "",
      r.equipements.length
        ? `<h4>Parc</h4>${r.equipements.map((eq) => `<div class="item"><div class="grow"><div class="title">${esc(equipLabel(eq))}</div><div class="muted">${esc(eq.adresse || eq.reference || "")}</div></div><button class="btn small" data-equip-open="${esc(eq.id)}">Ouvrir</button></div>`).join("")}`
        : "",
      r.docs.length
        ? `<h4>Dans vos documentations</h4>${r.docs.map((h) => `<div class="hit"><a href="/api/docs/${encodeURIComponent(h.docId)}/file#page=${h.page}" target="_blank">${esc(h.titre)} — p.${h.page}</a><div>${esc(h.extrait)}</div></div>`).join("")}`
        : "",
      !r.codes.length && !r.equipements.length && !r.docs.length && !looksLikeCode
        ? `<button class="btn accent" id="home-ask-btn">Poser la question à l'assistant</button>`
        : "",
    ].join("");
    $("#home-code-btn")?.addEventListener("click", () => {
      showView("codes");
      $("#code-form").code.value = q;
      prefillCodeForm();
      $("#code-form").marque.focus();
    });
    $("#home-ask-btn")?.addEventListener("click", () => startChatWith("question", q));
  }, 250);
});
$("#home-results").addEventListener("click", (e) => {
  const id = e.target.closest("[data-equip-open]")?.dataset.equipOpen;
  if (id) openEquip(id);
});

// ---------- Pièces détachées ----------
const STATUTS = { a_commander: "À commander", commandee: "Commandée", recue: "Reçue", posee: "Posée" };

$("#piece-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = formData(e.target);
  const status = $("#piece-status");
  const box = $("#piece-results");
  box.innerHTML = "";
  let text = "";
  status.innerHTML = `<span class="spinner"></span> Recherche…`;
  try {
    await streamPost("/api/pieces/trouver", q, (ev) => {
      if (ev.type === "status") status.innerHTML = `<span class="spinner"></span> ${esc(ev.text)}`;
      if (ev.type === "text") text += ev.text;
      if (ev.type === "error") toast(ev.text, 6000);
      if (ev.type === "result") {
        box._items = ev.pieces;
        box.innerHTML =
          `<div class="muted">${md(text.split("```json")[0])}</div>` +
          (ev.pieces
            .map(
              (p, i) => `<div class="item"><div class="grow">
              <div class="title">${esc(p.designation)} ${p.reference ? `<span class="code-pill">${esc(p.reference)}</span>` : ""}</div>
              <div class="muted">${esc([p.compatibilite, p.remarque, p.prix, p.source].filter(Boolean).join(" · "))}</div></div>
              ${p.url ? `<a class="btn small" href="${esc(p.url)}" target="_blank" rel="noopener">Voir</a>` : ""}
              <button class="btn small primary" data-piece-add="${i}">+ Liste</button></div>`,
            )
            .join("") || `<p class="muted">Aucune référence trouvée. Précisez le modèle ou le n° de série.</p>`);
      }
    });
    status.textContent = "";
  } catch (err) {
    status.textContent = `Échec : ${err.message}`;
  }
});

$("#piece-results").addEventListener("click", async (e) => {
  const i = e.target.dataset.pieceAdd;
  if (i === undefined) return;
  const p = $("#piece-results")._items[Number(i)];
  await api("/api/pieces", {
    json: { designation: p.designation, reference: p.reference || "", url: p.url || "", source: p.source || "", prix: p.prix || "", equipementId: state.currentEquip },
  });
  e.target.textContent = "✓";
  refreshData();
});

function renderPieces() {
  $("#piece-list").innerHTML =
    state.pieces
      .map(
        (p) => `<div class="item">
        <div class="grow"><div class="title">${p.quantite} × ${esc(p.designation)} ${p.reference ? `<span class="code-pill">${esc(p.reference)}</span>` : ""}</div>
          <div class="muted">${esc([getEquip(p.equipementId) && equipLabel(getEquip(p.equipementId)), p.prix, p.source].filter(Boolean).join(" · "))}</div></div>
        <select data-piece-statut="${esc(p.id)}" style="width:auto">${Object.entries(STATUTS)
          .map(([k, v]) => `<option value="${k}" ${k === p.statut ? "selected" : ""}>${v}</option>`)
          .join("")}</select>
        ${p.url ? `<a class="btn small" href="${esc(p.url)}" target="_blank" rel="noopener">↗</a>` : ""}
        <button class="btn small danger" data-piece-del="${esc(p.id)}">✕</button>
      </div>`,
      )
      .join("") || `<p class="muted">Aucune pièce. Ajoutez-en depuis une fiche code erreur ou une recherche.</p>`;
}

$("#piece-list").addEventListener("change", async (e) => {
  const id = e.target.dataset.pieceStatut;
  if (id) await api(`/api/pieces/${id}`, { method: "PATCH", json: { statut: e.target.value } });
});
$("#piece-list").addEventListener("click", async (e) => {
  const id = e.target.dataset.pieceDel;
  if (!id) return;
  await api(`/api/pieces/${id}`, { method: "DELETE" });
  refreshData();
});
$("#piece-add").addEventListener("click", async () => {
  const designation = prompt("Désignation de la pièce ?");
  if (!designation) return;
  const reference = prompt("Référence (optionnel) ?") || "";
  await api("/api/pieces", { json: { designation, reference, equipementId: state.currentEquip } });
  refreshData();
});
$("#piece-copy").addEventListener("click", async () => {
  const text = state.pieces
    .filter((p) => p.statut === "a_commander")
    .map((p) => `${p.quantite} x ${p.designation}${p.reference ? ` — réf. ${p.reference}` : ""}`)
    .join("\n");
  try {
    await navigator.clipboard.writeText(text || "(aucune pièce à commander)");
    toast("Liste des pièces à commander copiée");
  } catch {
    toast("Copie impossible sur ce navigateur");
  }
});

// ---------- Rapport d'intervention ----------
$("#chat-report").addEventListener("click", () => {
  const s = state.session;
  if (!s.messages.length) return toast("Aucun échange à mettre dans le rapport.");
  const b = state.brand;
  const eq = getEquip(s.equipId);
  const pieces = state.pieces.filter((p) => eq && p.equipementId === eq.id);
  const w = window.open("", "_blank");
  if (!w) return toast("Autorisez les fenêtres pop-up pour générer le rapport.");
  w.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Rapport d'intervention – ${esc(b.nom)}</title>
  <style>
    body { font: 13px/1.5 system-ui, sans-serif; color: #111; margin: 24px; }
    header { display: flex; justify-content: space-between; align-items: center; border-bottom: 4px solid ${esc(b.couleurAccent)}; padding-bottom: 12px; }
    header img { max-height: 110px; max-width: 240px; }
    header .co { text-align: right; font-size: 12px; color: #444; }
    h1 { color: ${esc(b.couleurPrimaire)}; font-size: 20px; margin: 18px 0 6px; }
    h2 { color: ${esc(b.couleurPrimaire)}; font-size: 15px; border-bottom: 1px solid #ddd; padding-bottom: 3px; margin-top: 18px; }
    table { border-collapse: collapse; width: 100%; } td, th { border: 1px solid #ddd; padding: 4px 8px; text-align: left; vertical-align: top; }
    .q { background: #f3f5f8; border-left: 3px solid ${esc(b.couleurPrimaire)}; padding: 6px 10px; margin: 8px 0; white-space: pre-wrap; }
    pre { white-space: pre-wrap; } .sign { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 30px; } .sign div { border: 1px solid #ccc; height: 90px; padding: 6px; }
    @media print { button { display: none; } }
  </style></head><body>
  <header><img src="${location.origin}/brand/logo" alt="${esc(b.nom)}"><div class="co"><strong>${esc(b.nom)}</strong><br>${esc(b.slogan)}<br>${esc(b.adresse)}<br>${esc([b.telephone, b.email].filter(Boolean).join(" · "))}<br>${esc(b.site)}</div></header>
  <h1>Rapport d'intervention</h1>
  <div>Date : ${new Date(s.updatedAt).toLocaleString("fr-FR")}</div>
  ${
    eq
      ? `<h2>Appareil</h2><table>${[
          ["Client", eq.client], ["Adresse", eq.adresse], ["Type", eq.type_equipement], ["Marque / modèle", [eq.fabricant, eq.gamme, eq.modele].filter(Boolean).join(" ")],
          ["Référence", eq.reference], ["N° de série", eq.numero_serie], ["Fluide", [eq.fluide_frigorigene, eq.charge_fluide].filter(Boolean).join(" – ")],
        ]
          .filter(([, v]) => v)
          .map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`)
          .join("")}</table>`
      : ""
  }
  <h2>Déroulé du diagnostic</h2>
  ${s.messages.map((m) => (m.role === "user" ? `<div class="q">${esc(m.content)}</div>` : `<div>${md(m.content)}</div>`)).join("")}
  ${pieces.length ? `<h2>Pièces</h2><table><tr><th>Qté</th><th>Désignation</th><th>Référence</th><th>Statut</th></tr>${pieces.map((p) => `<tr><td>${p.quantite}</td><td>${esc(p.designation)}</td><td>${esc(p.reference)}</td><td>${STATUTS[p.statut]}</td></tr>`).join("")}</table>` : ""}
  <div class="sign"><div>Signature du technicien</div><div>Signature du client</div></div>
  <p><button onclick="print()">Imprimer / enregistrer en PDF</button></p>
  </body></html>`);
  w.document.close();
});

// ---------- Démarrage ----------
async function init() {
  newSession();
  try {
    applyBrand(await api("/api/brand"));
    const status = await api("/api/status");
    if (status.demo && !storage.get("cvc.demoBannerClosed", false)) {
      $("#banner").innerHTML = `<div class="banner row" style="flex-wrap:nowrap"><span style="flex:1">🧪 <strong>Mode démo</strong> : l'IA donne des réponses d'exemple. Calculs, docs PDF, parc, pièces et rapports sont réels.</span><button class="btn small" id="banner-close" aria-label="Fermer">✕</button></div>`;
      $("#banner-close").onclick = () => {
        storage.set("cvc.demoBannerClosed", true);
        $("#banner").innerHTML = "";
      };
    }
    await refreshData();
  } catch (err) {
    $("#banner").innerHTML = `<div class="banner">Serveur injoignable (${esc(err.message)}). Mode hors ligne : seuls les calculs sont disponibles.</div>`;
  }
}
init();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
