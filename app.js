'use strict';

const APP_VERSION = '1.12.0';
const APP_NAME = 'Horstl-Powers Rezeptbuch';
const CATEGORIES = ['Frühstück', 'Vorspeise', 'Suppe', 'Salat', 'Hauptgericht', 'Beilage',
  'Dessert', 'Kuchen & Gebäck', 'Getränk', 'Sonstiges'];

const $view = document.getElementById('view');
const state = { q: '', cat: 'Alle', checked: {} };
let backTarget = null;

/* =========================================================
   Datenbank (IndexedDB) – alles bleibt lokal auf dem Gerät
   ========================================================= */
let dbPromise;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('rezeptbuch', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('recipes')) db.createObjectStore('recipes', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => {
        const db = req.result;
        // Safari (iPhone) schließt die Verbindung gern, wenn die App im Hintergrund war.
        // Dann beim nächsten Zugriff einfach neu öffnen.
        db.onclose = () => { dbPromise = null; };
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => { dbPromise = null; reject(req.error); };
      req.onblocked = () => { dbPromise = null; reject(new Error('Datenbank ist blockiert – bitte die App neu öffnen.')); };
    });
  }
  return dbPromise;
}
// Fehler, bei denen eine frische Verbindung hilft
const RETRYABLE = ['InvalidStateError', 'UnknownError', 'TransactionInactiveError'];
function tx(store, mode, fn, retry = true) {
  const again = err => {
    dbPromise = null;
    if (retry && err && RETRYABLE.includes(err.name)) return tx(store, mode, fn, false);
    throw err;
  };
  return openDb().then(db => new Promise((resolve, reject) => {
    let t, req;
    try {
      t = db.transaction(store, mode);
      req = fn(t.objectStore(store));
    } catch (err) { reject(err); return; }
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new DOMException('Abgebrochen', 'UnknownError'));
  })).catch(again);
}
const Store = {
  all: () => tx('recipes', 'readonly', s => s.getAll()),
  get: id => tx('recipes', 'readonly', s => s.get(id)),
  put: r => tx('recipes', 'readwrite', s => s.put(r)),
  del: id => tx('recipes', 'readwrite', s => s.delete(id)),
  getKV: k => tx('kv', 'readonly', s => s.get(k)),
  setKV: (k, v) => tx('kv', 'readwrite', s => s.put(v, k)),
};

/* =========================================================
   Helfer
   ========================================================= */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function uid() {
  return (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
}
function lines(s) {
  return String(s || '').split('\n').map(l => l.trim()).filter(Boolean);
}
function safeImg(src) {
  return typeof src === 'string' && src.startsWith('data:image/') ? src : '';
}
function safeUrl(u) {
  return /^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : '';
}
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}
/* Fehler gut sichtbar melden – ein Hinweis unten kann auf dem iPhone
   hinter der Tastatur verschwinden, ein Dialog nicht. */
function showError(msg) {
  toast(msg);
  setTimeout(() => alert(msg), 50);
}
function setHeader(title, back, actionsHtml = '') {
  document.getElementById('title').textContent = title;
  backTarget = back;
  document.getElementById('backBtn').hidden = !back;
  document.getElementById('topActions').innerHTML = actionsHtml;
}
function setTab(name) {
  document.querySelectorAll('.tabbar a').forEach(a => a.classList.toggle('active', a.dataset.tab === name));
}

/* Schnellauswahl beim Rezept anlegen. Das sind nur die Startwerte –
   der Nutzer pflegt die Listen selbst unter „Mehr“ (kv `spiceList` / `opList`). */
const STANDARD_SPICES = ['Salz', 'Pfeffer', 'Oregano', 'Basilikum', 'Kümmel', 'Paprikapulver'];
const STANDARD_OPS = ['Anbraten', 'Rösten', 'Anschwitzen', 'Kochen', 'Köcheln lassen', 'Dünsten',
  'Schmoren', 'Braten', 'Backen', 'Aufkochen', 'Ablöschen', 'Würzen', 'Abschmecken',
  'Verrühren', 'Pürieren', 'Ruhen lassen'];
const LISTS = {
  gewuerze: { key: 'spiceList', title: 'Gewürze', icon: '🌿', defaults: STANDARD_SPICES,
    placeholder: 'z. B. Majoran', hint: 'Diese Gewürze kannst du beim Anlegen eines Rezepts antippen.' },
  schritte: { key: 'opList', title: 'Arbeitsschritte', icon: '🍳', defaults: STANDARD_OPS,
    placeholder: 'z. B. Karamellisieren', hint: 'Diese Wörter kannst du bei der Zubereitung antippen, statt sie zu tippen.' },
};
function cleanList(arr) {
  const seen = new Set();
  return (arr || []).map(s => String(s).trim()).filter(s => {
    const k = s.toLowerCase();
    if (!s || seen.has(k)) return false;
    seen.add(k); return true;
  });
}
async function getList(kind) {
  const v = await Store.getKV(LISTS[kind].key);
  return Array.isArray(v) ? cleanList(v) : [...LISTS[kind].defaults];
}
function setList(kind, arr) {
  return Store.setKV(LISTS[kind].key, cleanList(arr));
}

/* Zutaten + Gewürze als eine Liste (Index < ingredients.length = Zutat, sonst Gewürz) */
function allIngs(r) {
  return [...r.ingredients, ...(r.spices || [])];
}
/* Listeneinträge für Rezept- und Abhak-Ansicht: Zutaten oben, Gewürze unten */
function ingListHtml(r, factor, have) {
  const li = (line, i) => `
    <li data-i="${i}" class="${have.has(i) ? 'have' : ''}">
      <span class="t">${esc(scaleLine(line, factor))}</span>
      ${have.has(i) ? '<span class="tag">zuhause</span>' : ''}
    </li>`;
  const n = r.ingredients.length;
  const spices = r.spices || [];
  return r.ingredients.map(li).join('') +
    (spices.length ? `<li class="sub">🌿 Gewürze</li>` + spices.map((s, j) => li(s, n + j)).join('') : '');
}

/* Rezept aus beliebigen Daten in ein sauberes Format bringen
   (für Formular und Import gleichermaßen) */
function normalize(x) {
  if (!x || typeof x !== 'object') return null;
  const title = String(x.title || '').trim();
  if (!title) return null;
  const arr = v => Array.isArray(v) ? v.map(s => String(s).trim()).filter(Boolean) : lines(v);
  const now = Date.now();
  return {
    id: String(x.id || uid()),
    title,
    category: String(x.category || '').trim(),
    servings: Math.max(0, Math.min(1000, parseInt(x.servings, 10) || 0)),
    time: String(x.time || '').trim(),
    ingredients: arr(x.ingredients),
    spices: arr(x.spices),
    steps: arr(x.steps),
    notes: String(x.notes || '').trim(),
    source: String(x.source || '').trim(),
    photo: safeImg(x.photo),
    favorite: !!x.favorite,
    createdAt: Number(x.createdAt) || now,
    updatedAt: Number(x.updatedAt) || now,
  };
}

/* =========================================================
   Mengen umrechnen ("200 g Mehl", "1 1/2 TL", "2-3 Eier", "½ Zitrone")
   ========================================================= */
const FRAC = { '½': 1 / 2, '¼': 1 / 4, '¾': 3 / 4, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 1 / 8 };
const QTY_RE = /^\s*(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?\s*[½¼¾⅓⅔⅛]?|[½¼¾⅓⅔⅛])(?:\s*[-–]\s*(\d+(?:[.,]\d+)?))?\s*(.*)$/;

function toNum(s) {
  s = s.trim();
  let n = 0;
  for (const [k, v] of Object.entries(FRAC)) {
    if (s.includes(k)) { n += v; s = s.replace(k, '').trim(); }
  }
  if (!s) return n;
  if (/\s/.test(s)) { const [w, f] = s.split(/\s+/); return n + Number(w) + toNum(f); }
  if (s.includes('/')) { const [a, b] = s.split('/'); return n + Number(a) / Number(b); }
  return n + parseFloat(s.replace(',', '.'));
}
function fmtNum(n) {
  if (n >= 10) return String(Math.round(n));
  const r = Math.round(n * 100) / 100;
  const w = Math.floor(r);
  const f = Math.round((r - w) * 100) / 100;
  const sym = { 0.25: '¼', 0.5: '½', 0.75: '¾', 0.33: '⅓', 0.67: '⅔' }[f];
  if (f === 0) return String(w);
  if (sym) return (w ? w : '') + sym;
  return String(r).replace('.', ',');
}
function scaleLine(line, factor) {
  if (factor === 1) return line;
  const m = line.match(QTY_RE);
  if (!m) return line;
  const q1 = toNum(m[1]);
  if (!isFinite(q1)) return line;
  let out = fmtNum(q1 * factor);
  if (m[2]) out += '–' + fmtNum(toNum(m[2]) * factor);
  return out + (m[3] ? ' ' + m[3] : '');
}

/* =========================================================
   Router
   ========================================================= */
async function route() {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  const params = new URLSearchParams(query);
  window.scrollTo(0, 0);
  document.body.classList.remove('home');
  try {
    if (!parts.length) return await viewList(false);
    switch (parts[0]) {
      case 'favoriten': return await viewList(true);
      case 'rezept': return await viewDetail(decodeURIComponent(parts[1] || ''));
      case 'neu': return await viewEdit(null);
      case 'bearbeiten': return await viewEdit(decodeURIComponent(parts[1] || ''));
      case 'einkauf':
        if (parts[1] === 'auswahl') return await viewPickRecipe();
        if (parts[1] === 'rezept') return await viewShopCheck(decodeURIComponent(parts[2] || ''), params);
        return await viewShopping();
      case 'vorrat':
        if (parts[1] === 'kochen') return await viewPantryMatch();
        return await viewPantry();
      case 'tiefkuehl':
        if (parts[1]) return await viewFreezerItem(decodeURIComponent(parts[1]));
        return await viewFreezer();
      case 'mehr':
        if (parts[1] === 'liste' && LISTS[parts[2]]) return await viewListEdit(parts[2]);
        return await viewMore();
      default: location.hash = '#/';
    }
  } catch (e) {
    console.error(e);
    $view.innerHTML = `<div class="empty">Da ist etwas schiefgelaufen:<br>${esc(e.message)}</div>`;
  }
}

/* =========================================================
   Ansicht: Rezeptliste / Favoriten
   ========================================================= */
function card(r, href) {
  const img = safeImg(r.photo);
  const meta = [r.category, r.time].filter(Boolean).join(' · ');
  return `<li><a class="card" href="${esc(href || '#/rezept/' + encodeURIComponent(r.id))}">
    ${img ? `<img class="thumb" src="${esc(img)}" alt="" loading="lazy">` : '<div class="thumb">🍽️</div>'}
    <div class="card-body">
      <div class="card-title">${esc(r.title)}</div>
      <div class="meta">${esc(meta)}</div>
    </div>
    ${r.favorite ? '<span class="star" aria-label="Favorit">★</span>' : ''}
  </a></li>`;
}

/* Hintergrundfoto der Startseite (IndexedDB-Store `kv`, Schlüssel `bgPhoto`) */
async function applyBackground() {
  const img = safeImg(await Store.getKV('bgPhoto'));
  const el = document.getElementById('bgPhoto');
  el.style.backgroundImage = img ? `url("${img}")` : '';
  document.body.classList.toggle('has-bg', !!img);
  return img;
}
async function setBackground(file) {
  try {
    const img = await compressImage(file, 1600, 0.82);
    await Store.setKV('bgPhoto', img);
    await applyBackground();
    toast('Hintergrundfoto gespeichert');
  } catch (e) {
    showError('Das Foto konnte nicht übernommen werden: ' + e.message);
  }
}
async function removeBackground() {
  await Store.setKV('bgPhoto', '');
  await applyBackground();
  toast('Hintergrundfoto entfernt');
}
function bindBgInput(input) {
  input.onchange = async () => {
    const file = input.files[0];
    input.value = '';
    if (file) await setBackground(file);
  };
}
function homeHero(withRandom) {
  return `<section class="home-hero">
    <h2 class="home-name">Horstl-Powers<span>Rezeptbuch</span></h2>
    ${withRandom ? '<button class="random-btn" id="randomBtn">🎲 Was koche ich heute?</button>' : ''}
  </section>
  <div id="randomPick"></div>`;
}

/* „Was koche ich heute?“ – Grobauswahl nach Hauptzutat.
   Erkannt wird über Stichwörter in Titel und Zutaten (kein eigenes Feld im Rezept).
   `start` = Stichwort muss am Wortanfang stehen, `any` = darf auch mitten im Wort stehen. */
