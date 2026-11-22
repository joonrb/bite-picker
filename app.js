'use strict';

/* ============================================================
   Bite Picker — choose what to order on Talabat
   Data: your own saved places + order log (localStorage),
         nearby places from OpenStreetMap (Overpass API).
   ============================================================ */

const DEFAULT_LOC = { lat: 24.5390, lng: 54.4330, label: 'Saadiyat Island' };
const TALABAT_HOME = 'https://www.talabat.com/uae';
const DAY_MS = 86400000;
const DAY = DAY_MS;
const STORE_KEY = 'bitePicker.v1';
const OSM_CACHE_KEY = 'bitePicker.osmCache';
const PENDING_KEY = 'bitePicker.pending';
const OSM_TTL_MS = 7 * DAY_MS; // restaurants don't change often; the 📍 button forces a refresh
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/* ---------- storage ---------- */

function blankState() {
  return {
    restaurants: [], orders: [], choiceSets: [],
    settings: {
      radiusKm: 5,
      prefs: { mode: 'any', meal: 'auto', genres: [], quick: false, budget: false, savedOnly: false },
    },
  };
}
// Fill in any fields missing from older saves or backups.
function upgradeState(s) {
  const b = blankState();
  const settings = { ...b.settings, ...(s.settings || {}) };
  settings.prefs = { ...b.settings.prefs, ...(settings.prefs || {}) };
  if (!Array.isArray(settings.prefs.genres)) settings.prefs.genres = [];
  return { ...b, ...s, settings };
}
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.restaurants)) return upgradeState(s);
  } catch (_) { /* ignore */ }
  return blankState();
}
let state = loadState();
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (_) { toast('Could not save — storage is full or blocked'); }
}

/* ---------- helpers ---------- */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, '');

function safeUrl(u) {
  try {
    const url = new URL(String(u).trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch (_) { return ''; }
}

function distKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const fmtKm = (d) => (d == null ? '' : d < 1 ? `${Math.round(d * 1000)} m` : `${d.toFixed(1)} km`);

function ago(ts) {
  const d = Math.floor((Date.now() - ts) / DAY);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  const m = Math.floor(d / 30);
  return m === 1 ? 'a month ago' : `${m} months ago`;
}

function mealOf(ts) {
  const h = new Date(ts).getHours();
  if (h >= 5 && h < 11) return 'breakfast';
  if (h >= 11 && h < 16) return 'lunch';
  if (h >= 16 && h < 22) return 'dinner';
  return 'late night';
}

function weightedPick(items, weightFn) {
  const ws = items.map((it) => Math.max(0.0001, weightFn(it)));
  let r = Math.random() * ws.reduce((a, b) => a + b, 0);
  for (let i = 0; i < items.length; i++) { r -= ws[i]; if (r <= 0) return items[i]; }
  return items[items.length - 1];
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}

const prettyCuisine = (c) => c.trim().replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());

/* ---------- stats from order history ---------- */

function computeStats() {
  const map = new Map();
  for (const o of state.orders) {
    const s = map.get(o.restaurantId) || { count: 0, last: 0, meals: {}, dlvSum: 0, dlvN: 0 };
    s.count++;
    s.last = Math.max(s.last, o.at);
    const m = mealOf(o.at);
    s.meals[m] = (s.meals[m] || 0) + 1;
    if (o.deliveryMin) { s.dlvSum += o.deliveryMin; s.dlvN++; }
    map.set(o.restaurantId, s);
  }
  for (const s of map.values()) s.avgDelivery = s.dlvN ? s.dlvSum / s.dlvN : null;
  return map;
}

/* ---------- genres, delivery time, price ---------- */

const genreMemo = new Map();
function genresFor(name, cuisines, type, manual) {
  if (Array.isArray(manual) && manual.length) return manual.filter((g) => GENRE_BY_ID[g]);
  const k = `${name}|${cuisines.join(',')}|${type}`;
  let g = genreMemo.get(k);
  if (!g) { g = inferGenres({ name, cuisines, type }); genreMemo.set(k, g); }
  return g;
}

function genreTags(genres) {
  if (!genres.length) return '<span class="gtag unknown">❔ Other</span>';
  return genres.map((g) => `<span class="gtag">${GENRE_BY_ID[g].emoji} ${esc(GENRE_BY_ID[g].label)}</span>`).join('');
}

/* Your own delivery time beats your logged average, which beats a rough guess from distance. */
function deliveryEst(item, stats) {
  if (item.saved?.deliveryMin) return { min: item.saved.deliveryMin, known: true };
  const s = item.saved && stats.get(item.saved.id);
  if (s?.avgDelivery) return { min: Math.round(s.avgDelivery), known: true };
  if (item.dist != null) return { min: Math.round(15 + item.dist * 3.5), known: false };
  return null;
}
const fmtDelivery = (d) => (d ? `🛵 ~${d.min} min${d.known ? '' : ' (est.)'}` : '');
const PRICE = ['', '$', '$$', '$$$'];

/* ---------- location ---------- */

let here = null;
function locate(force = false) {
  return new Promise((resolve) => {
    if (here && !force) return resolve(here);
    const fallback = () => { here = { ...DEFAULT_LOC }; resolve(here); };
    if (!navigator.geolocation) return fallback();
    navigator.geolocation.getCurrentPosition(
      (p) => { here = { lat: p.coords.latitude, lng: p.coords.longitude, label: 'Your location' }; resolve(here); },
      fallback,
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 5 * 60000 },
    );
  });
}

/* ---------- OpenStreetMap nearby ---------- */

