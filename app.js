'use strict';

const APP_VERSION = '1.0.0';
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
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
function tx(store, mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
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
function setHeader(title, back, actionsHtml = '') {
  document.getElementById('title').textContent = title;
  backTarget = back;
  document.getElementById('backBtn').hidden = !back;
  document.getElementById('topActions').innerHTML = actionsHtml;
}
function setTab(name) {
  document.querySelectorAll('.tabbar a').forEach(a => a.classList.toggle('active', a.dataset.tab === name));
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
  const parts = location.hash.replace(/^#/, '').split('/').filter(Boolean);
  window.scrollTo(0, 0);
  try {
    if (!parts.length) return await viewList(false);
    switch (parts[0]) {
      case 'favoriten': return await viewList(true);
      case 'rezept': return await viewDetail(decodeURIComponent(parts[1] || ''));
      case 'neu': return await viewEdit(null);
      case 'bearbeiten': return await viewEdit(decodeURIComponent(parts[1] || ''));
      case 'einkauf': return await viewShopping();
      case 'mehr': return await viewMore();
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
function card(r) {
  const img = safeImg(r.photo);
  const meta = [r.category, r.time].filter(Boolean).join(' · ');
  return `<li><a class="card" href="#/rezept/${encodeURIComponent(r.id)}">
    ${img ? `<img class="thumb" src="${esc(img)}" alt="" loading="lazy">` : '<div class="thumb">🍽️</div>'}
    <div class="card-body">
      <div class="card-title">${esc(r.title)}</div>
      <div class="meta">${esc(meta)}</div>
    </div>
    ${r.favorite ? '<span class="star" aria-label="Favorit">★</span>' : ''}
  </a></li>`;
}

async function viewList(favOnly) {
  setTab(favOnly ? 'fav' : 'list');
  setHeader(favOnly ? 'Favoriten' : 'Rezeptbuch', null,
    '<button class="icon-btn" id="addBtn" aria-label="Neues Rezept">＋</button>');
  document.getElementById('addBtn').onclick = () => { location.hash = '#/neu'; };

  let all = await Store.all();
  if (favOnly) all = all.filter(r => r.favorite);
  all.sort((a, b) => a.title.localeCompare(b.title, 'de'));

  if (!all.length) {
    if (favOnly) {
      $view.innerHTML = `<div class="empty"><div class="big">★</div>
        <p>Noch keine Favoriten.<br>Öffne ein Rezept und tippe oben auf den Stern.</p></div>`;
    } else {
      $view.innerHTML = `<div class="empty"><div class="big">🍲</div>
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

  $view.innerHTML = `
    <div class="search"><input id="q" type="search" placeholder="Rezept oder Zutat suchen …"
      value="${esc(state.q)}" autocomplete="off" enterkeyhint="search"></div>
    ${cats.length > 1 ? `<div class="chips">${['Alle', ...cats].map(c =>
      `<button class="chip${c === state.cat ? ' active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>` : ''}
    <ul class="cards" id="cards"></ul>`;

  const draw = () => {
    const q = state.q.trim().toLowerCase();
    const list = all.filter(r =>
      (state.cat === 'Alle' || r.category === state.cat) &&
      (!q || [r.title, r.category, r.ingredients.join(' '), r.notes].join(' ').toLowerCase().includes(q)));
    document.getElementById('cards').innerHTML = list.length
      ? list.map(card).join('')
      : '<li class="empty">Nichts gefunden.</li>';
  };
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
      ${r.ingredients.length ? `
        <h3 class="section-title">Zutaten</h3>
        <ul class="ings" id="ings"></ul>
        <button class="btn secondary block" id="toShop" style="margin-top:12px">🛒 Auf die Einkaufsliste</button>` : ''}
      ${r.steps.length ? `
        <h3 class="section-title">Zubereitung</h3>
        <ol class="steps">${r.steps.map(s => `<li><span>${esc(s)}</span></li>`).join('')}</ol>` : ''}
      ${r.notes ? `<h3 class="section-title">Notizen</h3><div class="notes">${esc(r.notes)}</div>` : ''}
      ${r.source ? `<h3 class="section-title">Quelle</h3>
        <div>${src ? `<a href="${esc(src)}" target="_blank" rel="noopener">${esc(src)}</a>` : esc(r.source)}</div>` : ''}
      <div class="actions">
        <button class="btn secondary" id="shareBtn">Rezept teilen</button>
        <button class="btn danger" id="delBtn">Rezept löschen</button>
      </div>
    </div>`;

  const factor = () => (base ? servings / base : 1);
  const drawIngs = () => {
    const ul = document.getElementById('ings');
    if (ul) {
      ul.innerHTML = r.ingredients.map((line, i) =>
        `<li data-i="${i}" class="${checked.has(i) ? 'done' : ''}">${esc(scaleLine(line, factor()))}</li>`).join('');
    }
    const srv = document.getElementById('srv');
    if (srv) srv.textContent = `${servings} ${servings === 1 ? 'Portion' : 'Portionen'}`;
  };
  drawIngs();

  const ul = document.getElementById('ings');
  if (ul) ul.onclick = e => {
    const li = e.target.closest('li');
    if (!li) return;
    const i = Number(li.dataset.i);
    checked.has(i) ? checked.delete(i) : checked.add(i);
    li.classList.toggle('done');
  };
  if (base) {
    document.getElementById('minus').onclick = () => { if (servings > 1) { servings--; drawIngs(); } };
    document.getElementById('plus').onclick = () => { if (servings < 100) { servings++; drawIngs(); } };
  }

  document.getElementById('favBtn').onclick = async e => {
    r.favorite = !r.favorite;
    r.updatedAt = Date.now();
    await Store.put(r);
    e.currentTarget.textContent = r.favorite ? '★' : '☆';
    toast(r.favorite ? 'Zu den Favoriten hinzugefügt' : 'Aus den Favoriten entfernt');
  };
  document.getElementById('editBtn').onclick = () => { location.hash = '#/bearbeiten/' + encodeURIComponent(id); };

  const toShop = document.getElementById('toShop');
  if (toShop) toShop.onclick = async () => {
    const items = (await Store.getKV('shopping')) || [];
    r.ingredients.forEach(line => items.push({ id: uid(), text: scaleLine(line, factor()), from: r.title, done: false }));
    await Store.setKV('shopping', items);
    toast(`${r.ingredients.length} Zutaten auf die Einkaufsliste gesetzt`);
  };

  document.getElementById('shareBtn').onclick = () => {
    const parts = [r.title];
    if (base) parts.push(`Für ${servings} ${servings === 1 ? 'Portion' : 'Portionen'}`);
    if (r.ingredients.length) parts.push('Zutaten:\n' + r.ingredients.map(l => '• ' + scaleLine(l, factor())).join('\n'));
    if (r.steps.length) parts.push('Zubereitung:\n' + r.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'));
    if (r.notes) parts.push(r.notes);
    shareText(r.title, parts.join('\n\n'));
  };

  document.getElementById('delBtn').onclick = async () => {
    if (!confirm(`„${r.title}“ wirklich löschen?`)) return;
    await Store.del(id);
    toast('Rezept gelöscht');
    location.hash = '#/';
  };
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

async function viewEdit(id) {
  setTab('list');
  const r = id ? await Store.get(id) : null;
  if (id && !r) { location.hash = '#/'; return; }
  const d = r || { title: '', category: 'Hauptgericht', servings: 4, time: '', ingredients: [], steps: [], notes: '', source: '', photo: '' };
  let photo = safeImg(d.photo);

  setHeader(r ? 'Rezept bearbeiten' : 'Neues Rezept', r ? '#/rezept/' + encodeURIComponent(id) : '#/');
  const used = (await Store.all()).map(x => x.category).filter(Boolean);
  const allCats = [...new Set([...CATEGORIES, ...used])];

  $view.innerHTML = `
    <form id="f" novalidate autocomplete="off">
      <label class="photo-pick" id="pick">
        <input type="file" accept="image/*" id="file" hidden>
        <span class="big">📷</span><span>Foto hinzufügen</span>
      </label>
      <button type="button" class="link-btn" id="rmPhoto" hidden>Foto entfernen</button>

      <label for="title">Name des Rezepts</label>
      <input id="title" value="${esc(d.title)}" placeholder="z. B. Kaiserschmarrn" enterkeyhint="next">

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

      <label for="ing">Zutaten <span class="hint">– eine pro Zeile, z. B. „200 g Mehl“</span></label>
      <textarea id="ing" rows="8">${esc(d.ingredients.join('\n'))}</textarea>

      <label for="steps">Zubereitung <span class="hint">– ein Schritt pro Zeile</span></label>
      <textarea id="steps" rows="8">${esc(d.steps.join('\n'))}</textarea>

      <label for="notes">Notizen</label>
      <textarea id="notes" rows="3">${esc(d.notes)}</textarea>

      <label for="src">Quelle / Link</label>
      <input id="src" value="${esc(d.source)}" inputmode="url" placeholder="z. B. Omas Kochbuch oder https://…">

      <div class="actions">
        <button class="btn" type="submit">Speichern</button>
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

  document.getElementById('file').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try { photo = await compressImage(file); showPhoto(); }
    catch (err) { toast(err.message); }
    e.target.value = '';
  };
  rm.onclick = () => { photo = ''; showPhoto(); };
  document.getElementById('cancel').onclick = () => { location.hash = backTarget || '#/'; };

  document.getElementById('f').onsubmit = async e => {
    e.preventDefault();
    const val = k => document.getElementById(k).value;
    if (!val('title').trim()) {
      toast('Bitte gib dem Rezept einen Namen.');
      document.getElementById('title').focus();
      return;
    }
    const rec = normalize({
      id: r ? r.id : uid(),
      title: val('title'),
      category: val('cat'),
      servings: val('srv'),
      time: val('time'),
      ingredients: val('ing'),
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
    location.replace('#/rezept/' + encodeURIComponent(rec.id));
  };
}

/* =========================================================
   Ansicht: Einkaufsliste
   ========================================================= */
async function viewShopping() {
  setTab('shop');
  setHeader('Einkaufsliste', null, '<button class="icon-btn" id="shareShop" aria-label="Liste teilen">⇪</button>');
  let items = (await Store.getKV('shopping')) || [];
  const save = () => Store.setKV('shopping', items);

  $view.innerHTML = `
    <form class="shop-add" id="addForm">
      <input id="newItem" placeholder="Artikel hinzufügen …" autocomplete="off" enterkeyhint="done">
      <button class="btn" type="submit" aria-label="Hinzufügen">+</button>
    </form>
    <ul class="shop" id="shop"></ul>
    <div class="row" id="shopBtns">
      <button class="btn secondary" id="clearDone">Erledigte entfernen</button>
      <button class="btn danger" id="clearAll">Alles löschen</button>
    </div>`;

  const ul = document.getElementById('shop');
  const btns = document.getElementById('shopBtns');
  const draw = () => {
    btns.hidden = !items.length;
    if (!items.length) {
      ul.innerHTML = `<li class="empty">Die Einkaufsliste ist leer.<br>
        Füge Artikel hinzu oder übernimm die Zutaten aus einem Rezept.</li>`;
      return;
    }
    const sorted = [...items.filter(i => !i.done), ...items.filter(i => i.done)];
    ul.innerHTML = sorted.map(i => `
      <li class="${i.done ? 'done' : ''}" data-id="${esc(i.id)}">
        <input type="checkbox" ${i.done ? 'checked' : ''} aria-label="Erledigt">
        <span class="txt">${esc(i.text)}${i.from ? `<span class="from">${esc(i.from)}</span>` : ''}</span>
        <button class="del" aria-label="Entfernen">✕</button>
      </li>`).join('');
  };
  draw();

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
    items.unshift({ id: uid(), text, from: '', done: false });
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
    shareText('Einkaufsliste', 'Einkaufsliste:\n' + open.map(i => '• ' + i.text).join('\n'));
  };
}

/* =========================================================
   Ansicht: Mehr (Export / Import / Installation)
   ========================================================= */
function exportFileName() {
  return `rezepte-${new Date().toISOString().slice(0, 10)}.json`;
}
async function buildExportFile() {
  const recipes = await Store.all();
  const data = { app: 'horstl-powers-rezeptbuch', format: 1, exportedAt: new Date().toISOString(), recipes };
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
    else if (rec.updatedAt > (existing.updatedAt || 0)) { await Store.put(rec); updated++; }
    else same++;
  }
  toast(`Import fertig: ${added} neu, ${updated} aktualisiert, ${same} unverändert`);
  await viewMore();
}

async function viewMore() {
  setTab('more');
  setHeader('Mehr', null);
  const count = (await Store.all()).length;
  const share = canShareFiles();

  $view.innerHTML = `
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
      <p>Liest eine Export-Datei ein. Neue Rezepte kommen dazu. Vorhandene werden nur ersetzt,
        wenn die Datei eine neuere Version enthält.</p>
      <label class="btn secondary block" style="margin:0">Datei auswählen …
        <input type="file" id="imp" hidden>
      </label>
    </div>
    <div class="panel">
      <h3>Als App installieren</h3>
      <p><b>iPhone:</b> In Safari unten auf „Teilen“ tippen und „Zum Home-Bildschirm“ wählen.<br>
        <b>Android:</b> In Chrome auf ⋮ tippen und „App installieren“ bzw. „Zum Startbildschirm hinzufügen“ wählen.</p>
    </div>
    <p class="meta" style="text-align:center">Horstl Powers Rezeptbuch · Version ${APP_VERSION}<br>
      Deine Rezepte sind nur auf diesem Gerät gespeichert.</p>`;

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
document.getElementById('backBtn').onclick = () => { if (backTarget) location.hash = backTarget; };
window.addEventListener('hashchange', route);
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
route();