const MOOD_WORDS = {
  fleisch: {
    any: ['fleisch', 'faschiert', 'schnitzel', 'gulasch', 'wurst', 'würstel', 'speck', 'schinken', 'hähnchen', 'hendl',
      'huhn', 'hühner', 'geflügel', 'steak', 'frikadell', 'leberkäs', 'bacon', 'salami', 'kotelett', 'roulade'],
    start: ['rind', 'schwein', 'hack', 'kalb', 'lamm', 'pute', 'ente', 'gans', 'wild', 'reh', 'hirsch', 'chicken', 'beef'],
  },
  fisch: {
    any: ['fisch', 'lachs', 'forelle', 'thunfisch', 'kabeljau', 'zander', 'garnele', 'shrimp', 'scampi',
      'meeresfrücht', 'hering', 'makrele', 'sardin', 'muschel', 'tintenfisch', 'calamar', 'karpfen', 'saibling'],
    start: ['dorsch', 'seelachs', 'scholle', 'barsch'],
  },
  kartoffel: { any: ['kartoffel', 'erdäpfel', 'erdapfel', 'pommes', 'rösti', 'gnocchi', 'reiberdatschi', 'kartoffelknödel'], start: [] },
  nudeln: {
    any: ['nudel', 'spaghetti', 'pasta', 'penne', 'lasagne', 'spätzle', 'tagliatelle', 'makkaroni', 'maccheroni',
      'fusilli', 'farfalle', 'rigatoni', 'tortellini', 'ravioli', 'linguine', 'fettuccine', 'cannelloni', 'schupfnudel'],
    start: [],
  },
  reis: { any: ['risotto', 'paella', 'basmati', 'jasminreis', 'milchreis'], start: ['reis'] },
};
const MOODS = [
  { key: 'egal', label: '🎲 Egal', test: () => true },
  { key: 'fleisch', label: '🥩 Fleisch', test: r => moodHit(r, 'fleisch') },
  { key: 'fisch', label: '🐟 Fisch', test: r => moodHit(r, 'fisch') },
  { key: 'kartoffel', label: '🥔 Kartoffel', test: r => moodHit(r, 'kartoffel') },
  { key: 'nudeln', label: '🍝 Nudeln', test: r => moodHit(r, 'nudeln') },
  { key: 'reis', label: '🍚 Reis', test: r => moodHit(r, 'reis') },
  { key: 'vegetarisch', label: '🥦 Vegetarisch', test: r => !isSweet(r) && !moodHit(r, 'fleisch') && !moodHit(r, 'fisch') },
  { key: 'suppe', label: '🍲 Suppe & Eintopf', test: r => r.category === 'Suppe' || /suppe|eintopf/.test(r.title.toLowerCase()) },
  { key: 'suess', label: '🍰 Süßes', test: isSweet },
];
const moodCache = new WeakMap();
function moodText(r) {
  if (!moodCache.has(r)) moodCache.set(r, ' ' + [r.title, ...r.ingredients].join(' \n ').toLowerCase());
  return moodCache.get(r);
}
function moodHit(r, key) {
  const t = moodText(r), w = MOOD_WORDS[key];
  return w.any.some(k => t.includes(k)) || w.start.some(k => new RegExp('[^a-zäöüß]' + k).test(t));
}
function isSweet(r) { return r.category === 'Dessert' || r.category === 'Kuchen & Gebäck'; }

let lastRandomId = null;
let randomMood = 'egal';
function showRandom(all) {
  const box = document.getElementById('randomPick');
  const cookable = all.filter(r => r.category !== 'Getränk');
  const counts = Object.fromEntries(MOODS.map(m => [m.key, cookable.filter(m.test).length]));
  if (!counts[randomMood]) randomMood = 'egal';
  const mood = MOODS.find(m => m.key === randomMood);
  const pool = cookable.filter(mood.test);

  let result;
  if (!pool.length) {
    result = '<p class="meta" style="margin:10px 0 0">Noch keine passenden Rezepte.</p>';
  } else {
    const choices = pool.length > 1 ? pool.filter(r => r.id !== lastRandomId) : pool;
    const r = choices[Math.floor(Math.random() * choices.length)];
    lastRandomId = r.id;
    result = `<p class="random-label">Heute gibt's …</p>
      <ul class="cards" style="margin:0">${card(r)}</ul>
      ${pool.length > 1 ? '<button class="btn secondary block" id="randomAgain" style="margin-top:10px">🎲 Nochmal würfeln</button>' : ''}`;
  }

  box.innerHTML = `<div class="panel random-panel">
    <div class="random-head">
      <h3>Worauf hast du Lust?</h3>
      <button class="icon-btn small" id="randomClose" aria-label="Schließen">✕</button>
    </div>
    <div class="chips mood-chips">${MOODS.map(m => `<button class="chip${m.key === randomMood ? ' active' : ''}"
      data-mood="${m.key}" ${counts[m.key] ? '' : 'disabled'}>${m.label}</button>`).join('')}</div>
    ${result}
  </div>`;
  document.getElementById('randomClose').onclick = () => { box.innerHTML = ''; };
  box.querySelectorAll('[data-mood]').forEach(b => {
    b.onclick = () => { randomMood = b.dataset.mood; showRandom(all); };
  });
  const again = document.getElementById('randomAgain');
  if (again) again.onclick = () => showRandom(all);
}