let osmPlaces = [];
let osmStatus = '';

function readOsmCache() {
  try { return JSON.parse(localStorage.getItem(OSM_CACHE_KEY)) || null; } catch (_) { return null; }
}

let seedPlaces = null;
let seedDate = '';
async function loadSeed() {
  if (seedPlaces) return seedPlaces;
  try {
    const s = await (await fetch('places-seed.json')).json();
    seedPlaces = s.places;
    seedDate = s.fetched;
  } catch (_) { seedPlaces = []; }
  return seedPlaces;
}

let fetching = false;
async function fetchNearby(force = false) {
  if (fetching) return;
  const loc = await locate();
  const radius = state.settings.radiusKm;
  const key = `${loc.lat.toFixed(3)},${loc.lng.toFixed(3)},${radius}`;
  const cache = readOsmCache();
  const cacheMatches = cache && cache.key === key;
  if (!force && cacheMatches && Date.now() - cache.at < OSM_TTL_MS) {
    osmPlaces = cache.places;
    osmStatus = '';
    renderAll();
    return;
  }
  // Show something immediately (last search here, or the bundled Saadiyat snapshot) while we refresh.
  osmPlaces = cacheMatches ? cache.places : await loadSeed();
  osmStatus = 'Updating from OpenStreetMap…';
  renderAll();
  fetching = true;
  const q = `[out:json][timeout:25];nwr["amenity"~"^(restaurant|fast_food|cafe)$"]["name"](around:${radius * 1000},${loc.lat},${loc.lng});out center tags;`;
  try {
    for (const ep of OVERPASS_ENDPOINTS) {
      if (await queryOverpass(ep, q, key)) { osmStatus = ''; return; }
    }
    osmStatus = cacheMatches
      ? 'Offline: showing places from your last search.'
      : `Couldn't reach OpenStreetMap: showing the built-in Saadiyat snapshot (${seedDate}).`;
  } finally {
    fetching = false;
    renderAll();
  }
}