async function viewList(favOnly) {
  setTab(favOnly ? 'fav' : 'list');
  setHeader(favOnly ? 'Favoriten' : '', null,
    '<button class="icon-btn" id="addBtn" aria-label="Neues Rezept">＋</button>');
  document.getElementById('addBtn').onclick = () => { location.hash = '#/neu'; };
  if (!favOnly) document.body.classList.add('home');
  let all = await Store.all();
  if (favOnly) all = all.filter(r => r.favorite);
  all.sort((a, b) => a.title.localeCompare(b.title, 'de'));
  const hero = favOnly ? '' : homeHero(all.length > 0);

  if (!all.length) {
    if (favOnly) {
      $view.innerHTML = `<div class="empty"><div class="big">★</div>
        <p>Noch keine Favoriten.<br>Öffne ein Rezept und tippe oben auf den Stern.</p></div>`;
    } else {
      $view.innerHTML = `${hero}<div class="empty panel"><div class="big">🍲</div>
        <p>Noch keine Rezepte.</p>
        <button class="btn" id="firstBtn">Erstes Rezept anlegen</button>
        <p style="margin-top:12px"><button class="btn secondary" id="sampleBtn">Beispielrezept laden</button></p></div>`;
      document.getElementById('firstBtn').onclick = () => { location.hash = '#/neu'; };
      document.getElementById('sampleBtn').onclick = async () => {
        await Store.put(normalize(SAMPLE));
        route();
      };
    }
    return;
  }

  const used = [...new Set(all.map(r => r.category).filter(Boolean))];
  const cats = CATEGORIES.filter(c => used.includes(c)).concat(used.filter(c => !CATEGORIES.includes(c)));
  if (state.cat !== 'Alle' && !cats.includes(state.cat)) state.cat = 'Alle';

  $view.innerHTML = `${hero}
    <div class="search"><input id="q" type="search" placeholder="Rezept oder Zutat suchen …"
      value="${esc(state.q)}" autocomplete="off" enterkeyhint="search"></div>
    ${cats.length > 1 ? `<div class="chips">${['Alle', ...cats].map(c =>
      `<button class="chip${c === state.cat ? ' active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>` : ''}
    <ul class="cards" id="cards"></ul>`;

  const draw = () => {
    const q = state.q.trim().toLowerCase();
    const list = all.filter(r =>
      (state.cat === 'Alle' || r.category === state.cat) &&
      (!q || [r.title, r.category, allIngs(r).join(' '), r.notes].join(' ').toLowerCase().includes(q)));
    document.getElementById('cards').innerHTML = list.length
      ? list.map(r => card(r)).join('')
      : '<li class="empty panel">Nichts gefunden.</li>';
  };
  const randomBtn = document.getElementById('randomBtn');
  if (randomBtn) randomBtn.onclick = () => showRandom(all);
  document.getElementById('q').addEventListener('input', e => { state.q = e.target.value; draw(); });
  $view.querySelectorAll('.chip').forEach(b => {
    b.onclick = () => {
      state.cat = b.dataset.cat;
      $view.querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === b));
      draw();
    };
  });
  draw();
}

/* =========================================================
   Ansicht: Rezept
   ========================================================= */
async function viewDetail(id) {
  setTab('list');
  const r = await Store.get(id);
  if (!r) { location.hash = '#/'; return; }

  setHeader(r.title, '#/',
    `<button class="icon-btn" id="favBtn" aria-label="Favorit">${r.favorite ? '★' : '☆'}</button>
     <button class="icon-btn" id="editBtn" aria-label="Bearbeiten">✎</button>`);

  const base = r.servings || 0;
  let servings = base;
  const checked = state.checked[id] || (state.checked[id] = new Set());
  const img = safeImg(r.photo);
  const src = safeUrl(r.source);
  const meta = [r.category, r.time].filter(Boolean).join(' · ');

  $view.innerHTML = `
    ${img ? `<img class="hero" src="${esc(img)}" alt="">` : ''}
    <div class="detail">
      <h2>${esc(r.title)}</h2>
      ${meta ? `<div class="meta">${esc(meta)}</div>` : ''}
      ${base ? `<div class="stepper">
          <button id="minus" aria-label="Weniger Portionen">−</button>
          <span id="srv"></span>
          <button id="plus" aria-label="Mehr Portionen">+</button>
        </div>` : ''}
      ${allIngs(r).length ? `
        <h3 class="section-title">Zutaten</h3>
        <p class="meta" style="margin:-4px 0 4px">Tippe an, was du schon zuhause hast – das kommt nicht auf die Einkaufsliste.</p>
        <ul class="ings" id="ings"></ul>
        <button class="btn block" id="toShop" style="margin-top:12px"></button>` : ''}
      ${r.steps.length ? `
        <h3 class="section-title">Zubereitung</h3>
        <ol class="steps">${r.steps.map(s => `<li><span>${esc(s)}</span></li>`).join('')}</ol>` : ''}
      ${r.notes ? `<h3 class="section-title">Notizen</h3><div class="notes">${esc(r.notes)}</div>` : ''}
      ${r.source ? `<h3 class="section-title">Quelle</h3>
        <div>${src ? `<a href="${esc(src)}" target="_blank" rel="noopener">${esc(src)}</a>` : esc(r.source)}</div>` : ''}
      <div class="actions">
        <button class="btn secondary" id="shareBtn">Als Text teilen</button>
        <button class="btn secondary" id="shareFileBtn">Als Datei teilen</button>
      </div>
      <p class="meta share-hint">„Als Datei teilen“ erzeugt eine Rezept-Datei. Wer die App hat, liest sie unter
        „Mehr“ → „Rezepte einlesen“ ein. Dabei wird das Rezept ergänzt, sonst wird nichts verändert.</p>
      <div class="actions">
        <button class="btn danger" id="delBtn">Rezept löschen</button>
      </div>
    </div>`;

  const factor = () => (base ? servings / base : 1);
  const drawIngs = () => {
    const ul = document.getElementById('ings');
    if (ul) {
      ul.innerHTML = ingListHtml(r, factor(), checked);
      const n = allIngs(r).length - checked.size;
      const btn = document.getElementById('toShop');
      btn.disabled = n === 0;
      btn.textContent = n ? `🛒 ${n} ${n === 1 ? 'Zutat' : 'Zutaten'} auf die Einkaufsliste` : 'Alles zuhause – nichts zu kaufen';
    }
    const srv = document.getElementById('srv');
    if (srv) srv.textContent = `${servings} ${servings === 1 ? 'Portion' : 'Portionen'}`;
  };
  drawIngs();

  const ul = document.getElementById('ings');
  if (ul) ul.onclick = e => {
    const li = e.target.closest('li[data-i]');
    if (!li) return;
    const i = Number(li.dataset.i);
    checked.has(i) ? checked.delete(i) : checked.add(i);
    drawIngs();
  };
  if (base) {
    document.getElementById('minus').onclick = () => { if (servings > 1) { servings--; drawIngs(); } };
    document.getElementById('plus').onclick = () => { if (servings < 100) { servings++; drawIngs(); } };
  }

  const favBtn = document.getElementById('favBtn');
  favBtn.onclick = async () => {
    r.favorite = !r.favorite;
    r.updatedAt = Date.now();
    await Store.put(r);
    favBtn.textContent = r.favorite ? '★' : '☆';
    toast(r.favorite ? 'Zu den Favoriten hinzugefügt' : 'Aus den Favoriten entfernt');
  };
  document.getElementById('editBtn').onclick = () => { location.hash = '#/bearbeiten/' + encodeURIComponent(id); };

  const toShop = document.getElementById('toShop');
  // Nur die NICHT abgehakten Zutaten kommen auf die Liste
  if (toShop) toShop.onclick = async () => {
    toShop.disabled = true;
    await addToShopping(r, factor(), checked);
    checked.clear();
    location.hash = '#/einkauf';
  };

  document.getElementById('shareBtn').onclick = () => {
    const parts = [r.title];
    if (base) parts.push(`Für ${servings} ${servings === 1 ? 'Portion' : 'Portionen'}`);
    if (r.ingredients.length) parts.push('Zutaten:\n' + r.ingredients.map(l => '• ' + scaleLine(l, factor())).join('\n'));
    if ((r.spices || []).length) parts.push('Gewürze:\n' + r.spices.map(l => '• ' + scaleLine(l, factor())).join('\n'));
    if (r.steps.length) parts.push('Zubereitung:\n' + r.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'));
    if (r.notes) parts.push(r.notes);
    shareText(r.title, parts.join('\n\n'));
  };
  document.getElementById('shareFileBtn').onclick = () => shareRecipeFile(r);

  document.getElementById('delBtn').onclick = async () => {
    if (!confirm(`„${r.title}“ wirklich löschen?`)) return;
    await Store.del(id);
    toast('Rezept gelöscht');
    location.hash = '#/';
  };
}

/* Einzelnes Rezept als Import-Datei (gleiches Format wie der Gesamt-Export, nur ohne Listen) */
function recipeFile(r) {
  const slug = r.title.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'rezept';
  // Favorit ist persönlich – nicht mitgeben
  const data = { app: 'horstl-powers-rezeptbuch', format: 1, shared: true, exportedAt: new Date().toISOString(),
    recipes: [{ ...r, favorite: false }] };
  return new File([JSON.stringify(data)], `rezept-${slug}.json`, { type: 'application/json' });
}
async function shareRecipeFile(r) {
  const file = recipeFile(r);
  if (canShareFiles()) {
    try { await navigator.share({ files: [file], title: r.title }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  // Fallback (z. B. PC): Datei herunterladen
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('Datei „' + file.name + '“ gespeichert');
}

async function shareText(title, text) {
  if (navigator.share) {
    try { await navigator.share({ title, text }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('In die Zwischenablage kopiert');
  } catch {
    toast('Teilen wird auf diesem Gerät nicht unterstützt');
  }
}

/* =========================================================
   Ansicht: Rezept anlegen / bearbeiten
   ========================================================= */
async function compressImage(file, max = 1200, quality = 0.8) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Das Bild konnte nicht gelesen werden.'));
      i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* =========================================================
   Rezepttext zerlegen (z. B. per Live Text vom Foto kopiert)
   → { title, servings, time, ingredients, spices, steps, notes }
   Reine Heuristik, läuft komplett auf dem Gerät.
   ========================================================= */
const KNOWN_SPICES = ['Salz', 'Pfeffer', 'Muskat', 'Muskatnuss', 'Zimt', 'Paprikapulver', 'Curry', 'Currypulver',
  'Chili', 'Chilipulver', 'Chiliflocken', 'Cayennepfeffer', 'Kümmel', 'Kreuzkümmel', 'Majoran', 'Thymian',
  'Rosmarin', 'Oregano', 'Basilikum', 'Lorbeerblatt', 'Lorbeerblätter', 'Nelken', 'Gewürznelken', 'Piment',
  'Koriander', 'Kurkuma', 'Ingwerpulver', 'Knoblauchpulver', 'Zwiebelpulver', 'Kräuter der Provence',
  'Italienische Kräuter', 'Pfefferkörner', 'Wacholderbeeren', 'Senfkörner', 'Fenchelsamen', 'Anis', 'Sternanis',
  'Kardamom', 'Bohnenkraut', 'Estragon', 'Salbei', 'Liebstöckel', 'Dill'];
const PT_ING_H = /^(zutaten|du brauchst|man braucht|das brauchst du|einkaufsliste)\b/i;
const PT_STEP_H = /^(zubereitung|anleitung|so geht'?s|und so geht'?s|so wird'?s gemacht|arbeitsschritte|schritte|methode|zubereiten)\b/i;
const PT_NOTE_H = /^(tipps?|hinweise?|notizen?|anmerkungen?|dazu passt|varianten?)\b/i;
const PT_NUM = /^(?:schritt\s*)?(\d{1,2})\s*[.):](?!\d)\s*(\S.*)$/i;
const PT_UNIT = /^(?:g|gr\.?|kg|mg|ml|cl|dl|l|liter|gramm|el|tl|prisen?|msp\.?|messerspitzen?|pck\.?|päckchen|packung|bund|stk\.?|stück|dosen?|becher|tassen?|gläser|glas|zehen?|scheiben?|würfel|handvoll|zweige?|blatt|blätter|etwas|wenig|n\.\s?b\.?|nach belieben|nach geschmack)(?=\s|$|\.)\.?\s*/i;
const PT_QTY_ONLY = /^(?:\d+(?:[.,]\d+)?|\d+\/\d+|[½¼¾⅓⅔⅛]|\d+\s*[½¼¾])\s*(?:g|kg|ml|l|el|tl|prisen?|msp\.?|pck\.?|stk\.?|stück|bund|dosen?|becher|tassen?|zehen?|scheiben?)?\.?$/i;
const PT_DESCR = /(frisch gemahlen(er)?|frisch gerieben(e|er)?|gerieben(e|er)?|frisch|gemahlen(er)?|aus der mühle|getrocknet(e|er)?|gerebelt(er)?|edelsüß|rosenscharf|geräuchert(es)?|schwarz(er)?|weiß(er)?|grob(es)?|fein(es)?|zum abschmecken|zum würzen|nach geschmack|nach belieben|n\.\s?b\.?)(?=\s|$|[,.])/gi;

/* force: 'ing' = Text kommt aus dem Zutatenfeld, 'step' = aus dem Zubereitungsfeld,
   leer = ganzes Rezept (Titel wird gesucht). */
function parseRecipeText(text, spiceList = [], force = '') {
  const res = { title: '', servings: 0, time: '', ingredients: [], spices: [], steps: [], notes: [] };
  const rows = String(text || '').replace(/\r/g, '').split('\n')
    .map(l => l.replace(/^[\s•·▪●◦○■□☐✓✔*\-–—]+/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const spiceOf = s => {
    const k = s.trim().toLowerCase();
    return spiceList.find(x => x.toLowerCase() === k) || KNOWN_SPICES.find(x => x.toLowerCase() === k) || null;
  };
  const startsQty = l => /^(\d|[½¼¾⅓⅔⅛])/.test(l) && !PT_NUM.test(l);
  const core = l => {
    let s = l.replace(/^(?:\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?\s*[½¼¾⅓⅔⅛]?|[½¼¾⅓⅔⅛])(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?\s*/, '');
    s = s.replace(/^(eine?n?|einige|ein paar)\s+/i, '');
    for (let i = 0; i < 3; i++) s = s.replace(PT_UNIT, '');
    return s.replace(/[,;.]+$/, '').trim();
  };
  // Gewürz-Zeile? → ohne Menge die reinen Namen („Salz und Pfeffer“), sonst die ganze Zeile („1 Prise Salz“)
  const spicesIn = l => {
    const c = core(l);
    if (!c) return null;
    const parts = c.split(/\s*(?:,|\bund\b|&|\/)\s*/i)
      .map(p => p.replace(PT_DESCR, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (!parts.length || !parts.every(spiceOf)) return null;
    if (startsQty(l)) return [l];
    if (parts.length === 1 && c.toLowerCase() !== parts[0].toLowerCase()) return [l];
    return parts.map(spiceOf);
  };
  const looksSentence = l => /[.!]$/.test(l) && l.split(' ').length >= 4 && !/n\.\s?b\.$/i.test(l);
  const isIng = l => {
    if (l.length > 70 || looksSentence(l)) return false;
    if (startsQty(l)) return true;
    if (/^(etwas|einige|ein paar|eine?n?\s|prisen?\b|msp\b|n\.\s?b\.)/i.test(l) && l.length <= 50) return true;
    return !!spicesIn(l);
  };

  let mode = force || null, numbered = false, pendingQty = null;
  const afterColon = l => (l.includes(':') ? l.slice(l.indexOf(':') + 1).trim() : '');
  const addStep = l => {
    const m = l.match(PT_NUM);
    if (m) { numbered = true; res.steps.push(m[2]); return; }
    const last = res.steps[res.steps.length - 1];
    if (last !== undefined && (numbered || !/[.!?:)]$/.test(last))) {
      // Zeilenumbruch mitten im Satz (typisch für Fotos) → an vorherigen Schritt anhängen
      res.steps[res.steps.length - 1] = /[a-zäöüß]-$/i.test(last) && /^[a-zäöüß]/.test(l)
        ? last.slice(0, -1) + l : last + ' ' + l;
      return;
    }
    res.steps.push(l);
  };
  const addIng = l => {
    l = l.replace(/[,;]+$/, '');
    const sp = spicesIn(l);
    if (sp) res.spices.push(...sp); else res.ingredients.push(l);
  };

  for (let l of rows) {
    const short = l.length <= 50;
    // Portionen / Zeit
    const srv = l.match(/(?:für\s+)?(\d+)\s*(?:portionen|personen|pers\.|port\.)/i) || l.match(/(?:portionen|personen)\s*:?\s*(\d+)/i);
    const tm = l.match(/(?:zubereitungszeit|arbeitszeit|gesamtzeit|kochzeit|backzeit|zeit|dauer)\s*:?\s*(?:ca\.?\s*)?(\d[\d\s–-]*\s*(?:min\.?|minuten|std\.?|stunden|h)(?=\s|$|[.,]))/i)
      || (short && l.match(/^(?:ca\.?\s*)?(\d+\s*(?:[-–]\s*\d+\s*)?(?:min\.?|minuten|std\.?|stunden))\.?$/i));
    if (srv && short && !res.servings) res.servings = Number(srv[1]);
    if (tm && short && !res.time) res.time = tm[1].trim();

    // Überschriften (bei festem Feld nur überspringen)
    if (short && PT_ING_H.test(l)) { if (!force) mode = 'ing'; continue; }
    if (short && PT_STEP_H.test(l)) {
      if (!force) mode = 'step';
      const r = afterColon(l); if (r) (mode === 'step' ? addStep(r) : addIng(r));
      continue;
    }
    if (short && PT_NOTE_H.test(l)) { mode = 'note'; const r = afterColon(l); if (r) res.notes.push(r); continue; }
    if (short && (srv || tm) && !(force === 'ing' && startsQty(l) && !srv)) continue; // reine Info-Zeile

    // Titel: erste „normale“ Zeile vor allem anderen
    if (!force && !res.title && mode === null && !isIng(l) && !PT_NUM.test(l) && l.length <= 80) {
      res.title = l.replace(/[:.]+$/, '');
      continue;
    }

    if (mode === 'note') { res.notes.push(l); continue; }
    if (mode === 'step') { addStep(l); continue; }

    // Menge und Zutat auf zwei Zeilen („200 g“ / „Mehl“)
    if (pendingQty) { l = pendingQty + ' ' + l; pendingQty = null; }
    else if (PT_QTY_ONLY.test(l)) { pendingQty = l; continue; }

    if (mode === 'ing') {
      if (force === 'ing') addIng(l.replace(PT_NUM, '$2'));
      else if (PT_NUM.test(l) || looksSentence(l) || l.length > 70) { mode = 'step'; addStep(l); }
      else addIng(l);
      continue;
    }
    // noch keine Überschrift gesehen: selbst entscheiden
    if (isIng(l)) { mode = 'ing'; addIng(l); }
    else if (PT_NUM.test(l) || l.length > 50 || looksSentence(l)) { mode = 'step'; addStep(l); }
    else res.notes.push(l);
  }
  if (pendingQty) res.ingredients.push(pendingQty);
  res.spices = cleanList(res.spices);
  return res;
}

async function viewEdit(id) {
  setTab('list');
  const r = id ? await Store.get(id) : null;
  if (id && !r) { location.hash = '#/'; return; }
  const d = r || { title: '', category: 'Hauptgericht', servings: 4, time: '', ingredients: [], spices: [], steps: [], notes: '', source: '', photo: '' };
  let photo = safeImg(d.photo);
  const spiceList = await getList('gewuerze');
  const opList = await getList('schritte');
  // Gewürze aufteilen: Gewürze aus der eigenen Liste werden als Knopf angehakt, alle anderen stehen im Freitextfeld
  const stdKey = s => s.trim().toLowerCase();
  const picked = new Set();
  const extraSpices = [];
  (d.spices || []).forEach(s => {
    const std = spiceList.find(x => stdKey(x) === stdKey(s));
    std ? picked.add(std) : extraSpices.push(s);
  });

  setHeader(r ? 'Rezept bearbeiten' : 'Neues Rezept', r ? '#/rezept/' + encodeURIComponent(id) : '#/');
  const used = (await Store.all()).map(x => x.category).filter(Boolean);
  const allCats = [...new Set([...CATEGORIES, ...used])];

  const canClip = !!(navigator.clipboard && navigator.clipboard.readText);
  const pasteBtn = target => canClip
    ? `<button type="button" class="paste-btn" data-paste="${target}">📋 Einfügen</button>` : '';

  $view.innerHTML = `
    <form id="f" novalidate autocomplete="off">
      <label class="photo-pick" id="pick">
        <input type="file" accept="image/*" id="file" hidden>
        <span class="big">📷</span><span>Foto hinzufügen</span>
      </label>
      <button type="button" class="link-btn" id="rmPhoto" hidden>Foto entfernen</button>

      <div class="lbl-row"><label for="r-title">Name des Rezepts</label>${pasteBtn('r-title')}</div>
      <input id="r-title" value="${esc(d.title)}" placeholder="z. B. Kaiserschmarrn" enterkeyhint="next">

      <div class="row">
        <div>
          <label for="cat">Kategorie</label>
          <input id="cat" list="catlist" value="${esc(d.category)}">
          <datalist id="catlist">${allCats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
        </div>
        <div>
          <label for="srv">Portionen</label>
          <input id="srv" type="number" inputmode="numeric" min="0" max="100" value="${d.servings || ''}">
        </div>
      </div>

      <label for="time">Zeit <span class="hint">– z. B. 45 Min.</span></label>
      <input id="time" value="${esc(d.time)}">

      <div class="lbl-row"><label for="ing">Zutaten <span class="hint">– eine pro Zeile, z. B. „200 g Mehl“</span></label>${pasteBtn('ing')}</div>
      <p class="hint paste-tip">Tipp: Vom Foto kopierte Zutaten hier einfügen – die App räumt sie auf und hakt Gewürze an.</p>
      <textarea id="ing" rows="8">${esc(d.ingredients.join('\n'))}</textarea>

      <label>Gewürze <span class="hint">– antippen, was ins Rezept soll (Liste änderbar unter „Mehr“)</span></label>
      <div class="spice-chips" id="spiceChips">${spiceList.map(s =>
        `<button type="button" class="chip${picked.has(s) ? ' active' : ''}" data-spice="${esc(s)}"
          aria-pressed="${picked.has(s)}">${picked.has(s) ? '✓ ' : ''}${esc(s)}</button>`).join('')}</div>
      <label for="spx" style="font-weight:400">Weitere Gewürze <span class="hint">– eine pro Zeile, gern mit Menge, z. B. „1 TL Majoran“</span></label>
      <textarea id="spx" rows="3">${esc(extraSpices.join('\n'))}</textarea>

      <div class="lbl-row"><label for="steps">Zubereitung <span class="hint">– ein Schritt pro Zeile</span></label>${pasteBtn('steps')}</div>
      <textarea id="steps" rows="8">${esc(d.steps.join('\n'))}</textarea>
      ${opList.length ? `<div class="hint op-hint">Antippen fügt das Wort an der Schreibstelle ein:</div>
      <div class="spice-chips" id="opChips">${opList.map(s =>
        `<button type="button" class="chip" data-op="${esc(s)}">${esc(s)}</button>`).join('')}</div>` : ''}

      <label for="notes">Notizen</label>
      <textarea id="notes" rows="3">${esc(d.notes)}</textarea>

      <label for="src">Quelle / Link</label>
      <input id="src" value="${esc(d.source)}" inputmode="url" placeholder="z. B. Omas Kochbuch oder https://…">

      <div class="actions">
        <button class="btn" type="submit" id="saveBtn">Speichern</button>
        <button class="btn secondary" type="button" id="cancel">Abbrechen</button>
      </div>
    </form>`;

  const pick = document.getElementById('pick');
  const rm = document.getElementById('rmPhoto');
  const showPhoto = () => {
    pick.querySelector('img')?.remove();
    if (photo) {
      const im = document.createElement('img');
      im.src = photo; im.alt = '';
      pick.appendChild(im);
    }
    rm.hidden = !photo;
  };
  showPhoto();

  const fileInput = document.getElementById('file');
  fileInput.onchange = async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    try { photo = await compressImage(file); showPhoto(); }
    catch (err) { showError(err.message); }
  };
  rm.onclick = () => { photo = ''; showPhoto(); };

  const chipsEl = document.getElementById('spiceChips');
  chipsEl.onclick = e => {
    const b = e.target.closest('[data-spice]');
    if (!b) return;
    const s = b.dataset.spice;
    picked.has(s) ? picked.delete(s) : picked.add(s);
    const on = picked.has(s);
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on);
    b.textContent = (on ? '✓ ' : '') + s;
  };
  const syncChips = () => chipsEl.querySelectorAll('[data-spice]').forEach(b => {
    const s = b.dataset.spice, on = picked.has(s);
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on);
    b.textContent = (on ? '✓ ' : '') + s;
  });

  // Kopierten Text (z. B. vom Foto) ins jeweilige Feld einfügen und dabei aufräumen.
  // Jedes Feld weiß, was es bekommt: Titel = erste Zeile, Zutaten = Zutaten/Gewürze, Zubereitung = Schritte.
  const el = k => document.getElementById(k);
  const insertLines = (ta, lns) => {
    if (!lns.length) return;
    const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? ta.value.length;
    const before = ta.value.slice(0, s).replace(/\s+$/, ''), after = ta.value.slice(e).replace(/^\s+/, '');
    const ins = lns.join('\n');
    ta.value = [before, ins, after].filter(Boolean).join('\n');
    const caret = (before ? before.length + 1 : 0) + ins.length;
    ta.setSelectionRange(caret, caret);
  };
  const appendNotes = notes => {
    if (notes.length) el('notes').value = [el('notes').value.trim(), ...notes].filter(Boolean).join('\n');
  };
  const handlePaste = (target, text) => {
    if (!text || !text.trim()) return false;
    if (target === 'r-title') {
      const first = text.split('\n').map(s => s.trim()).find(Boolean) || '';
      el('r-title').value = first.replace(/[:.]+$/, '');
      return true;
    }
    if (target === 'ing') {
      const p = parseRecipeText(text, spiceList, 'ing');
      insertLines(el('ing'), p.ingredients);
      const extra = [];
      p.spices.forEach(s => {
        const std = spiceList.find(x => stdKey(x) === stdKey(s));
        std ? picked.add(std) : extra.push(s);
      });
      syncChips();
      if (extra.length) el('spx').value = [el('spx').value.trim(), ...extra].filter(Boolean).join('\n');
      if (p.servings && !el('srv').value) el('srv').value = p.servings;
      if (p.time && !el('time').value.trim()) el('time').value = p.time;
      appendNotes(p.notes);
      toast(`Eingefügt: ${p.ingredients.length} Zutaten` + (p.spices.length ? `, ${p.spices.length} Gewürze` : ''));
      return true;
    }
    if (target === 'steps') {
      const p = parseRecipeText(text, spiceList, 'step');
      insertLines(el('steps'), p.steps);
      if (p.time && !el('time').value.trim()) el('time').value = p.time;
      appendNotes(p.notes);
      toast(`Eingefügt: ${p.steps.length} ${p.steps.length === 1 ? 'Schritt' : 'Schritte'}`);
      return true;
    }
    return false;
  };
  ['r-title', 'ing', 'steps'].forEach(k => {
    el(k).addEventListener('paste', e => {
      const text = e.clipboardData && e.clipboardData.getData('text/plain');
      // einzeiliger Text: normal einfügen lassen (z. B. eine einzelne Zutat)
      if (!text || !text.includes('\n')) return;
      e.preventDefault();
      handlePaste(k, text);
    });
  });
  $view.querySelectorAll('[data-paste]').forEach(b => {
    b.onclick = async () => {
      const k = b.dataset.paste;
      try {
        const t = await navigator.clipboard.readText();
        if (!handlePaste(k, t)) toast('Die Zwischenablage ist leer');
      } catch {
        showError('Kein Zugriff auf die Zwischenablage. Bitte ins Feld tippen, gedrückt halten und „Einfügen“ wählen.');
      }
    };
  });

  // Arbeitsschritte einfügen: am Zeilenanfang als neuer Satz („Anbraten “),
  // mitten im Text klein angehängt („Zwiebeln anschwitzen“).
  const stepsEl = document.getElementById('steps');
  let stepsTouched = false;
  ['focus', 'click', 'keyup', 'input', 'select'].forEach(ev =>
    stepsEl.addEventListener(ev, () => { stepsTouched = true; }));
  const opChips = document.getElementById('opChips');
  if (opChips) {
    // Fokus im Textfeld lassen (Desktop), damit die Schreibstelle erhalten bleibt
    opChips.addEventListener('mousedown', e => { if (e.target.closest('[data-op]')) e.preventDefault(); });
    opChips.onclick = e => {
      const b = e.target.closest('[data-op]');
      if (!b) return;
      const word = b.dataset.op;
      const text = stepsEl.value;
      const pos = stepsTouched ? stepsEl.selectionStart : text.length;
      const before = text.slice(0, pos), after = text.slice(pos);
      const lineBefore = before.slice(before.lastIndexOf('\n') + 1);
      let ins;
      if (!lineBefore.trim()) {
        ins = word + ' ';
      } else if (!stepsTouched) {
        ins = '\n' + word + ' ';
      } else {
        ins = (/\s$/.test(lineBefore) ? '' : ' ') + word.charAt(0).toLowerCase() + word.slice(1);
        if (after && !/^[\s.,;!?]/.test(after)) ins += ' ';
      }
      stepsEl.value = before + ins + after;
      const caret = pos + ins.length;
      stepsEl.focus();
      stepsEl.setSelectionRange(caret, caret);
    };
  }
  document.getElementById('cancel').onclick = () => { location.hash = backTarget || '#/'; };

  let saving = false;
  document.getElementById('f').onsubmit = async e => {
    e.preventDefault();
    if (saving) return;
    const val = k => document.getElementById(k).value;
    if (!val('r-title').trim()) {
      showError('Bitte gib dem Rezept zuerst einen Namen.');
      document.getElementById('r-title').focus();
      return;
    }
    // Tastatur schließen, damit die Rückmeldung sichtbar ist
    if (document.activeElement) document.activeElement.blur();
    saving = true;
    const btn = document.getElementById('saveBtn');
    btn.disabled = true;
    btn.textContent = 'Speichere …';
    try {
      const rec = normalize({
      id: r ? r.id : uid(),
      title: val('r-title'),
      category: val('cat'),
      servings: val('srv'),
      time: val('time'),
      ingredients: val('ing'),
      // angehakte Gewürze (in Reihenfolge der eigenen Liste) + weitere Gewürze
      spices: [...spiceList.filter(s => picked.has(s)), ...lines(val('spx'))],
      steps: val('steps'),
      notes: val('notes'),
      source: val('src'),
      photo,
      favorite: r ? r.favorite : false,
      createdAt: r ? r.createdAt : Date.now(),
        updatedAt: Date.now(),
      });
      await Store.put(rec);
      toast('Gespeichert');
      // Adresse ersetzen und Ansicht direkt neu zeichnen – verlässt sich nicht
      // darauf, dass der Browser ein "hashchange" auslöst (Safari tut das hier nicht immer).
      history.replaceState(null, '', '#/rezept/' + encodeURIComponent(rec.id));
      await route();
    } catch (err) {
      console.error(err);
      saving = false;
      btn.disabled = false;
      btn.textContent = 'Speichern';
      showError('Speichern hat nicht geklappt: ' + (err && (err.message || err.name) || err));
    }
  };
}

/* =========================================================
   Ansicht: Einkaufsliste
   ========================================================= */
function fmtDate(ts, withTime) {
  if (!ts) return '';
  const d = new Date(ts);
  const date = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  return withTime ? date + ', ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr' : date;
}

/* Schritt 1: Rezept auswählen */
async function viewPickRecipe() {
  setTab('shop');
  setHeader('Rezept auswählen', '#/einkauf');
  const all = (await Store.all())
    .filter(r => allIngs(r).length)
    .sort((a, b) => (b.favorite - a.favorite) || a.title.localeCompare(b.title, 'de'));
  if (!all.length) {
    $view.innerHTML = `<div class="empty"><div class="big">📖</div>
      <p>Noch keine Rezepte mit Zutaten vorhanden.</p></div>`;
    return;
  }
  $view.innerHTML = `
    <p class="meta" style="margin:0 0 10px">Wähle ein Rezept. Danach hakst du ab, was du schon zuhause hast.</p>
    <div class="search"><input id="pq" type="search" placeholder="Rezept suchen …" autocomplete="off" enterkeyhint="search"></div>
    <ul class="cards" id="pcards"></ul>`;
  const pq = document.getElementById('pq');
  const draw = () => {
    const q = pq.value.trim().toLowerCase();
    const list = all.filter(r => !q || (r.title + ' ' + r.category).toLowerCase().includes(q));
    document.getElementById('pcards').innerHTML = list.length
      ? list.map(r => card(r, '#/einkauf/rezept/' + encodeURIComponent(r.id))).join('')
      : '<li class="empty">Nichts gefunden.</li>';
  };
  pq.addEventListener('input', draw);
  draw();
}

/* Schritt 2: abhaken, was zuhause ist – der Rest kommt auf die Liste */
async function viewShopCheck(id, params) {
  setTab('shop');
  const r = await Store.get(id);
  if (!r || !allIngs(r).length) { location.hash = '#/einkauf'; return; }
  const fromRecipe = params.get('von') === 'rezept';
  setHeader('Was ist zuhause?', fromRecipe ? '#/rezept/' + encodeURIComponent(id) : '#/einkauf/auswahl');

  const base = r.servings || 0;
  let servings = Math.max(1, Math.min(100, parseInt(params.get('p'), 10) || base || 1));
  const factor = () => (base ? servings / base : 1);
  const have = new Set();

  $view.innerHTML = `
    <div class="detail">
      <h2>${esc(r.title)}</h2>
      <p class="meta" style="margin:4px 0 0">Tippe an, was du <b>schon zuhause</b> hast.
        Alles andere kommt auf die Einkaufsliste.</p>
      ${base ? `<div class="stepper">
          <button id="minus" aria-label="Weniger Portionen">−</button>
          <span id="srv"></span>
          <button id="plus" aria-label="Mehr Portionen">+</button>
        </div>` : ''}
      <div class="list-tools">
        <button class="text-btn" id="allHave">Alles zuhause</button>
        <button class="text-btn" id="noneHave">Nichts zuhause</button>
      </div>
      <ul class="ings check" id="ings"></ul>
    </div>
    <div class="sticky-bar"><button class="btn block" id="addMissing"></button></div>`;

  const ul = document.getElementById('ings');
  const btn = document.getElementById('addMissing');
  const draw = () => {
    ul.innerHTML = ingListHtml(r, factor(), have);
    const srv = document.getElementById('srv');
    if (srv) srv.textContent = `${servings} ${servings === 1 ? 'Portion' : 'Portionen'}`;
    const n = allIngs(r).length - have.size;
    btn.disabled = n === 0;
    btn.textContent = n ? `🛒 ${n} ${n === 1 ? 'Zutat' : 'Zutaten'} auf die Einkaufsliste` : 'Alles zuhause – nichts zu kaufen';
  };
  draw();

  ul.onclick = e => {
    const li = e.target.closest('li[data-i]');
    if (!li) return;
    const i = Number(li.dataset.i);
    have.has(i) ? have.delete(i) : have.add(i);
    draw();
  };
  document.getElementById('allHave').onclick = () => { allIngs(r).forEach((_, i) => have.add(i)); draw(); };
  document.getElementById('noneHave').onclick = () => { have.clear(); draw(); };
  if (base) {
    document.getElementById('minus').onclick = () => { if (servings > 1) { servings--; draw(); } };
    document.getElementById('plus').onclick = () => { if (servings < 100) { servings++; draw(); } };
  }

  btn.onclick = async () => {
    btn.disabled = true;
    await addToShopping(r, factor(), have);
    location.hash = '#/einkauf';
  };
}

/* Fehlende Zutaten eines Rezepts auf die Einkaufsliste setzen.
   `have` = Indizes der Zutaten, die schon zuhause sind (werden übersprungen). */
async function addToShopping(r, factor, have) {
  const items = (await Store.getKV('shopping')) || [];
  const now = Date.now();
  let added = 0;
  const entries = allIngs(r);
  entries.forEach((line, i) => {
    if (have.has(i)) return;
    const text = scaleLine(line, factor);
    // nicht doppelt eintragen, wenn es schon offen auf der Liste steht
    if (items.some(x => !x.done && x.text === text && x.from === r.title)) return;
    items.push({ id: uid(), text, from: r.title, done: false, addedAt: now });
    added++;
  });
  await Promise.all([Store.setKV('shopping', items), Store.setKV('shoppingChangedAt', now)]);
  const skipped = entries.length - have.size - added;
  toast(!added ? 'Steht schon alles auf der Einkaufsliste'
    : `${added} ${added === 1 ? 'Zutat' : 'Zutaten'} auf die Einkaufsliste gesetzt` +
      (skipped ? ` (${skipped} stand${skipped === 1 ? '' : 'en'} schon drauf)` : ''));
  return added;
}

/* Die Einkaufsliste selbst */
async function viewShopping() {
  setTab('shop');
  setHeader('Einkaufsliste', null, '<button class="icon-btn" id="shareShop" aria-label="Liste teilen">⇪</button>');
  let items = (await Store.getKV('shopping')) || [];
  let changedAt = (await Store.getKV('shoppingChangedAt')) || 0;
  const save = () => {
    changedAt = Date.now();
    return Promise.all([Store.setKV('shopping', items), Store.setKV('shoppingChangedAt', changedAt)]);
  };

  $view.innerHTML = `
    <form class="shop-add" id="addForm">
      <input id="newItem" placeholder="Artikel hinzufügen …" autocomplete="off" enterkeyhint="done">
      <button class="btn" type="submit" aria-label="Hinzufügen">+</button>
    </form>
    <button class="btn secondary block" id="fromRecipe" style="margin-top:10px">📖 Zutaten aus einem Rezept übernehmen</button>
    <p class="meta stamp" id="stamp"></p>
    <ul class="shop" id="shop"></ul>
    <div class="row" id="shopBtns">
      <button class="btn secondary" id="clearDone">Erledigte entfernen</button>
      <button class="btn danger" id="clearAll">Alles löschen</button>
    </div>`;

  const ul = document.getElementById('shop');
  const btns = document.getElementById('shopBtns');
  const stamp = document.getElementById('stamp');
  const draw = () => {
    btns.hidden = !items.length;
    stamp.textContent = items.length && changedAt ? 'Stand: ' + fmtDate(changedAt, true) : '';
    if (!items.length) {
      ul.innerHTML = `<li class="empty">Die Einkaufsliste ist leer.<br>
        Füge Artikel hinzu oder übernimm die Zutaten aus einem Rezept.</li>`;
      return;
    }
    const sorted = [...items.filter(i => !i.done), ...items.filter(i => i.done)];
    ul.innerHTML = sorted.map(i => {
      const sub = [i.from, fmtDate(i.addedAt)].filter(Boolean).join(' · ');
      return `
      <li class="${i.done ? 'done' : ''}" data-id="${esc(i.id)}">
        <input type="checkbox" ${i.done ? 'checked' : ''} aria-label="Erledigt">
        <span class="txt">${esc(i.text)}${sub ? `<span class="from">${esc(sub)}</span>` : ''}</span>
        <button class="del" aria-label="Entfernen">✕</button>
      </li>`;
    }).join('');
  };
  draw();
  document.getElementById('fromRecipe').onclick = () => { location.hash = '#/einkauf/auswahl'; };

  ul.onclick = async e => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    const item = items.find(i => i.id === li.dataset.id);
    if (!item) return;
    if (e.target.closest('.del')) items = items.filter(i => i !== item);
    else item.done = !item.done;
    await save();
    draw();
  };
  document.getElementById('addForm').onsubmit = async e => {
    e.preventDefault();
    const input = document.getElementById('newItem');
    const text = input.value.trim();
    if (!text) return;
    items.unshift({ id: uid(), text, from: '', done: false, addedAt: Date.now() });
    input.value = '';
    await save();
    draw();
  };
  document.getElementById('clearDone').onclick = async () => {
    items = items.filter(i => !i.done);
    await save();
    draw();
  };
  document.getElementById('clearAll').onclick = async () => {
    if (!confirm('Die ganze Einkaufsliste löschen?')) return;
    items = [];
    await save();
    draw();
  };
  document.getElementById('shareShop').onclick = () => {
    const open = items.filter(i => !i.done);
    if (!open.length) { toast('Keine offenen Artikel'); return; }
    shareText('Einkaufsliste', `Einkaufsliste vom ${fmtDate(Date.now(), true)}:\n` + open.map(i => '• ' + i.text).join('\n'));
  };
}

/* =========================================================
   Ansicht: Vorrat – was ist zuhause, was kann ich kochen?
   IndexedDB-Store `kv`, Schlüssel `pantry` = { have: [stamm], extra: [name], changedAt }
   ========================================================= */
const UNIT_RE = new RegExp('^(?:(?:g|gr|kg|mg|ml|l|cl|dl|el|tl|msp|stk|pkg|pck|liter|gramm|kilo|esslöffel|teelöffel|' +
  'prisen?|stück|dosen?|bund|becher|packung(?:en)?|päckchen|zehen?|scheiben?|tassen?|glas|gläser|handvoll|' +
  'kugeln?|blatt|blätter|zweige?|stangen?|würfel|knollen?|kopf|köpfe|spritzer|schuss|tropfen|stiele?|' +
  'etwas|ca|evtl|n\\.\\s?b|nach belieben)\\.?(?:\\s+|$))+', 'i');
const ADJ_RE = /^(?:frisch|getrocknet|gemahlen|gehackt|gerieben|weich|kalt|warm|klein|groß|mittelgroß|reif|rot|gelb|grün|schwarz|weiß)(?:e|er|es|en|em)?\s+/i;

/* Grundliste im Vorrat – steht immer drin, auch ohne Rezept (vom Nutzer vorgegeben) */
const BASE_PANTRY = ['Zwiebel', 'Knoblauch', 'Essig', 'Öl', 'Nudeln', 'Spaghetti', 'Dosentomaten', 'Kapern',
  'Karotten', 'Suppengemüse', 'Rahm', 'Eier', 'Salz', 'Pfeffer', 'Paprikapulver', 'Majoran', 'Mehl', 'Germ',
  'Paprika', 'Gurkerl', 'Mais', 'Roggenmehl', 'Dinkelmehl', 'Butter', 'Gurke', 'Zucchini', 'Faschiertes',
  'Milch', 'Sauerteig', 'Sojasoße'];

/* Gleichbedeutende Namen – erster Eintrag ist der gemeinsame Name, der Rest zählt als dasselbe */
const ING_ALIASES = [
  ['Rahm', 'Sahne', 'Schlagsahne', 'Schlagrahm', 'Schlagobers', 'Obers'],
  ['Germ', 'Hefe', 'Trockenhefe', 'Trockengerm', 'Frischhefe'],
  ['Faschiertes', 'Faschierte', 'Hackfleisch', 'Hack', 'Gehacktes', 'Rinderhackfleisch', 'Schweinehackfleisch',
    'Rinderfaschiertes', 'Gemischtes Hackfleisch', 'Gemischtes Faschiertes'],
  ['Gurkerl', 'Essiggurken', 'Essiggurkerl', 'Gewürzgurken', 'Cornichons', 'Salzgurken'],
  ['Dosentomaten', 'Tomatendosen', 'Tomatendose', 'Gehackte Tomaten', 'Geschälte Tomaten', 'Passierte Tomaten',
    'Pizzatomaten', 'Tomaten aus der Dose', 'Stückige Tomaten'],
  ['Spaghetti', 'Spagetti'],
  ['Nudeln', 'Pasta', 'Penne', 'Fusilli', 'Farfalle', 'Makkaroni', 'Maccheroni', 'Rigatoni', 'Tagliatelle',
    'Bandnudeln', 'Hörnchennudeln', 'Spiralnudeln', 'Linguine', 'Fettuccine'],
  ['Zucchini', 'Zuchini', 'Zucchino', 'Zucchinis'],
  ['Karotten', 'Karotte', 'Möhren', 'Möhre', 'Mohrrüben', 'Gelbe Rüben'],
  ['Suppengemüse', 'Suppengrün', 'Wurzelwerk', 'Wurzelgemüse'],
  ['Sojasoße', 'Sojasauce', 'Sojasosse', 'Sojasoße'],
  ['Öl', 'Olivenöl', 'Sonnenblumenöl', 'Rapsöl', 'Pflanzenöl', 'Speiseöl', 'Bratöl', 'Neutrales Öl'],
  ['Essig', 'Weißweinessig', 'Rotweinessig', 'Apfelessig', 'Balsamico', 'Balsamessig', 'Branntweinessig', 'Kräuteressig'],
  ['Mehl', 'Weizenmehl', 'Glattes Mehl', 'Griffiges Mehl', 'Universalmehl', 'Weizenmehl Type 405', 'Mehl Type 405'],
  ['Knoblauch', 'Knoblauchzehe', 'Knoblauchzehen', 'Knofel'],
  ['Zwiebel', 'Zwiebeln', 'Gemüsezwiebel', 'Speisezwiebel'],
  ['Mais', 'Maiskörner', 'Dosenmais', 'Zuckermais'],
  ['Gurke', 'Salatgurke', 'Schlangengurke'],
  ['Paprika', 'Paprikaschote', 'Paprikaschoten', 'Spitzpaprika'],
  ['Eier', 'Ei', 'Eigelb', 'Eiweiß', 'Eidotter', 'Dotter'],
  ['Milch', 'Vollmilch', 'Frischmilch'],
  ['Sauerteig', 'Sauerteigansatz', 'Anstellgut'],
  ['Pfeffer', 'Pfeffer aus der Mühle'],
  ['Paprikapulver', 'Edelsüßes Paprikapulver', 'Paprikapulver edelsüß', 'Rosenpaprika', 'Geräuchertes Paprikapulver'],
  ['Majoran', 'Getrockneter Majoran'],
];

/* Aus einer Zutatenzeile die reinen Zutatennamen holen: „2 EL Salz und Pfeffer“ → [Salz, Pfeffer] */
function ingNames(line) {
  const isCan = /\bdosen?\b/i.test(line);
  let s = String(line).replace(/\(.*?\)/g, ' ').split(/[,;]/)[0].trim();
  const m = s.match(QTY_RE);
  if (m && /^\s*[\d½¼¾⅓⅔⅛]/.test(s)) s = m[3] || '';
  s = s.replace(UNIT_RE, '').replace(ADJ_RE, '');
  s = s.split(/\s+(?:zum|zur|für|nach|à|a|je|oder)\s+|\s*\/\s*/i)[0];
  return s.split(/\s+(?:und|&)\s+/i)
    .map(x => x.replace(UNIT_RE, '').replace(ADJ_RE, '').replace(/[.:!]+$/, '').trim())
    .filter(x => x.length > 1 && !/^\d/.test(x))
    .map(x => (isCan && /^tomate/i.test(x) ? 'Dosentomaten' : x))
    .map(x => x.charAt(0).toUpperCase() + x.slice(1));
}
/* Einfacher Wortstamm, damit „Ei“/„Eier“ oder „Kartoffel“/„Kartoffeln“ zusammenpassen */
function rawStem(name) {
  const s = name.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const end of ['en', 'er', 'n', 'e', 's']) {
    if (s.endsWith(end) && s.length - end.length >= 2) return s.slice(0, -end.length);
  }
  return s;
}
const ALIAS_STEM = new Map();
ING_ALIASES.forEach(([main, ...rest]) => {
  const target = rawStem(main);
  [main, ...rest].forEach(v => ALIAS_STEM.set(rawStem(v), target));
});
/* Stamm inkl. gleichbedeutender Namen; „Rinderfaschiertes“ endet auf „faschiertes“ → zählt auch */
function ingStem(name) {
  const s = rawStem(name);
  if (ALIAS_STEM.has(s)) return ALIAS_STEM.get(s);
  for (const [v, target] of ALIAS_STEM) if (v.length >= 5 && v !== target && s.endsWith(v)) return target;
  return s;
}
/* Ist die Zutat (Stamm) durch den Vorrat abgedeckt? Gleichbedeutendes regelt `ING_ALIASES`
   (bewusst kein allgemeines „endet auf“, sonst würde „Mehl“ auch „Roggenmehl“ abdecken). */
function stemCovered(stem, haveSet) {
  return haveSet.has(stem);
}
async function loadPantry() {
  const p = (await Store.getKV('pantry')) || {};
  return {
    have: new Set(Array.isArray(p.have) ? p.have : []),
    extra: Array.isArray(p.extra) ? p.extra : [],
    removed: new Set(Array.isArray(p.removed) ? p.removed : []),   // aus der Grundliste entfernte (Stamm)
    names: p.names && typeof p.names === 'object' ? p.names : {},     // umbenannte Anzeige-Namen (Stamm → Name)
    changedAt: p.changedAt || 0,
  };
}
async function savePantry(p) {
  p.changedAt = Date.now();
  await Store.setKV('pantry', { have: [...p.have], extra: p.extra, removed: [...p.removed], names: p.names, changedAt: p.changedAt });
}
/* Alle Zutaten aus Rezepten + selbst hinzugefügte, ohne Doppelte (nach Stamm) */
function pantryItems(recipes, p) {
  const map = new Map();
  const add = (name, extra, base) => {
    const st = ingStem(name);
    if (!map.has(st)) map.set(st, { name, stem: st, extra, base: !!base, uses: 0 });
    return map.get(st);
  };
  BASE_PANTRY.forEach(n => { if (!p.removed.has(ingStem(n))) add(n, false, true); });
  p.extra.forEach(n => { add(n, true).extra = true; });
  recipes.forEach(r => r.ingredients.forEach(line => ingNames(line).forEach(n => { add(n, false).uses++; })));
  for (const it of map.values()) if (p.names[it.stem]) it.name = p.names[it.stem];
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'));
}
/* Abgleich: für jedes Rezept die fehlenden Zutatenzeilen */
function pantryMatches(recipes, haveSet) {
  return recipes
    .filter(r => r.category !== 'Getränk' && r.ingredients.length)
    .map(r => {
      const missing = [], haveIdx = new Set();
      let counted = 0;
      r.ingredients.forEach((line, i) => {
        const names = ingNames(line);
        if (!names.length) return;
        counted++;
        if (names.every(n => stemCovered(ingStem(n), haveSet))) haveIdx.add(i);
        else missing.push(line);
      });
      return { r, missing, haveIdx, counted };
    })
    .filter(x => x.counted)
    .sort((a, b) => a.missing.length - b.missing.length || a.r.title.localeCompare(b.r.title, 'de'));
}

async function viewPantry() {
  setTab('pantry');
  setHeader('Vorrat', null);
  const recipes = await Store.all();
  const p = await loadPantry();
  const frozen = await freezerStems();
  let items = pantryItems(recipes, p);
  let filter = '';

  $view.innerHTML = `
    ${await pantrySeg('vorrat')}
    <p class="meta" style="margin:0 0 10px">Hake an, was du <b>zuhause</b> hast. Die Liste bleibt gespeichert –
      unten siehst du, was du damit kochen kannst${frozen.size ? ' (Tiefkühl-Produkte zählen automatisch mit)' : ''}.</p>
    <form class="shop-add" id="pAddForm">
      <input id="pInput" type="search" placeholder="Zutat suchen oder hinzufügen …" autocomplete="off" enterkeyhint="done">
      <button class="btn" type="submit" aria-label="Hinzufügen">+</button>
    </form>
    <div class="list-tools">
      <span class="meta" id="pCount" style="margin-right:auto;align-self:center"></span>
      <button class="text-btn" id="pNone">Alle Hakerl entfernen</button>
      <button class="text-btn" id="pEdit">✏️ Bearbeiten</button>
    </div>
    <div class="panel edit-note" id="pEditNote" hidden>
      <p>Namen antippen und ändern · 🗑 entfernt eine Zutat.
        Zutaten aus Rezepten kannst du umbenennen, aber nicht entfernen – sie kommen aus dem Rezept.</p>
      <button class="text-btn" id="pRestore" hidden>Gelöschte Grundliste-Zutaten zurückholen</button>
    </div>
    <ul class="shop" id="pList"></ul>
    <div class="sticky-bar"><button class="btn block" id="pMatch"></button></div>`;

  const ul = document.getElementById('pList');
  const input = document.getElementById('pInput');
  const btn = document.getElementById('pMatch');
  let editing = false;
  const fromText = i => i.uses ? `in ${i.uses} ${i.uses === 1 ? 'Rezept' : 'Rezepten'}` : (i.base ? 'Grundliste' : 'selbst hinzugefügt');
  const draw = () => {
    const q = filter.trim().toLowerCase();
    const list = items.filter(i => !q || i.name.toLowerCase().includes(q));
    document.getElementById('pEdit').textContent = editing ? '✓ Fertig' : '✏️ Bearbeiten';
    document.getElementById('pNone').hidden = editing;
    document.getElementById('pEditNote').hidden = !editing;
    document.getElementById('pRestore').hidden = !p.removed.size;
    if (editing) {
      ul.innerHTML = list.length ? list.map(i => `<li class="edit-row" data-stem="${esc(i.stem)}">
        <span class="txt"><input class="ren" value="${esc(i.name)}" aria-label="Name ändern" autocomplete="off" enterkeyhint="done">
          <span class="from">${fromText(i)}</span></span>
        ${i.uses ? '<span class="lock" title="kommt aus einem Rezept">📖</span>' : '<button class="del" aria-label="Entfernen">🗑</button>'}
      </li>`).join('') : '<li class="empty">Nichts gefunden.</li>';
    } else ul.innerHTML = list.length ? list.map(i => {
      const on = p.have.has(i.stem);
      return `<li class="${on ? 'have-row' : ''}" data-stem="${esc(i.stem)}">
        <input type="checkbox" ${on ? 'checked' : ''} aria-label="Zuhause">
        <span class="txt">${esc(i.name)}<span class="from">${fromText(i)}</span></span>
      </li>`;
    }).join('') : `<li class="empty">${items.length ? 'Nichts gefunden – mit ＋ hinzufügen.' : 'Noch keine Zutaten.<br>Lege Rezepte an oder füge Zutaten mit ＋ hinzu.'}</li>`;
    const haveCount = items.filter(i => p.have.has(i.stem)).length;
    document.getElementById('pCount').textContent = `${haveCount} von ${items.length} zuhause`;
    const m = pantryMatches(recipes, new Set([...p.have, ...frozen]));
    const ok = m.filter(x => !x.missing.length).length;
    const near = m.filter(x => x.missing.length && x.missing.length <= 2).length;
    btn.textContent = ok ? `🍳 ${ok} ${ok === 1 ? 'Rezept' : 'Rezepte'} möglich${near ? ` · ${near} fast` : ''}`
      : near ? `🍳 ${near} ${near === 1 ? 'Rezept' : 'Rezepte'} fast möglich` : '🍳 Was kann ich kochen?';
  };
  draw();

  /* Eigene Zutat (Grundliste/selbst hinzugefügt) aus der Liste nehmen */
  const dropOwn = it => {
    if (it.base) p.removed.add(it.stem);
    p.extra = p.extra.filter(n => ingStem(n) !== it.stem);
    delete p.names[it.stem];
  };
  /* Eigene Zutat neu aufnehmen (holt Grundliste-Einträge zurück statt doppelt anzulegen) */
  const addOwn = name => {
    const st = ingStem(name);
    if (p.removed.has(st)) {
      p.removed.delete(st);
      const def = BASE_PANTRY.find(n => ingStem(n) === st);
      if (def && def !== name) p.names[st] = name;
    } else p.extra.push(name);
  };

  ul.onclick = async e => {
    const li = e.target.closest('li[data-stem]');
    if (!li) return;
    const stem = li.dataset.stem;
    const it = items.find(i => i.stem === stem);
    if (editing) {
      if (!e.target.closest('.del') || !it || it.uses) return;
      dropOwn(it);
      p.have.delete(stem);
      items = pantryItems(recipes, p);
      await savePantry(p);
      draw();
      toast(`„${it.name}“ entfernt`);
      return;
    }
    p.have.has(stem) ? p.have.delete(stem) : p.have.add(stem);
    await savePantry(p);
    draw();
  };
  /* Umbenennen: gleiche Zutat (oder aus Rezept) → nur der Anzeige-Name ändert sich,
     sonst wird die eigene Zutat durch die neue ersetzt (Hakerl wandert mit) */
  ul.addEventListener('change', async e => {
    const inp = e.target.closest('.ren');
    if (!inp) return;
    const it = items.find(i => i.stem === inp.closest('li').dataset.stem);
    const raw = inp.value.trim();
    if (!it || !raw) { if (it) inp.value = it.name; return; }
    const name = raw.charAt(0).toUpperCase() + raw.slice(1);
    if (name === it.name) return;
    const st = ingStem(name);
    if (st === it.stem || it.uses) {
      p.names[it.stem] = name;
    } else {
      if (items.some(i => i.stem === st)) { toast(`„${name}“ steht schon in der Liste`); inp.value = it.name; return; }
      const had = p.have.has(it.stem);
      dropOwn(it);
      p.have.delete(it.stem);
      addOwn(name);
      if (had) p.have.add(st);
    }
    items = pantryItems(recipes, p);
    await savePantry(p);
    draw();
    toast('Gespeichert');
  });
  ul.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.closest('.ren')) e.target.blur(); });
  document.getElementById('pEdit').onclick = () => { editing = !editing; draw(); };
  document.getElementById('pRestore').onclick = async () => {
    p.removed.clear();
    items = pantryItems(recipes, p);
    await savePantry(p);
    draw();
    toast('Grundliste wiederhergestellt');
  };
  input.addEventListener('input', () => { filter = input.value; draw(); });
  document.getElementById('pAddForm').onsubmit = async e => {
    e.preventDefault();
    const raw = input.value.trim();
    if (!raw) return;
    const name = raw.charAt(0).toUpperCase() + raw.slice(1);
    const stem = ingStem(name);
    if (!items.some(i => i.stem === stem)) {
      addOwn(name);
      items = pantryItems(recipes, p);
    }
    p.have.add(stem);
    await savePantry(p);
    input.value = ''; filter = '';
    draw();
    toast(`„${name}“ ist zuhause abgehakt`);
  };
  document.getElementById('pNone').onclick = async () => {
    if (!p.have.size) return;
    if (!confirm('Alle Hakerl im Vorrat entfernen?')) return;
    p.have.clear();
    await savePantry(p);
    draw();
  };
  btn.onclick = () => { location.hash = '#/vorrat/kochen'; };
}

async function viewPantryMatch() {
  setTab('pantry');
  setHeader('Was kann ich kochen?', '#/vorrat');
  const recipes = await Store.all();
  const p = await loadPantry();
  const frozen = await freezerStems();
  for (const s of frozen) p.have.add(s);
  const m = pantryMatches(recipes, p.have);
  const ok = m.filter(x => !x.missing.length);
  const near = m.filter(x => x.missing.length && x.missing.length <= 2);

  const row = (x, i) => {
    const img = safeImg(x.r.photo);
    return `<li class="match">
      <a class="card" href="#/rezept/${esc(encodeURIComponent(x.r.id))}">
        ${img ? `<img class="thumb" src="${esc(img)}" alt="" loading="lazy">` : '<div class="thumb">🍽️</div>'}
        <div class="card-body">
          <div class="card-title">${esc(x.r.title)}</div>
          <div class="meta">${x.missing.length ? 'Es fehlt: ' + esc(x.missing.map(l => ingNames(l).join(' / ')).join(', '))
            : 'Alles zuhause ✓'}</div>
        </div>
      </a>
      ${x.missing.length ? `<button class="text-btn shop-missing" data-i="${i}">🛒 Fehlendes auf die Einkaufsliste</button>` : ''}
    </li>`;
  };
  if (!p.have.size) {
    $view.innerHTML = `<div class="empty"><div class="big">🧺</div>
      <p>Im Vorrat ist noch nichts abgehakt.</p>
      <a class="btn" href="#/vorrat">Zum Vorrat</a></div>`;
    return;
  }
  $view.innerHTML = `
    <h3 class="section-title" style="margin-top:4px">✅ Das kannst du jetzt kochen</h3>
    ${ok.length ? `<ul class="cards">${ok.map(x => row(x, m.indexOf(x))).join('')}</ul>`
      : '<p class="meta">Mit dem, was zuhause ist, geht noch kein Rezept ganz auf.</p>'}
    ${near.length ? `<h3 class="section-title">🛒 Es fehlt nur wenig</h3>
      <ul class="cards">${near.map(x => row(x, m.indexOf(x))).join('')}</ul>` : ''}
    <p class="meta" style="margin-top:20px">Grundlage: ${p.have.size} abgehakte Zutaten im Vorrat.
      Salz, Wasser &amp; Co. zählen nur, wenn sie abgehakt sind.</p>`;
  $view.querySelectorAll('.shop-missing').forEach(b => {
    b.onclick = async () => {
      const x = m[Number(b.dataset.i)];
      b.disabled = true;
      await addToShopping(x.r, 1, x.haveIdx);
      b.textContent = '✓ Auf der Einkaufsliste';
    };
  });
}

/* =========================================================
   Ansicht: Tiefkühl – was liegt im Gefrierschrank, seit wann, was mache ich daraus?
   IndexedDB-Store `kv`, Schlüssel `freezer` = Liste von
   { id, name, amount, cat, date: 'JJJJ-MM-TT', plan: { kind: 'recipe'|'idea', id?, text } | null, addedAt }
   ========================================================= */
const FREEZER_CATS = [
  { key: 'fleisch', label: '🥩 Fleisch', months: 6 },
  { key: 'gefluegel', label: '🍗 Geflügel', months: 6 },
  { key: 'faschiertes', label: '🍔 Faschiertes', months: 3 },
  { key: 'fisch', label: '🐟 Fisch', months: 4 },
  { key: 'gemuese', label: '🥦 Gemüse', months: 12 },
  { key: 'obst', label: '🍓 Obst', months: 12 },
  { key: 'brot', label: '🍞 Brot & Gebäck', months: 3 },
  { key: 'fertig', label: '🍲 Vorgekocht & Fertiges', months: 3 },
  { key: 'sonst', label: '❄️ Sonstiges', months: 6 },
];
const FREEZER_GUESS = [
  ['faschiertes', /faschiert|hack/],
  ['gefluegel', /hendl|huhn|hühn|hähnchen|geflügel|pute|truthahn|ente|gans|chicken/],
  ['fisch', /fisch|lachs|forelle|zander|kabeljau|dorsch|garnele|shrimp|scampi|calamar|tintenfisch|muschel|saibling|karpfen/],
  ['fleisch', /fleisch|rind|schwein|kalb|lamm|wild|reh|hirsch|schnitzel|gulasch|kotelett|schopf|steak|braten|speck|wurst|würstel|leber|beuschel/],
  ['obst', /beere|erdbeer|himbeer|heidelbeer|kirsch|marille|zwetsch|pflaume|apfel|birne|mango|obst|rhabarber/],
  ['gemuese', /erbse|bohne|spinat|brokkoli|karfiol|blumenkohl|kohl|gemüse|mais|karotte|zucchini|paprika|kräuter|petersil|schnittlauch|zwiebel|kürbis|sprossen/],
  ['brot', /brot|semmel|weckerl|gebäck|toast|baguette|croissant|kipferl|striezel|kuchen|teig/],
  ['fertig', /suppe|sauce|soße|eintopf|gulaschsuppe|fond|brühe|pizza|lasagne|knödel|strudel|laibchen|nockerl|fertig|reste|portion/],
];
/* Ideen, falls im Rezeptbuch noch nichts Passendes ist (Stichwort → Vorschläge) */
const FREEZER_IDEAS = [
  [/faschiert|hack/, ['Spaghetti Bolognese', 'Fleischlaberl', 'Lasagne', 'Chili con Carne', 'Gefüllte Paprika']],
  [/hendl|huhn|hühn|hähnchen|geflügel|pute/, ['Hühnersuppe', 'Backhendl', 'Hühnercurry mit Reis', 'Gebratene Hühnerbrust mit Gemüse']],
  [/schnitzel/, ['Wiener Schnitzel', 'Pariser Schnitzel', 'Cordon bleu', 'Schnitzel-Semmel']],
  [/rind|gulasch|tafelspitz/, ['Rindsgulasch', 'Rindsuppe', 'Tafelspitz', 'Geschmortes Rindfleisch']],
  [/schwein|kotelett|schopf|bauch/, ['Schweinsbraten', 'Kotelett mit Erdäpfeln', 'Geschnetzeltes', 'Grillteller']],
  [/speck/, ['Speckknödel', 'Carbonara', 'Kasnocken mit Speck', 'Bratkartoffeln mit Speck']],
  [/wurst|würstel|leberkäs/, ['Würstel mit Senf und Gebäck', 'Wurstsalat', 'Linseneintopf mit Würstel', 'Bauernomelett']],
  [/lachs/, ['Lachs mit Reis und Gemüse', 'Lachsnudeln mit Rahm', 'Lachs aus dem Ofen']],
  [/fisch|forelle|zander|kabeljau|dorsch|saibling|karpfen/, ['Fisch aus dem Ofen mit Erdäpfeln', 'Gebackener Fisch', 'Fischcurry']],
  [/garnele|shrimp|scampi/, ['Knoblauchgarnelen', 'Garnelenpasta', 'Gebratener Reis mit Garnelen']],
  [/spinat/, ['Cremespinat mit Spiegelei und Erdäpfeln', 'Spinatknödel', 'Spinat-Lasagne']],
  [/erbse/, ['Erbsenreis (Risi-Bisi)', 'Erbsensuppe', 'Als Beilage mit Butter']],
  [/bohne|fisole/, ['Fisolengemüse', 'Bohneneintopf', 'Fisolensalat']],
  [/brokkoli|karfiol|blumenkohl/, ['Gratiniert mit Käse', 'Cremesuppe', 'Gemüsepfanne']],
  [/kräuter|petersil|schnittlauch/, ['In Suppe oder Sauce geben', 'Kräuterbutter', 'Ins Rührei']],
  [/gemüse|mais|karotte|zucchini|paprika|kürbis/, ['Gemüsesuppe', 'Gemüsepfanne mit Reis', 'Gemüselaibchen', 'Ins Gulasch oder Chili']],
  [/beere|erdbeer|himbeer|heidelbeer|kirsch|marille|zwetsch|obst|rhabarber/, ['Kompott oder Röster', 'Topfencreme mit Früchten', 'Smoothie', 'Obstkuchen oder Crumble']],
  [/brot|semmel|weckerl|baguette|toast/, ['Aufbacken (ca. 10 Min. bei 180 °C)', 'Semmelknödel', 'Arme Ritter', 'Brotchips']],
  [/teig|blätterteig|strudel/, ['Strudel (süß oder pikant)', 'Pizza', 'Blätterteigtaschen']],
  [/suppe|sauce|soße|eintopf|fond|brühe/, ['Über Nacht im Kühlschrank auftauen und erwärmen', 'Als Basis für eine Sauce', 'Mit Einlage (Nudeln, Frittaten, Knödel)']],
  [/knödel|nockerl|laibchen/, ['Als Beilage zum Braten', 'Geröstete Knödel mit Ei', 'Mit Salat als Hauptspeise']],
  [/pizza|lasagne|fertig|reste|portion/, ['Einfach im Ofen aufwärmen', 'Mit frischem Salat servieren']],
];
const FREEZER_DEFAULT_IDEAS = ['Über Nacht im Kühlschrank auftauen und frisch verkochen', 'In einer Pfanne mit Gemüse',
  'Als Suppeneinlage', 'Mit Reis oder Nudeln als schnelles Essen'];

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function isoDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? s : todayISO(); }
function fmtISO(s) { const [y, m, d] = isoDate(s).split('-'); return `${d}.${m}.${y}`; }
function freezerCat(key) { return FREEZER_CATS.find(c => c.key === key) || FREEZER_CATS[FREEZER_CATS.length - 1]; }
function guessFreezerCat(name) {
  const t = String(name).toLowerCase();
  const hit = FREEZER_GUESS.find(([, re]) => re.test(t));
  return hit ? hit[0] : 'sonst';
}
/* Alter in Tagen + Ampel: ok / bald / alt (gemessen an der empfohlenen Lagerdauer) */
function freezerAge(item) {
  const [y, m, d] = isoDate(item.date).split('-').map(Number);
  const days = Math.max(0, Math.floor((Date.now() - new Date(y, m - 1, d).getTime()) / 86400000));
  const limit = freezerCat(item.cat).months * 30.4;
  const level = days > limit ? 'alt' : days > limit * 0.75 ? 'bald' : 'ok';
  let text;
  if (days < 1) text = 'heute';
  else if (days < 14) text = `${days} ${days === 1 ? 'Tag' : 'Tage'}`;
  else if (days < 61) text = `${Math.round(days / 7)} Wochen`;
  else text = `${Math.round(days / 30.4)} Monate`;
  return { days, level, text, limitMonths: freezerCat(item.cat).months };
}
async function loadFreezer() {
  const list = (await Store.getKV('freezer')) || [];
  return Array.isArray(list) ? list.filter(x => x && x.id && x.name) : [];
}
async function saveFreezer(list) {
  await Promise.all([Store.setKV('freezer', list), Store.setKV('freezerChangedAt', Date.now())]);
}
async function freezerStems() {
  return new Set((await loadFreezer()).map(x => ingStem(x.name)));
}
async function pantrySeg(active) {
  const n = (await loadFreezer()).length;
  return `<div class="seg">
    <a href="#/vorrat" class="${active === 'vorrat' ? 'active' : ''}">🧺 Vorrat</a>
    <a href="#/tiefkuehl" class="${active === 'tk' ? 'active' : ''}">❄️ Tiefkühl${n ? ` <span class="badge">${n}</span>` : ''}</a>
  </div>`;
}
/* Rezepte aus dem Buch, in denen das Produkt vorkommt */
function freezerRecipes(item, recipes) {
  const st = ingStem(item.name);
  return recipes.filter(r => r.ingredients.some(line => ingNames(line).some(n => {
    const s = ingStem(n);
    return s === st || (st.length >= 4 && s.includes(st)) || (s.length >= 4 && st.includes(s));
  })) || (st.length >= 4 && r.title.toLowerCase().includes(st)));
}
function freezerIdeas(item) {
  const t = item.name.toLowerCase();
  const hits = FREEZER_IDEAS.filter(([re]) => re.test(t)).flatMap(([, ideas]) => ideas);
  return [...new Set(hits.length ? hits : FREEZER_DEFAULT_IDEAS)].slice(0, 6);
}

async function viewFreezer() {
  setTab('pantry');
  setHeader('Tiefkühl', null);
  let list = await loadFreezer();
  const seg = await pantrySeg('tk');

  $view.innerHTML = `
    ${seg}
    <form id="fzAdd" class="panel fz-add">
      <label for="fzName" style="margin-top:0">Neues Produkt einlagern</label>
      <input id="fzName" placeholder="z. B. Faschiertes, Erbsen, Semmeln …" autocomplete="off" enterkeyhint="next" required>
      <div class="row" style="margin-top:8px">
        <input id="fzAmount" placeholder="Menge (z. B. 500 g)" autocomplete="off">
        <input id="fzDate" type="date" value="${todayISO()}" aria-label="Einlagerungsdatum">
      </div>
      <button class="btn block" type="submit" style="margin-top:10px">❄️ Einlagern</button>
    </form>
    <p class="meta stamp" id="fzInfo"></p>
    <ul class="fz-list" id="fzList"></ul>`;

  const ul = document.getElementById('fzList');
  const draw = () => {
    const sorted = [...list].sort((a, b) => isoDate(a.date).localeCompare(isoDate(b.date)) || a.name.localeCompare(b.name, 'de'));
    const old = sorted.filter(x => freezerAge(x).level !== 'ok').length;
    document.getElementById('fzInfo').textContent = list.length
      ? `${list.length} ${list.length === 1 ? 'Produkt' : 'Produkte'} · älteste zuerst${old ? ` · ${old} bald verbrauchen` : ''}` : '';
    ul.innerHTML = sorted.length ? sorted.map(x => {
      const a = freezerAge(x);
      const cat = freezerCat(x.cat);
      return `<li><a class="fz-item" href="#/tiefkuehl/${esc(encodeURIComponent(x.id))}">
        <span class="fz-icon">${cat.label.split(' ')[0]}</span>
        <span class="fz-body">
          <span class="fz-name">${esc(x.name)}${x.amount ? ` <span class="meta">· ${esc(x.amount)}</span>` : ''}</span>
          <span class="meta">eingelagert ${fmtISO(x.date)}</span>
          ${x.plan ? `<span class="fz-plan">📌 ${esc(x.plan.text)}</span>` : '<span class="fz-hint">💡 Verwendung auswählen</span>'}
        </span>
        <span class="age age-${a.level}">${a.text}</span>
      </a></li>`;
    }).join('') : `<li class="empty"><div class="big">❄️</div>Noch nichts eingelagert.<br>
      Trag oben ein, was in den Tiefkühler kommt.</li>`;
  };
  draw();

  document.getElementById('fzAdd').onsubmit = async e => {
    e.preventDefault();
    const nameEl = document.getElementById('fzName');
    const name = nameEl.value.trim();
    if (!name) return;
    const item = {
      id: uid(), name: name.charAt(0).toUpperCase() + name.slice(1),
      amount: document.getElementById('fzAmount').value.trim(),
      cat: guessFreezerCat(name), date: isoDate(document.getElementById('fzDate').value),
      plan: null, addedAt: Date.now(),
    };
    list.push(item);
    await saveFreezer(list);
    nameEl.value = ''; document.getElementById('fzAmount').value = '';
    document.getElementById('fzDate').value = todayISO();
    toast(`„${item.name}“ eingelagert`);
    draw();
  };
}

async function viewFreezerItem(id) {
  setTab('pantry');
  setHeader('Tiefkühl-Produkt', '#/tiefkuehl');
  let list = await loadFreezer();
  const item = list.find(x => x.id === id);
  if (!item) { location.hash = '#/tiefkuehl'; return; }
  const recipes = (await Store.all()).sort((a, b) => a.title.localeCompare(b.title, 'de'));

  const save = async () => { await saveFreezer(list); };
  const draw = () => {
    const a = freezerAge(item);
    const found = freezerRecipes(item, recipes);
    const ideas = freezerIdeas(item);
    const isPlan = (kind, key) => item.plan && item.plan.kind === kind && (kind === 'recipe' ? item.plan.id === key : item.plan.text === key);
    $view.innerHTML = `
      <div class="panel">
        <label for="eName" style="margin-top:0">Produkt</label>
        <input id="eName" value="${esc(item.name)}" autocomplete="off">
        <div class="row">
          <div><label for="eAmount">Menge</label><input id="eAmount" value="${esc(item.amount || '')}" placeholder="z. B. 500 g" autocomplete="off"></div>
          <div><label for="eDate">Eingelagert am</label><input id="eDate" type="date" value="${isoDate(item.date)}"></div>
        </div>
        <label for="eCat">Art</label>
        <select id="eCat">${FREEZER_CATS.map(c => `<option value="${c.key}" ${c.key === item.cat ? 'selected' : ''}>${c.label}</option>`).join('')}</select>
        <p class="age-line age-${a.level}">
          ${a.level === 'alt' ? '⚠️ Schon länger als empfohlen eingefroren' : a.level === 'bald' ? '⏳ Bald verbrauchen' : '✓ Gut haltbar'}
          · ${a.days < 1 ? 'heute eingefroren' : a.text + ' eingefroren'} · empfohlen bis ca. ${a.limitMonths} Monate</p>
      </div>

      <h3 class="section-title">💡 Was mache ich daraus?</h3>
      <p class="meta" style="margin:0 0 8px">Tippe auf einen Vorschlag, um ihn als Plan zu merken.</p>
      ${item.plan ? `<div class="panel fz-current">📌 Geplant: <b>${esc(item.plan.text)}</b>
        ${item.plan.kind === 'recipe' ? `<a class="text-btn" href="#/rezept/${esc(encodeURIComponent(item.plan.id))}">Rezept öffnen ›</a>` : ''}
        <button class="text-btn" id="planClear">Plan entfernen</button></div>` : ''}
      ${found.length ? `<p class="random-label">Aus deinem Rezeptbuch</p>
        <ul class="sugg">${found.map(r => `<li><button class="sugg-btn${isPlan('recipe', r.id) ? ' on' : ''}" data-recipe="${esc(r.id)}">
          📖 ${esc(r.title)}<span class="meta">${esc(r.category || '')}</span></button></li>`).join('')}</ul>` : ''}
      <p class="random-label">Ideen</p>
      <ul class="sugg">${ideas.map(t => `<li><button class="sugg-btn${isPlan('idea', t) ? ' on' : ''}" data-idea="${esc(t)}">💡 ${esc(t)}</button></li>`).join('')}</ul>
      <form class="shop-add" id="ownIdea" style="margin-top:10px">
        <input id="ownIdeaText" placeholder="Eigene Idee …" autocomplete="off" enterkeyhint="done">
        <button class="btn" type="submit" aria-label="Als Plan merken">+</button>
      </form>

      <div class="actions">
        <button class="btn" id="usedUp">✓ Aufgebraucht – aus dem Tiefkühler nehmen</button>
      </div>`;

    const field = (elId, key, fn = v => v.trim()) => {
      document.getElementById(elId).onchange = async e => {
        const v = fn(e.target.value);
        if (key === 'name' && !v) { e.target.value = item.name; return; }
        item[key] = v;
        await save();
        if (key !== 'amount') draw();
        toast('Gespeichert');
      };
    };
    field('eName', 'name', v => { v = v.trim(); return v && v.charAt(0).toUpperCase() + v.slice(1); });
    field('eAmount', 'amount');
    field('eDate', 'date', isoDate);
    field('eCat', 'cat', v => v);

    $view.querySelectorAll('[data-recipe]').forEach(b => {
      b.onclick = async () => {
        const r = recipes.find(x => x.id === b.dataset.recipe);
        item.plan = isPlan('recipe', r.id) ? null : { kind: 'recipe', id: r.id, text: r.title };
        await save(); draw();
      };
    });
    $view.querySelectorAll('[data-idea]').forEach(b => {
      b.onclick = async () => {
        const t = b.dataset.idea;
        item.plan = isPlan('idea', t) ? null : { kind: 'idea', text: t };
        await save(); draw();
      };
    });
    const clear = document.getElementById('planClear');
    if (clear) clear.onclick = async () => { item.plan = null; await save(); draw(); };
    document.getElementById('ownIdea').onsubmit = async e => {
      e.preventDefault();
      const t = document.getElementById('ownIdeaText').value.trim();
      if (!t) return;
      item.plan = { kind: 'idea', text: t };
      await save(); draw();
    };
    document.getElementById('usedUp').onclick = async () => {
      if (!confirm(`„${item.name}“ aus dem Tiefkühler nehmen?`)) return;
      list = list.filter(x => x !== item);
      await save();
      toast(`„${item.name}“ entfernt`);
      location.hash = '#/tiefkuehl';
    };
  };
  draw();
}

/* =========================================================
   Ansicht: Mehr (Export / Import / Installation)
   ========================================================= */
function exportFileName() {
  return `rezepte-${new Date().toISOString().slice(0, 10)}.json`;
}
async function buildExportFile() {
  const recipes = await Store.all();
  const lists = {};
  for (const kind of Object.keys(LISTS)) lists[kind] = await getList(kind);
  const data = { app: 'horstl-powers-rezeptbuch', format: 1, exportedAt: new Date().toISOString(), recipes, lists };
  return new File([JSON.stringify(data)], exportFileName(), { type: 'application/json' });
}
function canShareFiles() {
  try {
    return !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 't.json', { type: 'application/json' })] }));
  } catch { return false; }
}
async function importFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { toast('Diese Datei ist keine gültige Rezept-Datei.'); return; }
  const list = Array.isArray(data) ? data : data && data.recipes;
  if (!Array.isArray(list)) { toast('In dieser Datei wurden keine Rezepte gefunden.'); return; }
  let added = 0, updated = 0, same = 0;
  for (const raw of list) {
    const rec = normalize(raw);
    if (!rec) continue;
    const existing = await Store.get(rec.id);
    if (!existing) { await Store.put(rec); added++; }
    else if (rec.updatedAt > (existing.updatedAt || 0)) {
      // Bei geteilten Einzelrezepten die eigene Favoriten-Markierung behalten
      await Store.put(data.shared ? { ...rec, favorite: !!existing.favorite } : rec);
      updated++;
    }
    else same++;
  }
  // Eigene Listen zusammenführen: vorhandene bleiben, neue Einträge kommen hinten dazu
  let newEntries = 0;
  if (data && data.lists && typeof data.lists === 'object') {
    for (const kind of Object.keys(LISTS)) {
      if (!Array.isArray(data.lists[kind])) continue;
      const cur = await getList(kind);
      const merged = cleanList([...cur, ...data.lists[kind]]);
      newEntries += merged.length - cur.length;
      await setList(kind, merged);
    }
  }
  // Einzelnes Rezept: gleich anzeigen
  const one = list.length === 1 && normalize(list[0]);
  if (one && added + updated + same === 1) {
    toast(added ? `„${one.title}“ hinzugefügt` : updated ? `„${one.title}“ aktualisiert` : `„${one.title}“ ist schon aktuell`);
    location.hash = '#/rezept/' + encodeURIComponent(one.id);
    return;
  }
  toast(`Import fertig: ${added} neu, ${updated} aktualisiert, ${same} unverändert` +
    (newEntries ? ` · ${newEntries} neue Listeneinträge` : ''));
  await viewMore();
}

async function viewMore() {
  setTab('more');
  setHeader('Mehr', null);
  const count = (await Store.all()).length;
  const share = canShareFiles();
  const hasBg = !!safeImg(await Store.getKV('bgPhoto'));
  const nSp = (await getList('gewuerze')).length;
  const nOp = (await getList('schritte')).length;

  $view.innerHTML = `
    <div class="panel">
      <h3>Meine Listen fürs Rezept-Anlegen</h3>
      <p>Gewürze und Arbeitsschritte, die du beim Anlegen eines Rezepts nur noch antippen musst.
        Du kannst sie ergänzen, umbenennen, sortieren und löschen.</p>
      <div class="row">
        <button class="btn secondary" data-go="#/mehr/liste/gewuerze">🌿 Gewürze (${nSp})</button>
        <button class="btn secondary" data-go="#/mehr/liste/schritte">🍳 Schritte (${nOp})</button>
      </div>
    </div>
    <div class="panel">
      <h3>Hintergrundfoto der Startseite</h3>
      <p>Wähle ein Foto aus deiner Mediathek. Es bleibt nur auf diesem Gerät gespeichert.</p>
      <div class="row">
        <label class="btn" style="margin:0">${hasBg ? 'Foto ändern …' : 'Foto auswählen …'}
          <input type="file" accept="image/*" class="bgFile" hidden></label>
        ${hasBg ? '<button class="btn secondary" id="bgRemove">Entfernen</button>' : ''}
      </div>
    </div>
    <div class="panel">
      <h3>Rezepte sichern &amp; übertragen</h3>
      <p>Speichert ${count === 1 ? 'dein Rezept' : `alle ${count} Rezepte`} samt Fotos in eine Datei.
        Die Datei kannst du auf einem anderen Gerät einlesen – und sie ist gleichzeitig deine Sicherung.</p>
      <div class="row">
        <button class="btn" id="exp" ${count ? '' : 'disabled'}>Als Datei speichern</button>
        ${share ? `<button class="btn secondary" id="expShare" ${count ? '' : 'disabled'}>Teilen …</button>` : ''}
      </div>
    </div>
    <div class="panel">
      <h3>Rezepte einlesen</h3>
      <p>Liest eine Export-Datei oder ein geteiltes Einzelrezept ein. Neue Rezepte kommen dazu.
        Vorhandene werden nur ersetzt, wenn die Datei eine neuere Version desselben Rezepts enthält.
        Es wird nie etwas gelöscht.</p>
      <label class="btn secondary block" style="margin:0">Datei auswählen …
        <input type="file" id="imp" hidden>
      </label>
    </div>
    <div class="panel">
      <h3>Als App installieren</h3>
      <p><b>iPhone:</b> In Safari unten auf „Teilen“ tippen und „Zum Home-Bildschirm“ wählen.<br>
        <b>Android:</b> In Chrome auf ⋮ tippen und „App installieren“ bzw. „Zum Startbildschirm hinzufügen“ wählen.</p>
    </div>
    <p class="meta" style="text-align:center">${APP_NAME} · Version ${APP_VERSION}<br>
      Deine Rezepte sind nur auf diesem Gerät gespeichert.</p>`;

  $view.querySelectorAll('[data-go]').forEach(b => { b.onclick = () => { location.hash = b.dataset.go; }; });
  $view.querySelectorAll('.bgFile').forEach(input => {
    bindBgInput(input);
    const done = input.onchange;
    input.onchange = async () => { await done(); await viewMore(); };
  });
  const bgRemove = document.getElementById('bgRemove');
  if (bgRemove) bgRemove.onclick = async () => { await removeBackground(); await viewMore(); };

  document.getElementById('exp').onclick = async () => {
    const file = await buildExportFile();
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('Datei „' + file.name + '“ gespeichert');
  };
  const shareBtn = document.getElementById('expShare');
  if (shareBtn) shareBtn.onclick = async () => {
    const file = await buildExportFile();
    try { await navigator.share({ files: [file], title: 'Rezepte' }); }
    catch (e) { if (e.name !== 'AbortError') toast('Teilen hat nicht geklappt'); }
  };
  document.getElementById('imp').onchange = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await importFile(file);
  };
}

/* =========================================================
   Ansicht: eigene Liste bearbeiten (Gewürze / Arbeitsschritte)
   ========================================================= */
async function viewListEdit(kind) {
  const L = LISTS[kind];
  setTab('more');
  setHeader(L.title, '#/mehr');
  let items = await getList(kind);

  const save = async () => { await setList(kind, items); items = await getList(kind); };
  const render = () => {
    $view.innerHTML = `
      <p class="meta">${esc(L.hint)} Zum Umbenennen einfach in den Text tippen.</p>
      <form class="shop-add" id="addF" autocomplete="off">
        <input id="addIn" placeholder="${esc(L.placeholder)}" enterkeyhint="done" aria-label="Neuer Eintrag">
        <button class="btn" type="submit" aria-label="Hinzufügen">+</button>
      </form>
      <ul class="shop">${items.length ? items.map((s, i) => `
        <li class="edit-row" data-i="${i}">
          <input class="ren" value="${esc(s)}" aria-label="${esc(s)} umbenennen">
          <button type="button" class="del" data-act="up" aria-label="Nach oben" ${i ? '' : 'disabled'}>↑</button>
          <button type="button" class="del" data-act="down" aria-label="Nach unten" ${i < items.length - 1 ? '' : 'disabled'}>↓</button>
          <button type="button" class="del" data-act="del" aria-label="${esc(s)} löschen">✕</button>
        </li>`).join('') : '<li class="empty meta">Die Liste ist leer.</li>'}
      </ul>
      <div class="list-tools">
        <button type="button" class="text-btn" id="reset">Auf Standard zurücksetzen</button>
      </div>`;

    const addIn = document.getElementById('addIn');
    document.getElementById('addF').onsubmit = async e => {
      e.preventDefault();
      const v = addIn.value.trim();
      if (!v) return;
      if (items.some(x => x.toLowerCase() === v.toLowerCase())) { toast('„' + v + '“ ist schon in der Liste'); return; }
      items.push(v);
      await save();
      render();
      document.getElementById('addIn').focus();
      toast('„' + v + '“ hinzugefügt');
    };
    $view.querySelectorAll('.edit-row').forEach(li => {
      const i = Number(li.dataset.i);
      const ren = li.querySelector('.ren');
      ren.onchange = async () => {
        const v = ren.value.trim();
        if (!v) { ren.value = items[i]; return; }
        if (items.some((x, j) => j !== i && x.toLowerCase() === v.toLowerCase())) {
          toast('„' + v + '“ gibt es schon'); ren.value = items[i]; return;
        }
        items[i] = v;
        await save();
      };
      ren.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); ren.blur(); } };
      li.querySelectorAll('[data-act]').forEach(b => {
        b.onclick = async () => {
          const act = b.dataset.act;
          if (act === 'del') items.splice(i, 1);
          else {
            const j = act === 'up' ? i - 1 : i + 1;
            if (j < 0 || j >= items.length) return;
            [items[i], items[j]] = [items[j], items[i]];
          }
          await save();
          render();
        };
      });
    });
    document.getElementById('reset').onclick = async () => {
      if (!confirm('Liste auf die Standard-Einträge zurücksetzen? Eigene Einträge gehen dabei verloren.')) return;
      items = [...L.defaults];
      await save();
      render();
      toast('Liste zurückgesetzt');
    };
  };
  render();
}

/* =========================================================
   Beispielrezept
   ========================================================= */
const SAMPLE = {
  title: 'Kaiserschmarrn',
  category: 'Dessert',
  servings: 2,
  time: '25 Min.',
  ingredients: ['4 Eier', '250 ml Milch', '125 g Mehl', '1 EL Zucker', '1 Prise Salz',
    '2 EL Rosinen', '30 g Butter', 'Puderzucker zum Bestäuben'],
  steps: [
    'Eier trennen. Eigelb mit Milch, Mehl, Zucker und Salz glatt rühren.',
    'Eiweiß steif schlagen und vorsichtig unter den Teig heben.',
    'Butter in einer großen Pfanne erhitzen, Teig hineingießen und Rosinen darüberstreuen.',
    'Bei mittlerer Hitze stocken lassen, wenden und mit zwei Gabeln in Stücke reißen.',
    'Noch 2–3 Minuten fertig braten, mit Puderzucker bestäuben und heiß servieren.',
  ],
  notes: 'Dazu passt Apfelmus oder Zwetschgenröster.',
};

/* =========================================================
   Start
   ========================================================= */
// Unerwartete Fehler anzeigen statt still zu scheitern
window.addEventListener('unhandledrejection', e => {
  console.error(e.reason);
  toast('Fehler: ' + (e.reason && (e.reason.message || e.reason.name) || e.reason));
});
window.addEventListener('error', e => toast('Fehler: ' + e.message));

document.getElementById('backBtn').onclick = () => { if (backTarget) location.hash = backTarget; };
window.addEventListener('hashchange', route);
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
applyBackground().catch(() => {});
route();