async function queryOverpass(ep, q, key) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(ep, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(q),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    osmPlaces = json.elements.map((e) => {
      const t = e.tags || {};
      return {
        osmId: `${e.type}/${e.id}`,
        name: t['name:en'] || t.name,
        cuisines: (t.cuisine || '').split(';').filter(Boolean).map(prettyCuisine),
        type: t.amenity,
        lat: e.lat ?? e.center?.lat,
        lng: e.lon ?? e.center?.lon,
      };
    }).filter((p) => p.name && p.lat != null);
    try { localStorage.setItem(OSM_CACHE_KEY, JSON.stringify({ key, at: Date.now(), places: osmPlaces })); } catch (_) {}
    return true;
  } catch (_) {
    return false; // timeout, network error or server busy: caller tries the next endpoint
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- unified catalog: saved places + OSM places ---------- */

function catalog() {
  const loc = here || DEFAULT_LOC;
  const byOsm = new Map(), byName = new Map();
  for (const r of state.restaurants) {
    if (r.osmId) byOsm.set(r.osmId, r);
    byName.set(norm(r.name), r);
  }
  const used = new Set();
  const out = [];
  for (const p of osmPlaces) {
    const saved = byOsm.get(p.osmId) || byName.get(norm(p.name)) || null;
    if (saved) {
      if (used.has(saved.id)) continue;
      used.add(saved.id);
    }
    out.push(toItem(p, saved, loc));
  }
  for (const r of state.restaurants) {
    if (!used.has(r.id)) out.push(toItem(null, r, loc));
  }
  return out;
}

function toItem(osm, saved, loc) {
  const lat = saved?.lat ?? osm?.lat, lng = saved?.lng ?? osm?.lng;
  const name = saved?.name || osm.name;
  const cuisines = saved?.cuisines?.length ? saved.cuisines : (osm?.cuisines || []);
  const type = osm?.type || saved?.type || 'restaurant';
  return {
    key: saved ? saved.id : osm.osmId,
    name, cuisines, type,
    genres: genresFor(name, cuisines, type, saved?.genres),
    price: saved?.price || 0,
    lat, lng,
    dist: lat != null ? distKm(loc, { lat, lng }) : null,
    osm, saved,
  };
}

function ensureSaved(item) {
  if (item.saved) return item.saved;
  const r = {
    id: uid(), name: item.name, cuisines: item.cuisines, type: item.type,
    lat: item.lat, lng: item.lng, osmId: item.osm?.osmId || '',
    talabatUrl: '', notes: '', hidden: false, addedAt: Date.now(),
  };
  state.restaurants.push(r);
  item.saved = r;
  item.key = r.id;
  save();
  return r;
}

function findItem(key) {
  return catalog().find((i) => i.key === key) || null;
}

/* ---------- actions ---------- */

function logOrder(item) {
  const r = ensureSaved(item);
  const order = { id: uid(), restaurantId: r.id, at: Date.now() };
  state.orders.push(order);
  save();
  renderAll();
  askDeliveryTime(order, r.name);
}

/* One-tap delivery time after logging an order; this powers "Quick delivery". */
function askDeliveryTime(order, name) {
  const b = $('#banner');
  b.innerHTML = `<div>Logged <b>${esc(name)}</b> 🍽️ How long did delivery take?</div>
    <div class="actions">
      <button class="btn sm" data-d="15">Under 20 min</button>
      <button class="btn sm" data-d="25">20–30</button>
      <button class="btn sm" data-d="38">30–45</button>
      <button class="btn sm" data-d="55">45+</button>
      <button class="btn sm" data-d="skip">Skip</button>
    </div>`;
  b.hidden = false;
  b.onclick = (e) => {
    const d = e.target.closest('button')?.dataset.d;
    if (!d) return;
    b.hidden = true;
    if (d !== 'skip') {
      const o = state.orders.find((x) => x.id === order.id);
      if (o) { o.deliveryMin = Number(d); save(); toast('Delivery time saved'); renderAll(); }
    }
  };
}

async function openTalabat(item) {
  const url = safeUrl(item.saved?.talabatUrl);
  if (url) {
    window.open(url, '_blank', 'noopener');
  } else {
    try { await navigator.clipboard.writeText(item.name); toast(`Copied "${item.name}". Paste it into Talabat search.`); }
    catch (_) { toast(`Search Talabat for "${item.name}"`); }
    window.open(TALABAT_HOME, '_blank', 'noopener');
  }
  try { localStorage.setItem(PENDING_KEY, JSON.stringify({ key: item.key, name: item.name, at: Date.now() })); } catch (_) {}
}

function toggleSaved(item) {
  if (item.saved) {
    const s = computeStats().get(item.saved.id);
    if (s) { toast('This place has order history. Hide or delete it from the Mine tab.'); return; }
    state.restaurants = state.restaurants.filter((r) => r.id !== item.saved.id);
    save();
    toast(`Removed ${item.name}`);
  } else {
    ensureSaved(item);
    toast(`Saved ${item.name}. Add its Talabat link in Mine.`);
  }
  renderAll();
}

/* After returning from Talabat, ask whether the user actually ordered. */
function checkPending() {
  let p;
  try { p = JSON.parse(localStorage.getItem(PENDING_KEY)); } catch (_) { p = null; }
  const b = $('#banner');
  if (!p || Date.now() - p.at < 3000 || Date.now() - p.at > 3 * 3600 * 1000) {
    if (p && Date.now() - p.at > 3 * 3600 * 1000) localStorage.removeItem(PENDING_KEY);
    return;
  }
  b.innerHTML = `<div>Did you order from <b>${esc(p.name)}</b>?</div>
    <div class="actions"><button class="btn primary sm" data-a="yes">Yes, log it</button>
    <button class="btn sm" data-a="no">No</button></div>`;
  b.hidden = false;
  b.onclick = (e) => {
    const a = e.target.closest('button')?.dataset.a;
    if (!a) return;
    localStorage.removeItem(PENDING_KEY);
    b.hidden = true;
    if (a === 'yes') {
      const item = findItem(p.key) || catalog().find((i) => norm(i.name) === norm(p.name));
      if (item) logOrder(item);
      else toast('That place is no longer in your list');
    }
  };
}

/* ---------- rendering: shared item card ---------- */

function itemHtml(item, stats, opts = {}) {
  const s = item.saved ? stats.get(item.saved.id) : null;
  const labels = new Set(item.genres.map((g) => norm(GENRE_BY_ID[g].label)));
  const detail = item.cuisines.filter((c) => !labels.has(norm(c))).slice(0, 2).join(', ');
  const meta = [detail, fmtKm(item.dist), fmtDelivery(deliveryEst(item, stats)), PRICE[item.price]]
    .filter(Boolean).join(' · ');
  const badges = (item.saved ? '<span class="badge">★ Saved</span>' : '') +
    (s ? `<span class="badge">${s.count}× ordered</span>` : '<span class="badge new">new to you</span>');
  return `<li class="item" data-key="${esc(item.key)}">
    <div class="name">${esc(item.name)} ${badges}</div>
    <div class="gtags">${genreTags(item.genres)}</div>
    <div class="meta">${esc(meta) || '&nbsp;'}${s ? ` · last ${ago(s.last)}` : ''}</div>
    <div class="actions">
      <button class="btn primary sm" data-act="talabat">Open Talabat</button>
      <button class="btn sm" data-act="ordered">I ordered this</button>
      ${opts.noSave ? '' : `<button class="btn sm" data-act="save">${item.saved ? 'Unsave' : '☆ Save'}</button>`}
    </div>
  </li>`;
}

function bindItemActions(container) {
  container.onclick = (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const key = btn.closest('[data-key]')?.dataset.key;
    const item = key && findItem(key);
    if (!item) return;
    const act = btn.dataset.act;
    if (act === 'talabat') openTalabat(item);
    else if (act === 'ordered') logOrder(item);
    else if (act === 'save') toggleSaved(item);
  };
}

/* ---------- NEARBY tab ---------- */

let nearFilter = 'all';
let nearGenre = 'any';

function renderNearby() {
  const stats = computeStats();
  const q = norm($('#nearSearch').value);
  const radius = state.settings.radiusKm;
  let items = catalog().filter((i) => !i.saved?.hidden);
  items = items.filter((i) => i.saved || i.dist == null || i.dist <= radius);
  if (nearFilter === 'saved') items = items.filter((i) => i.saved);
  else if (nearFilter === 'new') items = items.filter((i) => !(i.saved && stats.get(i.saved.id)));
  if (q) {
    items = items.filter((i) => norm(i.name).includes(q) || i.cuisines.some((c) => norm(c).includes(q)) ||
      i.genres.some((g) => norm(GENRE_BY_ID[g].label).includes(q)));
  }

  // genre chips with counts for what's currently in view
  const counts = {};
  for (const i of items) {
    if (!i.genres.length) counts.other = (counts.other || 0) + 1;
    for (const g of i.genres) counts[g] = (counts[g] || 0) + 1;
  }
  if (nearGenre !== 'any' && !counts[nearGenre]) nearGenre = 'any';
  $('#nearGenres').innerHTML = `<button class="chip ${nearGenre === 'any' ? 'on' : ''}" data-g="any">All genres</button>` +
    GENRES.filter((g) => counts[g.id]).map((g) =>
      `<button class="chip ${nearGenre === g.id ? 'on' : ''}" data-g="${g.id}">${g.emoji} ${esc(g.label)} <span class="count">${counts[g.id]}</span></button>`).join('') +
    (counts.other ? `<button class="chip ${nearGenre === 'other' ? 'on' : ''}" data-g="other">❔ Other <span class="count">${counts.other}</span></button>` : '');

  if (nearGenre === 'other') items = items.filter((i) => !i.genres.length);
  else if (nearGenre !== 'any') items = items.filter((i) => i.genres.includes(nearGenre));
  items.sort((a, b) => (a.dist ?? 999) - (b.dist ?? 999));

  $('#nearStatus').textContent = osmStatus || `${items.length} place${items.length === 1 ? '' : 's'} within ${radius} km`;
  $('#nearList').innerHTML = items.slice(0, 150).map((i) => itemHtml(i, stats)).join('') ||
    '<li class="muted small">Nothing matches. Try a bigger radius in Mine → Settings.</li>';
}

/* ---------- SUGGEST tab ---------- */

const MEALS = ['breakfast', 'lunch', 'dinner', 'late night'];
const MEAL_LABEL = { breakfast: '🍳 Breakfast', lunch: '🥪 Lunch', dinner: '🍽️ Dinner', 'late night': '🌙 Late night' };
const MODES = [
  ['any', '🎯 Anything'],
  ['new', '✨ New to me'],
  ['usual', '❤️ My usuals'],
  ['rediscover', "🔁 Haven't had in a while"],
];
const REDISCOVER_DAYS = 21;
const QUICK_MIN = 30;

let sugCurrent = null; // key of the place on the card
const sugSkipped = new Set();

const prefs = () => state.settings.prefs;
const activeMeal = () => (prefs().meal === 'auto' ? mealOf(Date.now()) : prefs().meal);

function recentGenres(days = 14) {
  const cutoff = Date.now() - days * DAY;
  const byId = new Map(state.restaurants.map((r) => [r.id, r]));
  const set = new Set();
  for (const o of state.orders) {
    if (o.at < cutoff) continue;
    const r = byId.get(o.restaurantId);
    if (r) genresFor(r.name, r.cuisines || [], r.type, r.genres).forEach((g) => set.add(g));
  }
  return set;
}

/* Every place that passes your preferences, with a weight for how good a match it is. */
function scoredPool() {
  const p = prefs();
  const stats = computeStats();
  const radius = state.settings.radiusKm;
  const meal = activeMeal();
  const explicitMeal = p.meal !== 'auto';
  const recent = recentGenres();
  const out = [];
  for (const i of catalog()) {
    if (i.saved?.hidden || sugSkipped.has(i.key)) continue;
    if (i.dist != null && i.dist > radius) continue;
    const s = i.saved ? stats.get(i.saved.id) : null;
    const days = s ? (Date.now() - s.last) / DAY : Infinity;
    if (p.mode === 'new' && s) continue;
    if (p.mode === 'usual' && !s) continue;
    if (p.mode === 'rediscover' && (!s || days < REDISCOVER_DAYS)) continue;
    if (p.genres.length && !i.genres.some((g) => p.genres.includes(g))) continue;
    if (p.savedOnly && !i.saved) continue;
    const dlv = deliveryEst(i, stats);
    if (p.quick && (!dlv || dlv.min > QUICK_MIN)) continue;
    if (p.budget && !(i.price ? i.price === 1 : i.genres.some((g) => BUDGET_GENRES.has(g)))) continue;

    let w = 1;
    if (s) {
      w *= 1 + Math.log2(1 + s.count) * (p.mode === 'usual' ? 1.5 : 1);
      w *= 1 + 2 * ((s.meals[meal] || 0) / s.count); // you tend to order it at this meal
      if (days < 1.5) w *= 0.3; // just had it
      if (p.mode === 'rediscover') w *= Math.min(days, 120) / 30;
    } else {
      if (i.saved) w *= 1.5; // saved but never tried
      if (i.type === 'restaurant') w *= 1.2;
      if (i.genres.length && !i.genres.some((g) => recent.has(g))) w *= 1.6; // something different
    }
    const fit = mealFit(i.genres, meal);
    w *= explicitMeal ? fit * fit : fit;
    if (i.dist != null) w *= 1 / (1 + i.dist / 3);
    if (p.quick && dlv) w *= QUICK_MIN / dlv.min;
    out.push({ item: i, w, s, dlv, fit });
  }
  return out;
}

function reasonFor(e, meal, recent) {
  const bits = [];
  const share = e.s ? (e.s.meals[meal] || 0) / e.s.count : 0;
  if (e.s) bits.push(`Ordered ${e.s.count}×, last ${ago(e.s.last)}`);
  else bits.push(e.item.saved ? 'Saved but never ordered' : "You haven't tried this");
  if (e.s && share >= 0.5 && e.s.count >= 2) bits.push(`you often get it for ${meal}`);
  else if (e.fit >= 1.3) bits.push(`good for ${meal}`);
  if (!e.s && e.item.genres.length && !e.item.genres.some((g) => recent.has(g))) bits.push("a genre you haven't had lately");
  return bits.join(' · ');
}

function prefsSummary() {
  const p = prefs();
  const parts = [MODES.find((m) => m[0] === p.mode)[1]];
  parts.push(p.meal === 'auto' ? `${MEAL_LABEL[activeMeal()]} (now)` : MEAL_LABEL[p.meal]);
  if (p.genres.length) parts.push(p.genres.map((g) => GENRE_BY_ID[g]?.emoji).join(''));
  if (p.quick) parts.push('⚡');
  if (p.budget) parts.push('💸');
  if (p.savedOnly) parts.push('★');
  return parts.join(' · ');
}

function renderPrefs() {
  const p = prefs();
  $('#prefs').open = state.settings.prefsOpen !== false;
  const chip = (attr, v, label, on) => `<button class="chip ${on ? 'on' : ''}" ${attr}="${esc(v)}">${label}</button>`;
  $('#prefSummary').textContent = prefsSummary();
  $('#prefMode').innerHTML = MODES.map(([v, l]) => chip('data-mode', v, l, p.mode === v)).join('');
  $('#prefMeal').innerHTML = chip('data-meal', 'auto', `🕒 Now (${activeMeal()})`, p.meal === 'auto') +
    MEALS.map((m) => chip('data-meal', m, MEAL_LABEL[m], p.meal === m)).join('');
  $('#prefGenres').innerHTML = chip('data-genre', 'any', 'Any genre', !p.genres.length) +
    [...GENRES].sort((x, y) => p.genres.includes(y.id) - p.genres.includes(x.id)) // selected first
      .map((g) => chip('data-genre', g.id, `${g.emoji} ${esc(g.label)}`, p.genres.includes(g.id))).join('');
  $('#prefToggles').innerHTML =
    chip('data-toggle', 'quick', `⚡ Quick delivery (≤${QUICK_MIN} min)`, p.quick) +
    chip('data-toggle', 'budget', '💸 Budget-friendly', p.budget) +
    chip('data-toggle', 'savedOnly', '★ Saved places only', p.savedOnly);
}

function renderSuggest() {
  renderPrefs();
  const stats = computeStats();
  const meal = activeMeal();
  const recent = recentGenres();
  const pool = scoredPool();
  let cur = sugCurrent && pool.find((e) => e.item.key === sugCurrent);
  if (!cur && pool.length) {
    cur = weightedPick(pool, (e) => e.w ** 1.3);
    sugCurrent = cur.item.key;
  }
  if (!cur) sugCurrent = null;

  if (!cur) {
    const p = prefs();
    const hint = sugSkipped.size ? 'You skipped everything that matches!'
      : p.mode === 'usual' || p.mode === 'rediscover'
        ? (state.orders.length ? 'No past orders match these preferences. Try loosening them.' : 'Log orders with “I ordered this” and your usual places will show up here.')
        : 'Try fewer preferences, or a bigger radius in Mine → Settings.';
    $('#sugCard').innerHTML = `<div class="hero"><div class="big-name">No match</div>
      <div class="why">${esc(hint)}</div>
      ${sugSkipped.size ? '<div class="actions"><button class="btn" data-s="reset">Start over</button></div>' : ''}</div>`;
    $('#sugExtra').innerHTML = '';
    return;
  }

  const it = cur.item;
  const meta = [fmtKm(it.dist), fmtDelivery(cur.dlv), PRICE[it.price || 0]].filter(Boolean).join(' · ');
  $('#sugCard').innerHTML = `<div class="hero" data-key="${esc(it.key)}">
    <div class="why">${esc(reasonFor(cur, meal, recent))}</div>
    <div class="big-name">${esc(it.name)}</div>
    <div class="gtags center">${genreTags(it.genres)}</div>
    <div class="muted small">${esc(meta)}</div>
    <div class="actions">
      <button class="btn primary" data-s="talabat">Open Talabat</button>
      <button class="btn" data-s="another">🔄 Another</button>
    </div>
    <div class="actions">
      <button class="btn sm" data-s="ordered">I ordered this</button>
      <button class="btn sm" data-s="never">🚫 Not for me</button>
    </div>
    <div class="muted tiny">${pool.length} ${pool.length === 1 ? 'place matches' : 'places match'} your preferences</div></div>`;

  const more = pool.filter((e) => e !== cur).sort((a, b) => b.w - a.w).slice(0, 5);
  $('#sugExtra').innerHTML = more.length
    ? `<h2>Other good matches</h2><ul class="list">${more.map((e) => itemHtml(e.item, stats, { noSave: true })).join('')}</ul>`
    : '';
}

/* ---------- PICK tab ---------- */

let pickOptions = [];
let spinning = false;

function renderPick() {
  $('#savedNames').innerHTML = state.restaurants.filter((r) => !r.hidden)
    .map((r) => `<option value="${esc(r.name)}">`).join('');
  $('#pickChips').innerHTML = pickOptions.map((o, i) =>
    `<button class="chip" data-i="${i}">${esc(o)}<span class="x">✕</span></button>`).join('') ||
    '<span class="muted small">No choices yet.</span>';
  $('#setList').innerHTML = state.choiceSets.map((s) => `<li class="item">
      <span><b>${esc(s.name)}</b> <span class="muted small">(${s.options.length})</span></span>
      <span><button class="btn sm" data-load="${esc(s.id)}">Load</button>
      <button class="btn sm danger" data-del="${esc(s.id)}">✕</button></span></li>`).join('') ||
    '<li class="muted small">No saved sets.</li>';
}

function pickWeight(name) {
  if (!$('#pickWeighted').checked) return 1;
  const r = state.restaurants.find((x) => norm(x.name) === norm(name));
  if (!r) return 1.5;
  const s = computeStats().get(r.id);
  if (!s) return 2;
  const days = (Date.now() - s.last) / DAY;
  return 0.3 + Math.min(days, 30) / 10;
}

function spin() {
  if (spinning) return;
  if (pickOptions.length < 2) { toast('Add at least 2 choices'); return; }
  spinning = true;
  $('#pickResult').innerHTML = '';
  const winner = weightedPick(pickOptions.map((o, i) => i), (i) => pickWeight(pickOptions[i]));
  const n = pickOptions.length;
  const steps = n * 3 + winner + 1; // 3 full laps, then stop on the winner (last lit index = steps-1 mod n)
  let step = 0;
  const tick = () => {
    const chips = $$('#pickChips .chip');
    chips.forEach((c) => c.classList.remove('hl'));
    chips[step % n]?.classList.add('hl');
    step++;
    if (step < steps) {
      setTimeout(tick, 50 + (step / steps) ** 3 * 350);
    } else {
      spinning = false;
      showPickResult(pickOptions[winner]);
    }
  };
  tick();
}

function showPickResult(name) {
  const item = catalog().find((i) => norm(i.name) === norm(name));
  $('#pickResult').innerHTML = `<div class="hero" ${item ? `data-key="${esc(item.key)}"` : ''}>
    <div class="why">The winner is</div>
    <div class="big-name">🎉 ${esc(name)}</div>
    <div class="actions">
      <button class="btn primary" data-p="talabat">Open Talabat</button>
      <button class="btn" data-p="ordered">I ordered this</button>
      <button class="btn" data-p="again">Spin again</button>
    </div></div>`;
  $('#pickResult').onclick = (e) => {
    const a = e.target.closest('button')?.dataset.p;
    if (!a) return;
    const it = catalog().find((i) => norm(i.name) === norm(name)) ||
      { key: 'tmp', name, cuisines: [], type: 'restaurant', lat: null, lng: null, saved: null, osm: null };
    if (a === 'talabat') {
      if (it.key === 'tmp') ensureSaved(it);
      openTalabat(it);
    } else if (a === 'ordered') logOrder(it);
    else if (a === 'again') spin();
  };
}

/* ---------- MINE tab ---------- */

let editingId = null;

function renderMine() {
  const stats = computeStats();
  const q = norm($('#mineSearch').value);
  const list = state.restaurants
    .filter((r) => !q || norm(r.name).includes(q) || (r.cuisines || []).some((c) => norm(c).includes(q)) ||
      genresFor(r.name, r.cuisines || [], r.type, r.genres).some((g) => norm(GENRE_BY_ID[g].label).includes(q)))
    .sort((a, b) => (stats.get(b.id)?.count || 0) - (stats.get(a.id)?.count || 0) || a.name.localeCompare(b.name));

  const cat = new Map(catalog().map((i) => [i.key, i]));
  $('#mineList').innerHTML = list.map((r) => {
    const s = stats.get(r.id);
    const item = cat.get(r.id) || toItem(null, r, here || DEFAULT_LOC);
    const meta = [s ? `${s.count}× · last ${ago(s.last)}` : 'never ordered', PRICE[r.price || 0],
      fmtDelivery(deliveryEst(item, stats)), r.talabatUrl ? '🔗 Talabat link' : 'no Talabat link'].filter(Boolean).join(' · ');
    const editing = editingId === r.id;
    return `<li class="item" data-key="${esc(r.id)}" ${r.hidden ? 'style="opacity:.55"' : ''}>
      <div class="name">${esc(r.name)} ${r.hidden ? '<span class="badge new">hidden</span>' : ''}</div>
      <div class="gtags">${genreTags(item.genres)}${item.genres.length ? '' : ' <span class="muted small">Tap Edit to set a genre</span>'}</div>
      <div class="meta">${esc(meta)}</div>
      ${r.notes ? `<div class="meta">📝 ${esc(r.notes)}</div>` : ''}
      ${editing ? `<form class="edit" data-edit="${esc(r.id)}">
          <input class="field" name="name" value="${esc(r.name)}" required>
          ${placeFieldsHtml(r, item.genres)}
          <div class="row"><button class="btn primary sm" type="submit">Save</button>
          <button class="btn sm" type="button" data-m="cancel">Cancel</button></div>
        </form>` : `<div class="actions">
          <button class="btn primary sm" data-act="talabat">Open Talabat</button>
          <button class="btn sm" data-act="ordered">I ordered this</button>
          <button class="btn sm" data-m="edit">Edit</button>
          <button class="btn sm" data-m="hide">${r.hidden ? 'Unhide' : 'Hide'}</button>
          <button class="btn sm danger" data-m="delete">Delete</button>
        </div>`}
    </li>`;
  }).join('') || '<li class="muted small">No saved places yet. Save some from Nearby or add one above.</li>';

  const byId = new Map(state.restaurants.map((r) => [r.id, r]));
  $('#historyList').innerHTML = [...state.orders].sort((a, b) => b.at - a.at).slice(0, 40).map((o) =>
    `<li class="item"><span><b>${esc(byId.get(o.restaurantId)?.name || '(deleted place)')}</b>
      <span class="muted small"> · ${new Date(o.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${mealOf(o.at)}</span></span>
      <button class="btn sm danger" data-order="${esc(o.id)}">✕</button></li>`).join('') ||
    '<li class="muted small">No orders logged yet.</li>';

  $('#radius').value = state.settings.radiusKm;
  $('#radiusVal').textContent = state.settings.radiusKm;
}

const parseCuisines = (s) => String(s || '').split(',').map((c) => c.trim()).filter(Boolean).map(prettyCuisine);

/* Shared fields for the "add place" and "edit place" forms. */
function placeFieldsHtml(r, genres) {
  const opt = (v, label) => `<option value="${v}" ${Number(r.price || 0) === v ? 'selected' : ''}>${label}</option>`;
  return `<div class="field-label">Genre (pick up to 2)</div>
    <div class="chips wrap genre-pick">${GENRES.map((g) =>
      `<label class="chip"><input type="checkbox" name="genres" value="${g.id}" ${genres.includes(g.id) ? 'checked' : ''}>${g.emoji} ${esc(g.label)}</label>`).join('')}</div>
    <input class="field" name="cuisines" value="${esc((r.cuisines || []).join(', '))}" placeholder="Dishes / cuisine details, comma separated">
    <div class="row">
      <select class="field" name="price">${opt(0, 'Price: not set')}${opt(1, '$ Cheap')}${opt(2, '$$ Medium')}${opt(3, '$$$ Pricey')}</select>
      <input class="field" name="deliveryMin" type="number" min="5" max="120" inputmode="numeric" value="${r.deliveryMin || ''}" placeholder="Usual delivery (min)">
    </div>
    <input class="field" name="talabatUrl" type="url" value="${esc(r.talabatUrl || '')}" placeholder="Talabat link (Share → Copy link in Talabat)">
    <input class="field" name="notes" value="${esc(r.notes || '')}" placeholder="Notes (favorite dish…)">`;
}

/* Read the shared fields back; returns null (after a toast) if something is invalid. */
function readPlaceFields(f) {
  const rawUrl = String(f.get('talabatUrl') || '').trim();
  if (rawUrl && !safeUrl(rawUrl)) { toast("That link doesn't look like a web address"); return null; }
  const genres = f.getAll('genres').filter((g) => GENRE_BY_ID[g]);
  if (genres.length > 2) { toast('Pick at most 2 genres'); return null; }
  const dm = Number(f.get('deliveryMin'));
  return {
    genres,
    cuisines: parseCuisines(f.get('cuisines')),
    price: Number(f.get('price')) || 0,
    deliveryMin: dm >= 5 && dm <= 120 ? Math.round(dm) : null,
    talabatUrl: safeUrl(rawUrl),
    notes: String(f.get('notes') || '').trim(),
  };
}

/* ---------- tabs & wiring ---------- */

let currentTab = 'nearby';
const TITLES = { nearby: 'Nearby', suggest: 'Suggest', pick: 'Pick for me', mine: 'Mine' };
const RENDER = { nearby: renderNearby, suggest: renderSuggest, pick: renderPick, mine: renderMine };

function showTab(name) {
  currentTab = name;
  $$('.tab').forEach((t) => { t.hidden = t.id !== `tab-${name}`; });
  $$('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  $('#title').textContent = TITLES[name];
  RENDER[name]();
  window.scrollTo(0, 0);
}
function renderAll() { RENDER[currentTab](); }

function updateLocLabel() {
  $('#locLabel').textContent = here ? here.label : 'Locating…';
}

function wire() {
  $$('.tabbar button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  $('#locBtn').addEventListener('click', async () => {
    $('#locLabel').textContent = 'Locating…';
    await locate(true);
    updateLocLabel();
    if (here.label === DEFAULT_LOC.label) toast('Location unavailable, using Saadiyat Island');
    await fetchNearby(true);
  });

  // Nearby
  $('#nearSearch').addEventListener('input', renderNearby);
  $('#nearFilters').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    nearFilter = c.dataset.f;
    $$('#nearFilters .chip').forEach((x) => x.classList.toggle('on', x === c));
    renderNearby();
  });
  $('#nearGenres').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    nearGenre = c.dataset.g;
    renderNearby();
  });
  bindItemActions($('#nearList'));

  // Suggest
  $('#prefs').addEventListener('click', (e) => {
    const b = e.target.closest('button.chip');
    if (!b) return;
    const p = prefs();
    const d = b.dataset;
    if (d.mode) p.mode = d.mode;
    else if (d.meal) p.meal = d.meal;
    else if (d.genre) {
      if (d.genre === 'any') p.genres = [];
      else if (p.genres.includes(d.genre)) p.genres = p.genres.filter((g) => g !== d.genre);
      else p.genres = [...p.genres, d.genre];
    } else if (d.toggle) p[d.toggle] = !p[d.toggle];
    else return;
    save();
    sugCurrent = null;
    sugSkipped.clear();
    renderSuggest();
  });
  $('#prefs').addEventListener('toggle', () => {
    if (state.settings.prefsOpen === $('#prefs').open) return;
    state.settings.prefsOpen = $('#prefs').open;
    save();
  });
  $('#prefReset').addEventListener('click', () => {
    state.settings.prefs = blankState().settings.prefs;
    save();
    sugCurrent = null;
    sugSkipped.clear();
    renderSuggest();
  });
  $('#sugCard').addEventListener('click', (e) => {
    const a = e.target.closest('button')?.dataset.s;
    if (!a) return;
    if (a === 'reset') { sugSkipped.clear(); sugCurrent = null; renderSuggest(); return; }
    const item = sugCurrent && findItem(sugCurrent);
    if (!item) return;
    if (a === 'talabat') openTalabat(item);
    else if (a === 'ordered') { logOrder(item); }
    else if (a === 'another') { sugSkipped.add(item.key); sugCurrent = null; renderSuggest(); }
    else if (a === 'never') {
      const r = ensureSaved(item);
      r.hidden = true;
      save();
      toast(`Hidden ${r.name}. Unhide it in Mine.`);
      sugCurrent = null;
      renderSuggest();
    }
  });
  bindItemActions($('#sugExtra'));

  // Pick
  $('#pickForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#pickInput').value.trim();
    if (!v) return;
    if (pickOptions.some((o) => norm(o) === norm(v))) { toast('Already in the list'); return; }
    pickOptions.push(v);
    $('#pickInput').value = '';
    renderPick();
  });
  $('#pickChips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c || spinning) return;
    pickOptions.splice(Number(c.dataset.i), 1);
    renderPick();
  });
  $('#spinBtn').addEventListener('click', spin);
  $('#saveSet').addEventListener('click', () => {
    const name = $('#setName').value.trim();
    if (!name) { toast('Give the set a name'); return; }
    if (pickOptions.length < 2) { toast('Add at least 2 choices first'); return; }
    const existing = state.choiceSets.find((s) => norm(s.name) === norm(name));
    if (existing) existing.options = [...pickOptions];
    else state.choiceSets.push({ id: uid(), name, options: [...pickOptions] });
    save();
    $('#setName').value = '';
    toast(`Saved set “${name}”`);
    renderPick();
  });
  $('#setList').addEventListener('click', (e) => {
    const load = e.target.closest('[data-load]')?.dataset.load;
    const del = e.target.closest('[data-del]')?.dataset.del;
    if (load) {
      const s = state.choiceSets.find((x) => x.id === load);
      if (s) { pickOptions = [...s.options]; $('#pickResult').innerHTML = ''; renderPick(); }
    } else if (del) {
      state.choiceSets = state.choiceSets.filter((x) => x.id !== del);
      save();
      renderPick();
    }
  });

  // Mine
  $('#mineSearch').addEventListener('input', renderMine);
  $('#addForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const name = String(f.get('name')).trim();
    if (!name) return;
    if (state.restaurants.some((r) => norm(r.name) === norm(name))) { toast('You already saved a place with that name'); return; }
    const fields = readPlaceFields(f);
    if (!fields) return;
    state.restaurants.push({
      id: uid(), name, type: 'restaurant', lat: null, lng: null, osmId: '',
      hidden: false, addedAt: Date.now(), ...fields,
    });
    save();
    e.target.reset();
    $('#addFields').innerHTML = placeFieldsHtml({}, []);
    $('#addCard').open = false;
    toast(`Saved ${name}`);
    renderMine();
  });
  $('#mineList').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = btn.closest('[data-key]')?.dataset.key;
    const r = state.restaurants.find((x) => x.id === id);
    if (!r) return;
    if (btn.dataset.act) {
      const item = findItem(id);
      if (!item) return;
      if (btn.dataset.act === 'talabat') openTalabat(item);
      else if (btn.dataset.act === 'ordered') logOrder(item);
      return;
    }
    const m = btn.dataset.m;
    if (m === 'edit') { editingId = id; renderMine(); }
    else if (m === 'cancel') { editingId = null; renderMine(); }
    else if (m === 'hide') { r.hidden = !r.hidden; save(); renderMine(); }
    else if (m === 'delete') {
      if (btn.dataset.confirm !== '1') { btn.dataset.confirm = '1'; btn.textContent = 'Tap again to delete'; return; }
      state.restaurants = state.restaurants.filter((x) => x.id !== id);
      state.orders = state.orders.filter((o) => o.restaurantId !== id);
      save();
      toast(`Deleted ${r.name}`);
      renderMine();
    }
  });
  $('#mineList').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = e.target.dataset.edit;
    const r = state.restaurants.find((x) => x.id === id);
    if (!r) return;
    const f = new FormData(e.target);
    const fields = readPlaceFields(f);
    if (!fields) return;
    r.name = String(f.get('name')).trim() || r.name;
    Object.assign(r, fields);
    save();
    editingId = null;
    toast('Saved');
    renderMine();
  });
  $('#historyList').addEventListener('click', (e) => {
    const id = e.target.closest('[data-order]')?.dataset.order;
    if (!id) return;
    state.orders = state.orders.filter((o) => o.id !== id);
    save();
    renderMine();
  });

  // Settings
  $('#radius').addEventListener('input', (e) => { $('#radiusVal').textContent = e.target.value; });
  $('#radius').addEventListener('change', async (e) => {
    state.settings.radiusKm = Number(e.target.value);
    save();
    sugCurrent = null;
    await fetchNearby();
    toast(`Radius set to ${state.settings.radiusKm} km`);
  });
  $('#exportBtn').addEventListener('click', async () => {
    const json = JSON.stringify(state, null, 2);
    const fileName = `bite-picker-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([json], fileName, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Bite Picker backup' }); return; } catch (_) { /* fall through */ }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  $('#importFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!Array.isArray(data.restaurants) || !Array.isArray(data.orders)) throw new Error('bad file');
      state = upgradeState(data);
      save();
      toast(`Imported ${state.restaurants.length} places and ${state.orders.length} orders`);
      renderAll();
    } catch (_) { toast('That is not a Bite Picker backup file'); }
    e.target.value = '';
  });
  $('#resetBtn').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.confirm !== '1') { btn.dataset.confirm = '1'; btn.textContent = 'Tap again to erase everything'; return; }
    state = blankState();
    save();
    btn.dataset.confirm = '';
    btn.textContent = 'Erase all data';
    toast('All data erased');
    renderAll();
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkPending(); });
  window.addEventListener('focus', checkPending);
}

/* ---------- boot ---------- */

async function boot() {
  $('#addFields').innerHTML = placeFieldsHtml({}, []);
  wire();
  showTab('nearby');
  checkPending();
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  await locate();
  updateLocLabel();
  await fetchNearby();
}
boot();
