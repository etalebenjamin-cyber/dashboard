// Dashboard Perso — app.js
// Architecture : local-first + sidebar router + bento

// ── Config ────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'dashboard_perso_v1';
const META_KEY    = 'dashboard_perso_v1_meta';
const clientId    = uid();
// Mode standalone : pas de serveur (GitHub Pages, Cloudflare Pages, etc.)
const STANDALONE  = location.hostname.endsWith('.github.io')
                 || location.hostname.endsWith('.pages.dev')
                 || location.hostname.endsWith('.netlify.app')
                 || location.hostname.endsWith('.vercel.app');
const IS_SERVER   = !STANDALONE && location.protocol !== 'file:';

let serverOnline = false;
let pendingSync  = false;
let reachTimer   = null;
let sseConn      = null;

// ── Storage helpers ───────────────────────────────────────────────────────

function loadLocalState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    return { ...defaultState(), ...JSON.parse(raw) };
  } catch { return defaultState(); }
}

function saveLocal(s) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {}
}

function loadMeta() {
  try { return JSON.parse(localStorage.getItem(META_KEY) || '{}'); }
  catch { return {}; }
}

function saveMeta(m) {
  try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch {}
}

function defaultState() {
  return {
    tasks:    [],
    habits:   [
      { id: 'h1', name: 'Exercice',    color: '#10B981', completions: [] },
      { id: 'h2', name: 'Lecture',     color: '#6366F1', completions: [] },
      { id: 'h3', name: 'Méditation',  color: '#F59E0B', completions: [] },
      { id: 'h4', name: 'Hydratation', color: '#3B82F6', completions: [] },
    ],
    finance:  { balance: 0, transactions: [] },
    moods:    [],
    journal:  [],
    sleep:    [],
    weight:   [],
    budget:   { monthly: 0 },
    pomodoro: { sessions: [] },
    inbox:    [],
    water:    {},          // { 'YYYY-MM-DD': count }
    energy:   [],          // [{ date, time, value }]
    goals:    [],          // [{ id, label, progress: 0-100 }]
    countdowns: [],        // [{ id, label, date: 'YYYY-MM-DD' }]
    rewards:  [
      { id: 'rw1', emoji: '🍕', label: 'Cheat meal',          target: 7,  tracker: 'global_streak',  claimed: 0, history: [] },
      { id: 'rw2', emoji: '🎮', label: '2h gaming',           target: 10, tracker: 'week_focus',     claimed: 0, history: [] },
      { id: 'rw3', emoji: '😴', label: 'Grasse mat\' weekend', target: 5,  tracker: 'morning_streak', claimed: 0, history: [] },
      { id: 'rw4', emoji: '📺', label: 'Soirée Netflix chill', target: 20, tracker: 'week_tasks',     claimed: 0, history: [] },
      { id: 'rw5', emoji: '🍫', label: 'Carré de chocolat',    target: 3,  tracker: 'global_streak',  claimed: 0, history: [] }
    ],
    routines: {
      morning: [
        { id: 'rm1', text: 'Réveil sans snooze' },
        { id: 'rm2', text: 'Boire un grand verre d\'eau' },
        { id: 'rm3', text: 'Étirements 5 min' },
        { id: 'rm4', text: 'Petit-déjeuner' }
      ],
      evening: [
        { id: 're1', text: 'Dîner léger' },
        { id: 're2', text: 'Préparer le sac du lendemain' },
        { id: 're3', text: 'Brossage de dents' },
        { id: 're4', text: 'Lecture 10 min' }
      ],
      completions: {}      // { 'YYYY-MM-DD': { rm1: true, ... } }
    },
    _mt: 0
  };
}

// ── Server reachability ───────────────────────────────────────────────────

async function pingServer(ms = 2500) {
  if (!IS_SERVER) return false;
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), ms);
    const res  = await fetch('/api/state', { cache: 'no-store', signal: ctrl.signal });
    clearTimeout(tid);
    return res.ok;
  } catch { return false; }
}

function startReachPoll() {
  if (reachTimer || !IS_SERVER) return;
  reachTimer = setInterval(async () => {
    if (await pingServer()) {
      clearInterval(reachTimer); reachTimer = null;
      handleReconnect();
    }
  }, 8000);
}

function stopReachPoll() {
  if (reachTimer) { clearInterval(reachTimer); reachTimer = null; }
}

// ── Load + Save ───────────────────────────────────────────────────────────

async function loadState() {
  const local = loadLocalState();
  if (!IS_SERVER) { serverOnline = false; return local; }

  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 3000);
    const res  = await fetch('/api/state', { cache: 'no-store', signal: ctrl.signal });
    clearTimeout(tid);
    if (!res.ok) throw new Error();
    const remote = await res.json();

    serverOnline = true;
    setSyncStatus('online');

    const meta = loadMeta();
    if (meta.pendingSync) {
      const merged = mergeStates(remote, local);
      pushToServer(merged);
      saveLocal(merged);
      saveMeta({ pendingSync: false });
      pendingSync = false;
      return merged;
    }
    saveLocal(remote);
    saveMeta({ pendingSync: false });
    pendingSync = false;
    return remote;
  } catch {
    serverOnline = false;
    pendingSync  = !!loadMeta().pendingSync;
    setSyncStatus('offline');
    startReachPoll();
    return local;
  }
}

function save() {
  state._mt = Date.now();
  saveLocal(state);
  if (!IS_SERVER) return;
  if (serverOnline) {
    fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, state })
    }).then(res => { if (!res.ok) throw new Error(); })
      .catch(() => {
        serverOnline = false;
        pendingSync  = true;
        saveMeta({ pendingSync: true });
        setSyncStatus('offline');
        startReachPoll();
      });
  } else {
    pendingSync = true;
    saveMeta({ pendingSync: true });
    setSyncStatus('offline');
    startReachPoll();
  }
}

function pushToServer(s) {
  return fetch('/api/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, state: s })
  });
}

async function handleReconnect() {
  setSyncStatus('syncing');
  try {
    const res    = await fetch('/api/state', { cache: 'no-store' });
    const remote = await res.json();
    const meta   = loadMeta();

    if (meta.pendingSync) {
      const merged = mergeStates(remote, state);
      state = merged;
      await pushToServer(merged);
      saveLocal(merged);
    } else if ((remote._mt || 0) > (state._mt || 0)) {
      state = remote;
      saveLocal(remote);
    }
    saveMeta({ pendingSync: false });
    pendingSync  = false;
    serverOnline = true;
    setSyncStatus('online');
    renderAll();
    initSSE();
  } catch {
    serverOnline = false;
    setSyncStatus('offline');
    startReachPoll();
  }
}

// ── Merge ─────────────────────────────────────────────────────────────────

function mergeStates(remote, local) {
  const localNewer = (local._mt || 0) > (remote._mt || 0);
  return {
    tasks:    mergeByKey(remote.tasks    || [], local.tasks    || [], 'id',   localNewer),
    habits:   mergeHabits(remote.habits  || [], local.habits   || [], localNewer),
    finance: {
      balance: localNewer ? local.finance.balance : (remote.finance || {}).balance || 0,
      transactions: mergeByKey(
        (remote.finance && remote.finance.transactions) || [],
        (local.finance  && local.finance.transactions)  || [],
        'id', localNewer
      )
    },
    moods:    mergeByKey(remote.moods   || [], local.moods   || [], 'date', localNewer),
    journal:  mergeByKey(remote.journal || [], local.journal || [], 'date', localNewer),
    sleep:    mergeByKey(remote.sleep   || [], local.sleep   || [], 'date', localNewer),
    weight:   mergeByKey(remote.weight  || [], local.weight  || [], 'date', localNewer),
    budget:   { monthly: localNewer ? (local.budget||{}).monthly||0 : (remote.budget||{}).monthly||0 },
    pomodoro: { sessions: mergeMaxByDate(
      ((remote.pomodoro||{}).sessions || []),
      ((local.pomodoro ||{}).sessions || [])
    )},
    inbox:      mergeByKey(remote.inbox     || [], local.inbox     || [], 'id', localNewer),
    water:      mergeWater(remote.water     || {}, local.water     || {}),
    energy:     mergeByKey(remote.energy    || [], local.energy    || [], 'id', localNewer),
    goals:      mergeByKey(remote.goals     || [], local.goals     || [], 'id', localNewer),
    countdowns: mergeByKey(remote.countdowns|| [], local.countdowns|| [], 'id', localNewer),
    rewards:    mergeByKey(remote.rewards   || [], local.rewards   || [], 'id', localNewer),
    routines:   mergeRoutines(remote.routines || {}, local.routines || {}, localNewer),
    _mt: Math.max(remote._mt || 0, local._mt || 0)
  };
}

function mergeByKey(arrR, arrL, key, localWins) {
  const map = new Map();
  for (const it of arrR) map.set(it[key], it);
  for (const it of arrL) {
    if (!map.has(it[key]) || localWins) map.set(it[key], it);
  }
  return Array.from(map.values());
}

function mergeHabits(arrR, arrL, localWins) {
  const map = new Map();
  for (const h of arrR) map.set(h.id, { ...h, completions: new Set(h.completions || []) });
  for (const h of arrL) {
    const existing = map.get(h.id);
    const completions = new Set([
      ...(existing ? existing.completions : []),
      ...(h.completions || [])
    ]);
    if (!existing || localWins) map.set(h.id, { ...h, completions });
    else map.set(h.id, { ...existing, completions });
  }
  return Array.from(map.values()).map(h => ({
    ...h, completions: Array.from(h.completions).sort()
  }));
}

function mergeMaxByDate(arrR, arrL) {
  const map = new Map();
  for (const it of arrR) map.set(it.date, it);
  for (const it of arrL) {
    const e = map.get(it.date);
    if (!e || (it.count || 0) > (e.count || 0)) map.set(it.date, it);
  }
  return Array.from(map.values());
}

function mergeWater(a, b) {
  const out = { ...a };
  for (const d in b) out[d] = Math.max(a[d] || 0, b[d] || 0);
  return out;
}

function mergeRoutines(a, b, localWins) {
  const morning = (localWins ? b.morning : a.morning) || a.morning || b.morning || [];
  const evening = (localWins ? b.evening : a.evening) || a.evening || b.evening || [];
  const completions = { ...(a.completions || {}) };
  for (const d in (b.completions || {})) {
    completions[d] = { ...(completions[d] || {}), ...b.completions[d] };
  }
  return { morning, evening, completions };
}

// ── SSE ───────────────────────────────────────────────────────────────────

function initSSE() {
  if (!IS_SERVER) return;
  if (sseConn) { try { sseConn.close(); } catch {} }
  sseConn = new EventSource('/api/events');
  sseConn.onopen = () => {
    serverOnline = true;
    stopReachPoll();
    setSyncStatus('online');
  };
  sseConn.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.clientId === clientId) return;
      state = msg.state;
      saveLocal(state);
      renderAll();
    } catch {}
  };
  sseConn.onerror = () => {
    try { sseConn.close(); } catch {}
    sseConn = null;
    serverOnline = false;
    setSyncStatus('offline');
    startReachPoll();
  };
}

function setSyncStatus(s) {
  if (STANDALONE) s = 'local';
  const d = document.getElementById('sync-dot');
  const l = document.getElementById('sync-lbl');
  if (d) d.className = 'sync-dot ' + s;
  if (l) l.textContent = {
    online:  'Synchronisé',
    offline: 'Hors-ligne',
    syncing: 'Sync…',
    local:   'Local'
  }[s] || 'Sync';
}

window.addEventListener('online',  () => { if (!serverOnline) startReachPoll(); });
window.addEventListener('offline', () => { serverOnline = false; setSyncStatus('offline'); });

// ── Utils ─────────────────────────────────────────────────────────────────

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

function last7Days() {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - (6 - i));
    return d.toISOString().slice(0, 10);
  });
}
function lastNDays(n) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - (n - 1 - i));
    return d.toISOString().slice(0, 10);
  });
}
function shortDate(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}
function dayInitial(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('fr-FR', { weekday: 'narrow' });
}
function fmtAmount(n) {
  return new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(n));
}
function fmtShort(n) { return n >= 100 ? Math.round(n) : n.toFixed(0); }
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Router ────────────────────────────────────────────────────────────────

const VIEW_TITLES = {
  today:    "Aujourd'hui",
  habits:   "Habitudes",
  finance:  "Finances",
  wellness: "Bien-être",
  journal:  "Journal"
};

function setView(name) {
  document.querySelectorAll('.view').forEach(v => v.hidden = true);
  const target = document.getElementById('view-' + name);
  if (target) target.hidden = false;
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.view === name);
  });
  document.getElementById('page-title').textContent = VIEW_TITLES[name] || name;
  const sub = document.getElementById('page-sub');
  if (sub) {
    sub.textContent = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  // Re-render visible view in case data changed
  renderAll();
}

function initRouter() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.onclick = () => setView(btn.dataset.view);
  });
}

// ── Clock ─────────────────────────────────────────────────────────────────

function initClock() {
  function tick() {
    document.getElementById('clock').textContent =
      new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const sub = document.getElementById('page-sub');
    if (sub) sub.textContent = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  tick();
  setInterval(tick, 30000);
}

// ── Citation ──────────────────────────────────────────────────────────────

const CITATIONS = [
  { t: "Commence là où tu es. Utilise ce que tu as. Fais ce que tu peux.", a: "Arthur Ashe" },
  { t: "La discipline est le pont entre les objectifs et les réalisations.", a: "Jim Rohn" },
  { t: "Fais de chaque jour ton chef-d'œuvre.", a: "John Wooden" },
  { t: "Sois le changement que tu veux voir dans le monde.", a: "Gandhi" },
  { t: "L'action est la clé fondamentale de tout succès.", a: "Pablo Picasso" },
  { t: "Le succès, c'est d'aller d'échec en échec sans perdre son enthousiasme.", a: "Churchill" },
  { t: "La vie c'est comme une bicyclette : il faut avancer pour ne pas perdre l'équilibre.", a: "Einstein" },
  { t: "Peu importe la lenteur, du moment que tu ne t'arrêtes pas.", a: "Confucius" },
  { t: "Les grandes réalisations sont faites de petites victoires accumulées.", a: "" },
  { t: "Un voyage de mille lieues commence par un premier pas.", a: "Lao Tseu" },
  { t: "Hier est de l'histoire, demain est un mystère, aujourd'hui est un cadeau.", a: "" },
  { t: "La meilleure façon de prédire l'avenir, c'est de le créer.", a: "Peter Drucker" },
  { t: "Le bonheur n'est pas tout fait. Il vient de tes propres actions.", a: "Dalaï-Lama" },
  { t: "Chaque matin est une nouvelle chance de faire mieux qu'hier.", a: "" },
  { t: "Ne compte pas les jours, fais que les jours comptent.", a: "Muhammad Ali" },
  { t: "Tu n'as pas à être parfait pour commencer, mais tu dois commencer.", a: "" },
  { t: "Crois en toi et tout devient possible.", a: "" },
  { t: "La simplicité est la sophistication suprême.", a: "Léonard de Vinci" },
  { t: "Vis comme si tu devais mourir demain. Apprends comme si tu devais vivre toujours.", a: "Gandhi" },
];

function initCitation() {
  const c = CITATIONS[new Date().getDate() % CITATIONS.length];
  const el = document.getElementById('citation');
  if (el) el.textContent = c.a ? `« ${c.t} » — ${c.a}` : `« ${c.t} »`;
}

// ═══════════════════════════════════════════════════════════════════════════
// HERO (résumé du jour)
// ═══════════════════════════════════════════════════════════════════════════

function renderHero() {
  const t = todayStr();
  const tasksToday = state.tasks.filter(x => x.date === t);
  const tasksDone  = tasksToday.filter(x => x.done).length;
  const habitsDone = state.habits.filter(h => h.completions.includes(t)).length;
  const water      = (state.water || {})[t] || 0;
  const focusCount = (JSON.parse(localStorage.getItem('pom_sessions') || '{}'))[t] || 0;

  setHeroStat('hero-tasks',  `${tasksDone}/${tasksToday.length || 0}`, 'Tâches');
  setHeroStat('hero-habits', `${habitsDone}/${state.habits.length}`,  'Habitudes');
  setHeroStat('hero-water',  `${water}`,                              'Verres d\'eau');
  setHeroStat('hero-focus',  `${focusCount}`,                         'Sessions focus');
}

function setHeroStat(id, num, lbl) {
  const el = document.getElementById(id);
  if (!el) return;
  el.querySelector('.hero-stat-num').textContent = num;
  el.querySelector('.hero-stat-lbl').textContent = lbl;
}

// ═══════════════════════════════════════════════════════════════════════════
// TASKS
// ═══════════════════════════════════════════════════════════════════════════

function renderTasks() {
  const t   = todayStr();
  const all = state.tasks.filter(x => x.date === t);
  const done = all.filter(x => x.done).length;
  const pill = document.getElementById('tasks-pill');
  if (pill) {
    pill.textContent = all.length ? `${done}/${all.length}` : '';
    pill.style.display = all.length ? '' : 'none';
  }
  const list = document.getElementById('task-list');
  if (!list) return;
  if (!all.length) { list.innerHTML = '<li class="empty-state">Aucune tâche aujourd\'hui</li>'; return; }
  list.innerHTML = all.map(task => `
    <li class="task-item${task.done ? ' done' : ''}" data-id="${task.id}">
      <input type="checkbox" ${task.done ? 'checked' : ''} onchange="toggleTask('${task.id}')">
      <span class="task-text">${esc(task.text)}</span>
      <button class="del-btn" onclick="deleteTask('${task.id}')">×</button>
    </li>`).join('');
}

function addTask() {
  const inp = document.getElementById('task-input');
  const text = inp.value.trim();
  if (!text) return;
  state.tasks.push({ id: uid(), text, done: false, date: todayStr() });
  save(); renderTasks(); renderHero(); inp.value = ''; inp.focus();
}

window.toggleTask = function(id) {
  const t = state.tasks.find(x => x.id === id);
  if (t) { t.done = !t.done; save(); renderTasks(); renderHero(); }
};
window.deleteTask = function(id) {
  state.tasks = state.tasks.filter(x => x.id !== id);
  save(); renderTasks(); renderHero();
};
function clearDone() {
  state.tasks = state.tasks.filter(x => !(x.date === todayStr() && x.done));
  save(); renderTasks(); renderHero();
}

function initTasks() {
  const add = document.getElementById('btn-add-task');
  if (add) add.onclick = addTask;
  const clear = document.getElementById('btn-clear-tasks');
  if (clear) clear.onclick = clearDone;
  const inp = document.getElementById('task-input');
  if (inp) inp.onkeydown = e => { if (e.key === 'Enter') addTask(); };
}

// ═══════════════════════════════════════════════════════════════════════════
// INBOX
// ═══════════════════════════════════════════════════════════════════════════

function renderInbox() {
  const list = document.getElementById('inbox-list');
  if (!list) return;
  const items = (state.inbox || []).slice().reverse();
  if (!items.length) {
    list.innerHTML = '<li class="empty-state">Vide — tape une idée au-dessus, on triera plus tard</li>';
    return;
  }
  list.innerHTML = items.map(item => `
    <li class="inbox-item" data-id="${item.id}">
      <span class="inbox-text">${esc(item.text)}</span>
      <span class="inbox-date">${shortDate(item.date)}</span>
      <button class="promote-btn" onclick="promoteInbox('${item.id}')" title="→ Tâche du jour">→</button>
      <button class="del-btn" onclick="deleteInbox('${item.id}')">×</button>
    </li>`).join('');
}

function addInbox() {
  const inp = document.getElementById('inbox-input');
  const text = inp.value.trim();
  if (!text) return;
  state.inbox = state.inbox || [];
  state.inbox.push({ id: uid(), text, date: todayStr() });
  save(); renderInbox(); inp.value = ''; inp.focus();
}

window.deleteInbox = function(id) {
  state.inbox = (state.inbox || []).filter(x => x.id !== id);
  save(); renderInbox();
};

window.promoteInbox = function(id) {
  const item = (state.inbox || []).find(x => x.id === id);
  if (!item) return;
  state.tasks.push({ id: uid(), text: item.text, done: false, date: todayStr() });
  state.inbox = state.inbox.filter(x => x.id !== id);
  save(); renderInbox(); renderTasks(); renderHero();
};

function initInbox() {
  const add = document.getElementById('btn-add-inbox');
  if (add) add.onclick = addInbox;
  const inp = document.getElementById('inbox-input');
  if (inp) inp.onkeydown = e => { if (e.key === 'Enter') addInbox(); };
}

// ═══════════════════════════════════════════════════════════════════════════
// WATER
// ═══════════════════════════════════════════════════════════════════════════

const WATER_GOAL = 8;

function renderWater() {
  const t = todayStr();
  const count = ((state.water || {})[t]) || 0;
  const lbl = document.getElementById('water-lbl');
  if (lbl) lbl.textContent = `${count} / ${WATER_GOAL}`;

  const wrap = document.getElementById('water-glasses');
  if (!wrap) return;
  wrap.innerHTML = Array.from({ length: WATER_GOAL }, (_, i) =>
    `<button class="glass${i < count ? ' filled' : ''}" onclick="toggleWater(${i})">${i < count ? '💧' : ''}</button>`
  ).join('');
}

window.toggleWater = function(index) {
  const t = todayStr();
  state.water = state.water || {};
  const current = state.water[t] || 0;
  // Si on clique sur un verre rempli → on enlève à partir de là
  // Si on clique sur un verre vide → on remplit jusqu'à cet index inclus
  state.water[t] = index < current ? index : index + 1;
  save(); renderWater(); renderHero();
};

// ═══════════════════════════════════════════════════════════════════════════
// ENERGY
// ═══════════════════════════════════════════════════════════════════════════

function renderEnergy() {
  const t = todayStr();
  const today = (state.energy || []).filter(e => e.date === t);
  const last  = today[today.length - 1];

  const lbl = document.getElementById('energy-lbl');
  if (lbl) lbl.textContent = last
    ? `Maintenant ${last.value}/5`
    : (today.length ? '' : 'Note ton niveau');

  const row = document.getElementById('energy-buttons');
  if (row) {
    row.innerHTML = [1,2,3,4,5].map(v =>
      `<button class="energy-btn${last && last.value === v ? ' sel' : ''}" onclick="setEnergy(${v})">${v}</button>`
    ).join('');
  }

  const hist = document.getElementById('energy-history');
  if (hist) {
    hist.innerHTML = today.map(e =>
      `<div class="energy-bar" style="height:${(e.value/5)*100}%;opacity:${0.3 + (e.value/5)*0.7}" title="${e.time} — ${e.value}/5"></div>`
    ).join('') || '<div class="energy-bar"></div>'.repeat(4);
  }
}

window.setEnergy = function(value) {
  state.energy = state.energy || [];
  const now = new Date();
  const time = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  state.energy.push({ id: uid(), date: todayStr(), time, value });
  save(); renderEnergy();
};

function renderEnergyWeek() {
  const wrap = document.getElementById('energy-week');
  if (!wrap) return;
  const days = last7Days();
  wrap.innerHTML = days.map(d => {
    const dayE = (state.energy || []).filter(e => e.date === d);
    const avg = dayE.length
      ? (dayE.reduce((s,e) => s + e.value, 0) / dayE.length).toFixed(1)
      : '—';
    return `<div class="energy-day">
      <div class="energy-day-avg">${avg}</div>
      <div>${dayInitial(d)}</div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTINES (matin / soir)
// ═══════════════════════════════════════════════════════════════════════════

function renderRoutines() {
  if (!state.routines) return;
  const t = todayStr();
  const today = (state.routines.completions || {})[t] || {};

  function fill(listId, items, pillId) {
    const list = document.getElementById(listId);
    if (!list) return;
    list.innerHTML = items.map(item => `
      <li class="routine-item${today[item.id] ? ' done' : ''}" onclick="toggleRoutine('${item.id}')">
        <span class="routine-check">${today[item.id] ? '✓' : ''}</span>
        <span class="routine-text">${esc(item.text)}</span>
      </li>`).join('');
    const done = items.filter(i => today[i.id]).length;
    const pill = document.getElementById(pillId);
    if (pill) pill.textContent = `${done}/${items.length}`;
  }

  fill('routine-am', state.routines.morning, 'routine-am-pill');
  fill('routine-pm', state.routines.evening, 'routine-pm-pill');
}

window.toggleRoutine = function(itemId) {
  const t = todayStr();
  state.routines = state.routines || { morning: [], evening: [], completions: {} };
  state.routines.completions = state.routines.completions || {};
  state.routines.completions[t] = state.routines.completions[t] || {};
  state.routines.completions[t][itemId] = !state.routines.completions[t][itemId];
  if (!state.routines.completions[t][itemId]) delete state.routines.completions[t][itemId];
  save(); renderRoutines();
};

// ═══════════════════════════════════════════════════════════════════════════
// HABITS
// ═══════════════════════════════════════════════════════════════════════════

const PALETTE = ['#5E5CE6','#30D158','#FF9F0A','#5AC8FA','#FF453A','#BF5AF2','#FF2D55','#64D2FF','#FFB340','#06B6D4'];
let pickedColor = PALETTE[0];

function streak(h) {
  let n = 0; const d = new Date();
  if (!h.completions.includes(todayStr())) d.setDate(d.getDate() - 1);
  for (let i = 0; i < 365; i++) {
    const iso = d.toISOString().slice(0, 10);
    if (h.completions.includes(iso)) { n++; d.setDate(d.getDate() - 1); } else break;
  }
  return n;
}

function renderHabitsToday() {
  const wrap = document.getElementById('habits-today');
  if (!wrap) return;
  const t = todayStr();
  if (!state.habits.length) {
    wrap.innerHTML = '<div class="empty-state">Aucune habitude</div>';
    return;
  }
  wrap.innerHTML = state.habits.map(h => {
    const done = h.completions.includes(t);
    const s    = streak(h);
    return `<div class="habit-row">
      <div class="habit-dot" style="background:${h.color}"></div>
      <span class="habit-name">${esc(h.name)}</span>
      ${s > 1 ? `<span class="habit-streak">🔥 ${s}j</span>` : ''}
      <button class="habit-check${done ? ' done' : ''}"
              style="border-color:${h.color};${done ? `background:${h.color}` : ''}"
              onclick="toggleHabit('${h.id}')">${done ? '✓' : ''}</button>
    </div>`;
  }).join('');
}

function renderHabitsFull() {
  const wrap = document.getElementById('habits-list-full');
  if (!wrap) return;
  const t = todayStr();
  if (!state.habits.length) {
    wrap.innerHTML = '<div class="empty-state">Aucune habitude</div>';
    return;
  }
  wrap.innerHTML = state.habits.map(h => {
    const done = h.completions.includes(t);
    const s    = streak(h);
    const total = h.completions.length;
    return `<div class="habit-row">
      <div class="habit-dot" style="background:${h.color}"></div>
      <span class="habit-name">${esc(h.name)}</span>
      <span class="habit-streak">${total} jours • 🔥 ${s}</span>
      <button class="habit-check${done ? ' done' : ''}"
              style="border-color:${h.color};${done ? `background:${h.color}` : ''}"
              onclick="toggleHabit('${h.id}')">${done ? '✓' : ''}</button>
      <button class="del-btn" onclick="deleteHabit('${h.id}')">×</button>
    </div>`;
  }).join('');
}

function renderHabitsMonth() {
  const wrap = document.getElementById('habits-month');
  if (!wrap) return;
  if (!state.habits.length) { wrap.innerHTML = '<div class="empty-state">Aucune habitude</div>'; return; }
  const days = lastNDays(30), t = todayStr();
  wrap.innerHTML = state.habits.map(h => {
    const cells = days.map(d => {
      const done = h.completions.includes(d);
      const isT  = d === t;
      return `<div class="month-day${isT ? ' today' : ''}"
                   style="${done ? `background:${h.color}` : ''}"
                   title="${shortDate(d)}"></div>`;
    }).join('');
    return `<div class="month-row" style="color:${h.color}">
      <div class="month-row-name" title="${esc(h.name)}">${esc(h.name)}</div>
      <div class="month-row-days">${cells}</div>
    </div>`;
  }).join('');
}

window.toggleHabit = function(id) {
  const h = state.habits.find(x => x.id === id);
  if (!h) return;
  const t = todayStr(), i = h.completions.indexOf(t);
  if (i >= 0) h.completions.splice(i, 1); else h.completions.push(t);
  save(); renderHabitsToday(); renderHabitsFull(); renderHabitsMonth(); renderHero();
};

window.deleteHabit = function(id) {
  if (!confirm('Supprimer cette habitude et tout son historique ?')) return;
  state.habits = state.habits.filter(x => x.id !== id);
  save(); renderHabitsToday(); renderHabitsFull(); renderHabitsMonth(); renderHero();
};

function openHabitModal() {
  document.getElementById('habit-name').value = '';
  pickedColor = PALETTE[0];
  document.getElementById('color-picker').innerHTML = PALETTE.map(c =>
    `<div class="swatch${c === pickedColor ? ' sel' : ''}" data-color="${c}" style="background:${c}" onclick="pickColor('${c}',this)"></div>`
  ).join('');
  document.getElementById('habit-modal').hidden = false;
  document.getElementById('habit-name').focus();
}

window.pickColor = function(c, el) {
  pickedColor = c;
  document.querySelectorAll('.swatch').forEach(s => s.classList.remove('sel'));
  el.classList.add('sel');
};

function saveHabit() {
  const name = document.getElementById('habit-name').value.trim();
  if (!name) return;
  state.habits.push({ id: uid(), name, color: pickedColor, completions: [] });
  save(); renderHabitsToday(); renderHabitsFull(); renderHabitsMonth(); renderHero();
  closeHabitModal();
}

function closeHabitModal() { document.getElementById('habit-modal').hidden = true; }

function initHabits() {
  const addBtn    = document.getElementById('btn-add-habit');
  const add2Btn   = document.getElementById('btn-add-habit2');
  const saveBtn   = document.getElementById('btn-save-habit');
  const cancelBtn = document.getElementById('btn-cancel-habit');
  const nameInput = document.getElementById('habit-name');
  const modal     = document.getElementById('habit-modal');

  if (addBtn)    addBtn.onclick    = openHabitModal;
  if (add2Btn)   add2Btn.onclick   = openHabitModal;
  if (saveBtn)   saveBtn.onclick   = saveHabit;
  if (cancelBtn) cancelBtn.onclick = closeHabitModal;

  if (nameInput) nameInput.onkeydown = e => {
    if (e.key === 'Enter')  { e.preventDefault(); saveHabit(); }
    if (e.key === 'Escape') { e.preventDefault(); closeHabitModal(); }
  };

  if (modal) modal.onclick = e => {
    if (e.target === modal) closeHabitModal();
  };

  // ESC global pour fermer la modal (même si l'input n'a pas le focus)
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal && !modal.hidden) {
      e.preventDefault();
      closeHabitModal();
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// MOOD
// ═══════════════════════════════════════════════════════════════════════════

const MOOD_EMOJIS = ['😞','😕','😐','🙂','😄'];
const MOOD_COLORS = ['#FF453A','#FF9F0A','#FFD60A','#34C759','#30D158'];
const MOOD_LABELS = ['Très mauvaise','Mauvaise','Neutre','Bonne','Excellente'];

function renderMood() {
  const t     = todayStr();
  const today = (state.moods || []).find(m => m.date === t);

  const emojis = document.getElementById('mood-emojis');
  if (emojis) {
    emojis.innerHTML = MOOD_EMOJIS.map((e, i) => `
      <button class="mood-btn${today && today.value === i + 1 ? ' sel' : ''}"
              onclick="setMood(${i + 1})" title="${MOOD_LABELS[i]}"
              style="${today && today.value === i + 1 ? `border-color:${MOOD_COLORS[i]};background:${MOOD_COLORS[i]}22` : ''}"
              >${e}</button>`).join('');
  }

  const chart = document.getElementById('mood-chart');
  if (chart) {
    const days = lastNDays(30);
    chart.innerHTML = days.map(d => {
      const m = (state.moods || []).find(x => x.date === d);
      const bg = m ? MOOD_COLORS[m.value - 1] : '';
      return `<div class="mood-dot-h" style="${bg ? `background:${bg}` : ''}" title="${shortDate(d)}${m ? ' — ' + MOOD_LABELS[m.value-1] : ''}"></div>`;
    }).join('');
  }
}

window.setMood = function(value) {
  const t  = todayStr();
  state.moods = state.moods || [];
  const idx = state.moods.findIndex(m => m.date === t);
  if (idx >= 0) state.moods[idx].value = value;
  else state.moods.push({ date: t, value });
  save(); renderMood();
};

// ═══════════════════════════════════════════════════════════════════════════
// POMODORO
// ═══════════════════════════════════════════════════════════════════════════

const POM_DURATIONS = { focus: 25 * 60, break: 5 * 60, longbreak: 15 * 60 };
const POM_CIRC = 2 * Math.PI * 46;

const pom = { phase: 'focus', running: false, startedAt: null, elapsed: 0 };

function pomGetRemaining() {
  const total = POM_DURATIONS[pom.phase] * 1000;
  const spent = pom.elapsed + (pom.running ? Date.now() - pom.startedAt : 0);
  return Math.max(0, total - spent);
}

function pomFormat(ms) {
  const s = Math.ceil(ms / 1000);
  const min = Math.floor(s / 60).toString().padStart(2, '0');
  const sec = (s % 60).toString().padStart(2, '0');
  return `${min}:${sec}`;
}

function renderPomodoro() {
  const rem  = pomGetRemaining();
  const tot  = POM_DURATIONS[pom.phase] * 1000;
  const pct  = rem / tot;
  const time = document.getElementById('pom-time');
  if (time) time.textContent = pomFormat(rem);
  const arc = document.getElementById('pom-arc');
  if (arc) arc.style.strokeDashoffset = POM_CIRC * (1 - pct);
  const badge = document.getElementById('pom-badge');
  if (badge) badge.textContent = { focus: 'Focus', break: 'Pause', longbreak: 'Grande pause' }[pom.phase];
  const btn = document.getElementById('pom-toggle');
  if (btn) btn.textContent = pom.running ? '⏸' : '▶';

  const stored = JSON.parse(localStorage.getItem('pom_sessions') || '{}');
  const count  = stored[todayStr()] || 0;
  const dots   = document.getElementById('pom-dots');
  if (dots) {
    dots.innerHTML = Array.from({ length: Math.max(4, count + 1) }, (_, i) =>
      `<div class="pom-dot${i < count ? ' done' : ''}"></div>`
    ).join('');
  }
}

function pomTick() {
  if (!pom.running) return;
  renderPomodoro();
  if (pomGetRemaining() <= 0) pomComplete();
}

function pomComplete() {
  pomBeep();
  if (pom.phase === 'focus') {
    const stored = JSON.parse(localStorage.getItem('pom_sessions') || '{}');
    const t = todayStr();
    stored[t] = (stored[t] || 0) + 1;
    localStorage.setItem('pom_sessions', JSON.stringify(stored));
    state.pomodoro = state.pomodoro || { sessions: [] };
    const si = state.pomodoro.sessions.findIndex(s => s.date === t);
    if (si >= 0) state.pomodoro.sessions[si].count = stored[t];
    else state.pomodoro.sessions.push({ date: t, count: stored[t] });
    save(); renderHero();
    pom.phase = stored[t] % 4 === 0 ? 'longbreak' : 'break';
  } else {
    pom.phase = 'focus';
  }
  pom.running = false; pom.elapsed = 0; pom.startedAt = null;
  renderPomodoro();
}

function pomBeep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = pom.phase === 'focus' ? 660 : 440;
    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.2);
    osc.start(); osc.stop(ctx.currentTime + 1.2);
  } catch {}
}

function initPomodoro() {
  document.getElementById('pom-toggle').onclick = () => {
    if (pom.running) {
      pom.elapsed += Date.now() - pom.startedAt; pom.running = false;
    } else {
      pom.startedAt = Date.now(); pom.running = true;
    }
    renderPomodoro();
  };
  document.getElementById('pom-reset').onclick = () => {
    pom.running = false; pom.elapsed = 0; pom.startedAt = null; renderPomodoro();
  };
  document.getElementById('pom-skip').onclick = () => {
    pom.running = false; pom.elapsed = 0; pom.startedAt = null;
    pom.phase = pom.phase === 'focus' ? 'break' : 'focus';
    renderPomodoro();
  };
  setInterval(pomTick, 250);
}

// ═══════════════════════════════════════════════════════════════════════════
// FINANCE
// ═══════════════════════════════════════════════════════════════════════════

function renderFinance() {
  const bal = document.getElementById('balance-val');
  if (bal && document.activeElement !== bal) bal.value = state.finance.balance;

  const list = document.getElementById('tx-list');
  if (list) {
    const txs = [...state.finance.transactions].reverse().slice(0, 30);
    if (!txs.length) list.innerHTML = '<li class="empty-state">Aucune transaction</li>';
    else list.innerHTML = txs.map(tx => `
      <li class="tx-item">
        <span class="tx-date">${shortDate(tx.date)}</span>
        <span class="tx-desc-cell" title="${esc(tx.desc)}">${esc(tx.desc)}</span>
        <span class="tx-amount ${tx.type}">${tx.type === 'income' ? '+' : '−'}${fmtAmount(tx.amount)} €</span>
        <button class="del-btn" onclick="deleteTx('${tx.id}')">×</button>
      </li>`).join('');
  }

  const stats = document.getElementById('finance-stats');
  if (stats) {
    const m = todayStr().slice(0, 7);
    const mt = state.finance.transactions.filter(t => t.date.startsWith(m));
    const exp = mt.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
    const inc = mt.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
    stats.innerHTML = `
      <div class="stat-block"><div class="stat-lbl">Revenus mois</div><div class="stat-val" style="color:var(--green)">+${fmtAmount(inc)} €</div></div>
      <div class="stat-block"><div class="stat-lbl">Dépenses mois</div><div class="stat-val" style="color:var(--red)">−${fmtAmount(exp)} €</div></div>`;
  }
}

function addTx(type) {
  const desc = document.getElementById('tx-desc').value.trim();
  const raw  = parseFloat(document.getElementById('tx-amt').value);
  if (!desc || isNaN(raw) || raw <= 0) return;
  const amount = Math.round(raw * 100) / 100;
  state.finance.transactions.push({ id: uid(), desc, amount, type, date: todayStr() });
  state.finance.balance = Math.round((state.finance.balance + (type === 'expense' ? -amount : amount)) * 100) / 100;
  save(); renderFinance(); renderSpendingChart(); renderBudget();
  document.getElementById('tx-desc').value = '';
  document.getElementById('tx-amt').value  = '';
  document.getElementById('tx-desc').focus();
}

window.deleteTx = function(id) {
  const tx = state.finance.transactions.find(x => x.id === id);
  if (!tx) return;
  state.finance.balance = Math.round((state.finance.balance + (tx.type === 'expense' ? tx.amount : -tx.amount)) * 100) / 100;
  state.finance.transactions = state.finance.transactions.filter(x => x.id !== id);
  save(); renderFinance(); renderSpendingChart(); renderBudget();
};

function initFinance() {
  const exp = document.getElementById('btn-expense'); if (exp) exp.onclick = () => addTx('expense');
  const inc = document.getElementById('btn-income');  if (inc) inc.onclick = () => addTx('income');
  const amt = document.getElementById('tx-amt'); if (amt) amt.onkeydown = e => { if (e.key === 'Enter') addTx('expense'); };
  const bal = document.getElementById('balance-val');
  if (bal) bal.onchange = e => {
    const v = parseFloat(e.target.value);
    if (!isNaN(v)) { state.finance.balance = Math.round(v * 100) / 100; save(); }
  };
}

function renderSpendingChart() {
  const chart = document.getElementById('spending-chart');
  if (!chart) return;
  const days = last7Days();
  const totals = days.map(d =>
    state.finance.transactions.filter(tx => tx.date === d && tx.type === 'expense')
      .reduce((s, tx) => s + tx.amount, 0)
  );
  const maxV = Math.max(...totals, 1);
  if (totals.every(v => v === 0)) { chart.innerHTML = '<div class="chart-empty">Aucune dépense cette semaine</div>'; return; }
  chart.innerHTML = days.map((d, i) => {
    const v = totals[i];
    const pct = Math.round((v / maxV) * 100);
    const isT = d === todayStr();
    return `<div class="bar-col${isT ? ' bar-today' : ''}">
      <span class="bar-val">${v ? '€' + fmtShort(v) : ''}</span>
      <div class="bar-fill" style="height:${pct}%"></div>
      <span class="bar-lbl">${dayInitial(d)}</span>
    </div>`;
  }).join('');
}

function renderBudget() {
  const el = document.getElementById('budget-content');
  if (!el) return;
  if (!state.budget) state.budget = { monthly: 0 };
  const limit = state.budget.monthly;
  const month = todayStr().slice(0, 7);
  const spent = state.finance.transactions
    .filter(t => t.date.startsWith(month) && t.type === 'expense')
    .reduce((s, t) => s + t.amount, 0);
  const pct  = limit > 0 ? Math.min((spent / limit) * 100, 100) : 0;
  const col  = pct < 70 ? 'var(--green)' : pct < 90 ? 'var(--amber)' : 'var(--red)';
  const left = limit > 0 ? Math.max(0, limit - spent) : 0;

  el.innerHTML = `
    <div class="budget-amount-row">
      <div class="budget-input-wrap">
        <span class="budget-cur">€</span>
        <input id="budget-limit" type="number" min="0" step="10"
               value="${limit || ''}" placeholder="Budget…" inputmode="decimal">
      </div>
      <span class="muted">/ mois</span>
    </div>
    ${limit > 0 ? `
    <div class="budget-bar-wrap">
      <div class="budget-bar-fill" style="width:${pct}%;background:${col}"></div>
    </div>
    <div class="budget-labels">
      <span>Dépensé : <strong>${fmtAmount(spent)} €</strong></span>
      <span>Restant : <strong style="color:${col}">${fmtAmount(left)} €</strong></span>
    </div>` : '<div class="empty-state">Saisir un budget mensuel</div>'}
  `;

  const inp = document.getElementById('budget-limit');
  if (inp) inp.onchange = e => {
    const v = parseFloat(e.target.value);
    state.budget.monthly = isNaN(v) || v < 0 ? 0 : Math.round(v * 100) / 100;
    save(); renderBudget();
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SLEEP / WEIGHT
// ═══════════════════════════════════════════════════════════════════════════

function calcSleepDuration(bed, wake) {
  const [bh, bm] = bed.split(':').map(Number);
  const [wh, wm] = wake.split(':').map(Number);
  let mins = (wh * 60 + wm) - (bh * 60 + bm);
  if (mins < 0) mins += 24 * 60;
  return Math.round(mins / 6) / 10;
}

function renderSleep() {
  const t = todayStr();
  const rec = (state.sleep || []).find(s => s.date === t);
  const bedEl  = document.getElementById('sleep-bed');
  const wakeEl = document.getElementById('sleep-wake');
  const durLbl = document.getElementById('sleep-dur-lbl');
  if (rec) {
    if (bedEl && document.activeElement !== bedEl)   bedEl.value  = rec.bedtime;
    if (wakeEl && document.activeElement !== wakeEl) wakeEl.value = rec.wakeup;
    if (durLbl) durLbl.textContent = `${rec.duration}h`;
  } else if (durLbl) durLbl.textContent = '';

  const chart = document.getElementById('sleep-chart');
  if (!chart) return;
  const days = last7Days();
  const vals = days.map(d => (state.sleep || []).find(s => s.date === d)?.duration || 0);
  const maxV = Math.max(...vals, 8);
  if (vals.every(v => v === 0)) { chart.innerHTML = '<div class="chart-empty">Aucune donnée</div>'; return; }
  chart.innerHTML = days.map((d, i) => {
    const v = vals[i];
    const pct = v ? Math.round((v / maxV) * 100) : 0;
    const col = v < 6 ? 'var(--red)' : v < 7 ? 'var(--amber)' : v <= 8.5 ? 'var(--green)' : 'var(--accent)';
    const isT = d === todayStr();
    return `<div class="bar-col${isT ? ' bar-today' : ''}">
      <span class="bar-val">${v ? v + 'h' : ''}</span>
      <div class="bar-fill" style="height:${pct}%;background:${col}"></div>
      <span class="bar-lbl">${dayInitial(d)}</span>
    </div>`;
  }).join('');
}

function saveSleep() {
  const bed  = document.getElementById('sleep-bed').value;
  const wake = document.getElementById('sleep-wake').value;
  if (!bed || !wake) return;
  const dur = calcSleepDuration(bed, wake);
  const t   = todayStr();
  state.sleep = state.sleep || [];
  const idx = state.sleep.findIndex(s => s.date === t);
  const rec = { date: t, bedtime: bed, wakeup: wake, duration: dur };
  if (idx >= 0) state.sleep[idx] = rec; else state.sleep.push(rec);
  save(); renderSleep();
}

function initSleep() {
  const btn = document.getElementById('btn-save-sleep'); if (btn) btn.onclick = saveSleep;
  ['sleep-bed','sleep-wake'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.onkeydown = e => { if (e.key === 'Enter') saveSleep(); };
  });
}

function renderWeight() {
  const t = todayStr();
  const rec = (state.weight || []).find(w => w.date === t);
  const inp = document.getElementById('weight-val');
  const lbl = document.getElementById('weight-lbl');
  if (rec && inp && document.activeElement !== inp) inp.value = rec.value;
  if (lbl) lbl.textContent = rec ? `${rec.value} kg` : '';

  const last = [...(state.weight || [])].sort((a,b) => a.date.localeCompare(b.date)).slice(-30);
  const svg  = document.getElementById('weight-chart');
  const axis = document.getElementById('weight-axis');
  if (!svg) return;
  if (last.length < 2) {
    svg.innerHTML = `<text x="100" y="30" text-anchor="middle" font-size="11" fill="#98989F">Pas encore de données</text>`;
    if (axis) axis.innerHTML = ''; return;
  }
  const W = 200, H = 50;
  const vals = last.map(w => w.value);
  const minV = Math.min(...vals), maxV = Math.max(...vals);
  const range = maxV - minV || 1;
  const pts = last.map((w, i) => {
    const x = (i / (last.length - 1)) * W;
    const y = H - ((w.value - minV) / range) * (H - 8) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const latest = last[last.length - 1];
  const lx = W, ly = H - ((latest.value - minV) / range) * (H - 8) - 2;
  svg.innerHTML = `
    <defs><linearGradient id="wg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#FF2D55" stop-opacity=".15"/>
      <stop offset="100%" stop-color="#FF2D55" stop-opacity="0"/>
    </linearGradient></defs>
    <polyline points="${pts} ${W},${H} 0,${H}" fill="url(#wg)" stroke="none"/>
    <polyline points="${pts}" fill="none" stroke="#FF2D55" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3.5" fill="#FF2D55"/>`;
  if (axis) axis.innerHTML = `<span>${minV} kg</span><span>${maxV} kg</span>`;
}

function saveWeight() {
  const v = parseFloat(document.getElementById('weight-val').value);
  if (isNaN(v) || v <= 0) return;
  state.weight = state.weight || [];
  const t = todayStr();
  const idx = state.weight.findIndex(w => w.date === t);
  const rec = { date: t, value: Math.round(v * 10) / 10 };
  if (idx >= 0) state.weight[idx] = rec; else state.weight.push(rec);
  save(); renderWeight();
}

function initWeight() {
  const btn = document.getElementById('btn-save-weight'); if (btn) btn.onclick = saveWeight;
  const inp = document.getElementById('weight-val'); if (inp) inp.onkeydown = e => { if (e.key === 'Enter') saveWeight(); };
}

// ═══════════════════════════════════════════════════════════════════════════
// JOURNAL
// ═══════════════════════════════════════════════════════════════════════════

let journalDate = todayStr();
let journalTimer = null;

function renderJournal() {
  const entry = (state.journal || []).find(j => j.date === journalDate);
  const text  = entry ? entry.text : '';
  const area  = document.getElementById('journal-text');
  const lbl   = document.getElementById('journal-date-lbl');
  const chars = document.getElementById('journal-chars');
  if (area) area.value = text;
  if (lbl)  lbl.textContent = journalDate === todayStr() ? "Aujourd'hui" : new Date(journalDate + 'T00:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  if (chars) chars.textContent = `${text.length} / 2000`;
  const next = document.getElementById('journal-next');
  if (next) next.disabled = journalDate >= todayStr();
}

function saveJournalNow() {
  const area = document.getElementById('journal-text');
  if (!area) return;
  const text = area.value;
  state.journal = state.journal || [];
  const idx = state.journal.findIndex(j => j.date === journalDate);
  if (text.trim()) {
    if (idx >= 0) state.journal[idx].text = text;
    else state.journal.push({ date: journalDate, text });
  } else if (idx >= 0) state.journal.splice(idx, 1);
  save();
}

function initJournal() {
  const area = document.getElementById('journal-text');
  if (area) {
    area.oninput = () => {
      const chars = document.getElementById('journal-chars');
      if (chars) chars.textContent = `${area.value.length} / 2000`;
      clearTimeout(journalTimer);
      journalTimer = setTimeout(saveJournalNow, 700);
    };
  }
  const prev = document.getElementById('journal-prev');
  if (prev) prev.onclick = () => {
    const d = new Date(journalDate + 'T00:00:00');
    d.setDate(d.getDate() - 1);
    journalDate = d.toISOString().slice(0, 10);
    renderJournal();
  };
  const next = document.getElementById('journal-next');
  if (next) next.onclick = () => {
    if (journalDate >= todayStr()) return;
    const d = new Date(journalDate + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    journalDate = d.toISOString().slice(0, 10);
    renderJournal();
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// WEEK CALENDAR
// ═══════════════════════════════════════════════════════════════════════════

function renderWeek() {
  const grid = document.getElementById('week-grid');
  if (!grid) return;
  const today = new Date(); today.setHours(0,0,0,0);
  const dow = today.getDay() || 7;  // lundi = 1, dimanche = 7
  // Lundi de la semaine en cours
  const monday = new Date(today); monday.setDate(today.getDate() - dow + 1);

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday); d.setDate(monday.getDate() + i);
    days.push(d);
  }

  const lblEl = document.getElementById('week-lbl');
  if (lblEl) {
    const start = days[0].toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    const end   = days[6].toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    lblEl.textContent = `${start} → ${end}`;
  }

  grid.innerHTML = days.map(d => {
    const iso = d.toISOString().slice(0, 10);
    const isToday = d.getTime() === today.getTime();
    const isPast  = d.getTime() < today.getTime();
    const isFut   = d.getTime() > today.getTime();
    const cls = isToday ? 'today' : (isPast ? 'past' : (isFut ? 'future' : ''));

    // Indicateurs d'activité ce jour-là
    const dots = [];
    if (state.tasks.some(t => t.date === iso && t.done)) dots.push('var(--accent)');
    if (state.habits.some(h => h.completions.includes(iso))) dots.push('var(--c-routine)');
    if (state.finance.transactions.some(t => t.date === iso)) dots.push('var(--c-count)');
    if ((state.water || {})[iso]) dots.push('var(--c-water)');

    return `<div class="week-day ${cls}">
      <div class="week-day-name">${d.toLocaleDateString('fr-FR', { weekday: 'narrow' })}</div>
      <div class="week-day-num">${d.getDate()}</div>
      <div class="week-day-dots">
        ${dots.slice(0,4).map(c => `<div class="week-day-dot" style="background:${c};opacity:.7"></div>`).join('')}
      </div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════════════════
// OBJECTIFS DU MOIS
// ═══════════════════════════════════════════════════════════════════════════

function renderGoals() {
  const wrap = document.getElementById('goals-list');
  if (!wrap) return;
  state.goals = state.goals || [];
  if (!state.goals.length) {
    wrap.innerHTML = '<div class="empty-state">Aucun objectif — clique sur ＋</div>';
    return;
  }
  wrap.innerHTML = state.goals.map(g => `
    <div class="goal-item" data-id="${g.id}">
      <div class="goal-row">
        <span class="goal-label">${esc(g.label)}</span>
        <span class="goal-pct">${g.progress || 0}%</span>
        <div class="goal-controls">
          <button class="goal-step" onclick="stepGoal('${g.id}', -10)" title="-10%">−</button>
          <button class="goal-step" onclick="stepGoal('${g.id}', 10)"  title="+10%">+</button>
          <button class="del-btn"   onclick="deleteGoal('${g.id}')">×</button>
        </div>
      </div>
      <div class="goal-bar-wrap">
        <div class="goal-bar-fill" style="width:${g.progress || 0}%"></div>
      </div>
    </div>`).join('');
}

window.stepGoal = function(id, delta) {
  const g = state.goals.find(x => x.id === id);
  if (!g) return;
  g.progress = Math.max(0, Math.min(100, (g.progress || 0) + delta));
  save(); renderGoals();
};

window.deleteGoal = function(id) {
  state.goals = state.goals.filter(g => g.id !== id);
  save(); renderGoals();
};

function openGoalModal() {
  const inp = document.getElementById('goal-label');
  if (inp) { inp.value = ''; inp.focus(); }
  document.getElementById('goal-modal').hidden = false;
}
function closeGoalModal() { document.getElementById('goal-modal').hidden = true; }

function saveGoal() {
  const label = document.getElementById('goal-label').value.trim();
  if (!label) return;
  state.goals = state.goals || [];
  state.goals.push({ id: uid(), label, progress: 0 });
  save(); renderGoals(); closeGoalModal();
}

function initGoals() {
  const add    = document.getElementById('btn-add-goal');
  const save_  = document.getElementById('btn-save-goal');
  const cancel = document.getElementById('btn-cancel-goal');
  const label  = document.getElementById('goal-label');
  const modal  = document.getElementById('goal-modal');
  if (add)    add.onclick    = openGoalModal;
  if (save_)  save_.onclick  = saveGoal;
  if (cancel) cancel.onclick = closeGoalModal;
  if (label)  label.onkeydown = e => {
    if (e.key === 'Enter')  { e.preventDefault(); saveGoal(); }
    if (e.key === 'Escape') { e.preventDefault(); closeGoalModal(); }
  };
  if (modal) modal.onclick = e => { if (e.target === modal) closeGoalModal(); };
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPTES À REBOURS
// ═══════════════════════════════════════════════════════════════════════════

function daysUntil(iso) {
  const t = new Date(); t.setHours(0,0,0,0);
  const d = new Date(iso + 'T00:00:00');
  return Math.round((d.getTime() - t.getTime()) / 86400000);
}

function renderCountdowns() {
  const wrap = document.getElementById('countdowns-list');
  if (!wrap) return;
  state.countdowns = state.countdowns || [];
  if (!state.countdowns.length) {
    wrap.innerHTML = '<div class="empty-state">Aucun événement — clique sur ＋</div>';
    return;
  }
  // Trier par jours croissants, futurs d'abord
  const sorted = [...state.countdowns].sort((a, b) => daysUntil(a.date) - daysUntil(b.date));
  wrap.innerHTML = sorted.map(c => {
    const d = daysUntil(c.date);
    const isPast = d < 0;
    const num = isPast ? Math.abs(d) : d;
    const unit = num === 0 ? 'Aujourd\'hui' : (isPast ? 'jours passés' : 'jours restants');
    const dateLbl = new Date(c.date + 'T00:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
    return `<div class="count-item" data-id="${c.id}">
      <div class="count-days ${isPast ? 'past' : ''}">${num === 0 ? '🎉' : num}</div>
      <div class="count-info">
        <span class="count-label">${esc(c.label)}</span>
        <span class="count-date">${dateLbl} <span class="count-unit">— ${unit}</span></span>
      </div>
      <button class="del-btn" onclick="deleteCountdown('${c.id}')">×</button>
    </div>`;
  }).join('');
}

window.deleteCountdown = function(id) {
  state.countdowns = state.countdowns.filter(c => c.id !== id);
  save(); renderCountdowns();
};

function openCountModal() {
  const lbl = document.getElementById('count-label');
  const dt  = document.getElementById('count-date');
  if (lbl) lbl.value = '';
  if (dt)  dt.value  = '';
  document.getElementById('count-modal').hidden = false;
  if (lbl) lbl.focus();
}
function closeCountModal() { document.getElementById('count-modal').hidden = true; }

function saveCountdown() {
  const label = document.getElementById('count-label').value.trim();
  const date  = document.getElementById('count-date').value;
  if (!label || !date) return;
  state.countdowns = state.countdowns || [];
  state.countdowns.push({ id: uid(), label, date });
  save(); renderCountdowns(); closeCountModal();
}

function initCountdowns() {
  const add    = document.getElementById('btn-add-countdown');
  const save_  = document.getElementById('btn-save-count');
  const cancel = document.getElementById('btn-cancel-count');
  const label  = document.getElementById('count-label');
  const date   = document.getElementById('count-date');
  const modal  = document.getElementById('count-modal');
  if (add)    add.onclick    = openCountModal;
  if (save_)  save_.onclick  = saveCountdown;
  if (cancel) cancel.onclick = closeCountModal;
  if (label)  label.onkeydown = e => {
    if (e.key === 'Enter')  { e.preventDefault(); if (date) date.focus(); else saveCountdown(); }
    if (e.key === 'Escape') { e.preventDefault(); closeCountModal(); }
  };
  if (date)   date.onkeydown = e => {
    if (e.key === 'Enter')  { e.preventDefault(); saveCountdown(); }
    if (e.key === 'Escape') { e.preventDefault(); closeCountModal(); }
  };
  if (modal) modal.onclick = e => { if (e.target === modal) closeCountModal(); };
}

// ═══════════════════════════════════════════════════════════════════════════
// RÉCOMPENSES IRL
// ═══════════════════════════════════════════════════════════════════════════

const TRACKER_LBL = {
  global_streak:  'Streak global',
  week_tasks:     'Tâches semaine',
  week_habits:    'Habitudes semaine',
  week_focus:     'Sessions focus semaine',
  morning_streak: 'Routine matin',
  evening_streak: 'Routine soir',
  water_streak:   'Streak eau 8/8'
};

function startOfWeek() {
  const d = new Date(); d.setHours(0,0,0,0);
  const dow = d.getDay() || 7;
  d.setDate(d.getDate() - (dow - 1));
  return d;
}

function isThisWeek(iso) {
  const sow = startOfWeek();
  const d = new Date(iso + 'T00:00:00');
  const diff = (d - sow) / 86400000;
  return diff >= 0 && diff < 7;
}

// Calcule le streak global : jours consécutifs (jusqu'à aujourd'hui ou hier) avec au moins 1 action
function getGlobalStreak() {
  const has = (iso) => {
    if (state.tasks.some(t => t.date === iso && t.done)) return true;
    if (state.habits.some(h => h.completions.includes(iso))) return true;
    if (state.finance.transactions.some(t => t.date === iso)) return true;
    if (((state.water||{})[iso] || 0) > 0) return true;
    if ((state.moods||[]).some(m => m.date === iso)) return true;
    if ((state.energy||[]).some(e => e.date === iso)) return true;
    if (((state.routines||{}).completions||{})[iso] && Object.keys(state.routines.completions[iso]).length) return true;
    if ((state.sleep||[]).some(s => s.date === iso)) return true;
    return false;
  };
  let n = 0;
  const d = new Date(); d.setHours(0,0,0,0);
  if (!has(d.toISOString().slice(0,10))) d.setDate(d.getDate() - 1);
  for (let i = 0; i < 365; i++) {
    const iso = d.toISOString().slice(0,10);
    if (has(iso)) { n++; d.setDate(d.getDate() - 1); } else break;
  }
  return n;
}

function getRoutineStreak(type) {
  // type = 'morning' ou 'evening'
  const items = (state.routines || {})[type] || [];
  if (!items.length) return 0;
  const completions = (state.routines || {}).completions || {};
  const allDone = (iso) => {
    const done = completions[iso] || {};
    return items.every(it => done[it.id]);
  };
  let n = 0;
  const d = new Date(); d.setHours(0,0,0,0);
  if (!allDone(d.toISOString().slice(0,10))) d.setDate(d.getDate() - 1);
  for (let i = 0; i < 365; i++) {
    const iso = d.toISOString().slice(0,10);
    if (allDone(iso)) { n++; d.setDate(d.getDate() - 1); } else break;
  }
  return n;
}

function getWaterStreak() {
  let n = 0;
  const d = new Date(); d.setHours(0,0,0,0);
  if ((((state.water||{})[d.toISOString().slice(0,10)]) || 0) < WATER_GOAL) d.setDate(d.getDate() - 1);
  for (let i = 0; i < 365; i++) {
    const iso = d.toISOString().slice(0,10);
    if (((state.water||{})[iso] || 0) >= WATER_GOAL) { n++; d.setDate(d.getDate() - 1); } else break;
  }
  return n;
}

function getRewardProgress(reward) {
  switch (reward.tracker) {
    case 'global_streak':
      return getGlobalStreak();
    case 'week_tasks':
      return state.tasks.filter(t => t.done && isThisWeek(t.date)).length;
    case 'week_habits': {
      // Toutes les habitudes cochées cette semaine, comptées (toutes habitudes confondues)
      let n = 0;
      for (const h of state.habits) {
        for (const c of (h.completions || [])) if (isThisWeek(c)) n++;
      }
      return n;
    }
    case 'week_focus': {
      const stored = JSON.parse(localStorage.getItem('pom_sessions') || '{}');
      let n = 0;
      for (const iso in stored) if (isThisWeek(iso)) n += stored[iso];
      return n;
    }
    case 'morning_streak': return getRoutineStreak('morning');
    case 'evening_streak': return getRoutineStreak('evening');
    case 'water_streak':   return getWaterStreak();
    default: return 0;
  }
}

function renderRewards() {
  const wrap = document.getElementById('rewards-list');
  if (!wrap) return;
  state.rewards = state.rewards || [];
  if (!state.rewards.length) {
    wrap.innerHTML = '<div class="empty-state">Aucune récompense — clique sur ＋</div>';
    return;
  }

  wrap.innerHTML = state.rewards.map(r => {
    const progress = getRewardProgress(r);
    const pct = Math.min(100, Math.round((progress / r.target) * 100));
    const ready = progress >= r.target;
    const trackerLbl = TRACKER_LBL[r.tracker] || r.tracker;
    return `<div class="reward-card${ready ? ' ready' : ''}" data-id="${r.id}">
      <button class="reward-del" onclick="deleteReward('${r.id}')" title="Supprimer">×</button>
      ${r.claimed > 0 ? `<span class="reward-claimed-count">×${r.claimed}</span>` : ''}
      <div class="reward-emoji">${r.emoji}</div>
      <div class="reward-label">${esc(r.label)}</div>
      <div class="reward-tracker-lbl">${trackerLbl}</div>
      <div class="reward-progress-num">${progress}/${r.target}</div>
      <div class="reward-progress-bar">
        <div class="reward-progress-fill" style="width:${pct}%"></div>
      </div>
      ${ready
        ? `<button class="reward-claim-btn" onclick="claimReward('${r.id}')">🎉 Je la prends</button>`
        : ''}
    </div>`;
  }).join('');
}

window.claimReward = function(id) {
  const r = state.rewards.find(x => x.id === id);
  if (!r) return;
  // Animation de célébration
  const card = document.querySelector(`.reward-card[data-id="${id}"]`);
  if (card) {
    card.classList.add('just-claimed');
    setTimeout(() => card.classList.remove('just-claimed'), 700);
  }
  r.claimed = (r.claimed || 0) + 1;
  r.history = r.history || [];
  r.history.push(todayStr());
  // Reset le tracker : pour les streaks, on inscrit la date de claim pour décaler le compteur.
  // Le tracker repart à zéro automatiquement parce que le streak se calcule à partir d'aujourd'hui.
  // Pour les compteurs hebdo (week_tasks, week_focus...), ils repartent à 0 lundi prochain.
  save();
  setTimeout(renderRewards, 50);  // re-render après animation
};

window.deleteReward = function(id) {
  state.rewards = state.rewards.filter(r => r.id !== id);
  save(); renderRewards();
};

// Modal
let pickedEmoji = '🍕';

function openRewardModal() {
  pickedEmoji = '🍕';
  document.getElementById('reward-label').value = '';
  document.getElementById('reward-target').value = 7;
  document.getElementById('reward-tracker').value = 'global_streak';
  document.querySelectorAll('.emoji-pick').forEach(b => {
    b.classList.toggle('sel', b.dataset.emoji === pickedEmoji);
  });
  document.getElementById('reward-modal').hidden = false;
  document.getElementById('reward-label').focus();
}

function closeRewardModal() {
  document.getElementById('reward-modal').hidden = true;
}

function saveReward() {
  const label   = document.getElementById('reward-label').value.trim();
  const tracker = document.getElementById('reward-tracker').value;
  const target  = parseInt(document.getElementById('reward-target').value, 10);
  if (!label || !target || target < 1) return;
  state.rewards = state.rewards || [];
  state.rewards.push({
    id: uid(),
    emoji: pickedEmoji,
    label, target, tracker,
    claimed: 0,
    history: []
  });
  save(); renderRewards(); closeRewardModal();
}

function initRewards() {
  const add    = document.getElementById('btn-add-reward');
  const save_  = document.getElementById('btn-save-reward');
  const cancel = document.getElementById('btn-cancel-reward');
  const label  = document.getElementById('reward-label');
  const modal  = document.getElementById('reward-modal');

  if (add)    add.onclick    = openRewardModal;
  if (save_)  save_.onclick  = saveReward;
  if (cancel) cancel.onclick = closeRewardModal;

  // Emoji picker dans le modal
  document.querySelectorAll('.emoji-pick').forEach(btn => {
    btn.onclick = (e) => {
      pickedEmoji = btn.dataset.emoji;
      document.querySelectorAll('.emoji-pick').forEach(b => b.classList.remove('sel'));
      btn.classList.add('sel');
    };
  });

  if (label) label.onkeydown = e => {
    if (e.key === 'Enter')  { e.preventDefault(); saveReward(); }
    if (e.key === 'Escape') { e.preventDefault(); closeRewardModal(); }
  };
  if (modal) modal.onclick = e => { if (e.target === modal) closeRewardModal(); };
}

// ═══════════════════════════════════════════════════════════════════════════
// renderAll
// ═══════════════════════════════════════════════════════════════════════════

function renderAll() {
  renderHero();
  renderTasks();
  renderInbox();
  renderWater();
  renderEnergy();
  renderEnergyWeek();
  renderRoutines();
  renderHabitsToday();
  renderHabitsFull();
  renderHabitsMonth();
  renderMood();
  renderPomodoro();
  renderFinance();
  renderSpendingChart();
  renderBudget();
  renderSleep();
  renderWeight();
  renderJournal();
  renderWeek();
  renderGoals();
  renderCountdowns();
  renderRewards();
}

// ── Service Worker ────────────────────────────────────────────────────────

// Service Worker uniquement sur hôtes "publics" (PWA tel / GitHub Pages / Tailscale).
// PAS sur localhost : le Mac natif a besoin que chaque maj soit live IMMÉDIATEMENT,
// pas après refresh × 2 à cause du cache SW.
const SW_NEEDED = 'serviceWorker' in navigator
  && location.hostname !== 'localhost'
  && location.hostname !== '127.0.0.1';

if (SW_NEEDED) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
} else if ('serviceWorker' in navigator) {
  // Si on est sur localhost mais qu'un ancien SW était déjà installé, le désinscrire
  navigator.serviceWorker.getRegistrations().then(regs => {
    for (const r of regs) r.unregister();
  }).catch(() => {});
}

// ── Boot ──────────────────────────────────────────────────────────────────

let state;

document.addEventListener('DOMContentLoaded', async () => {
  state = await loadState();
  // Migration : champs manquants
  state.moods    = state.moods    || [];
  state.journal  = state.journal  || [];
  state.sleep    = state.sleep    || [];
  state.weight   = state.weight   || [];
  state.budget   = state.budget   || { monthly: 0 };
  state.pomodoro = state.pomodoro || { sessions: [] };
  state.inbox      = state.inbox      || [];
  state.water      = state.water      || {};
  state.energy     = state.energy     || [];
  state.goals      = state.goals      || [];
  state.countdowns = state.countdowns || [];
  // Si pas de rewards (premier lancement après mise à jour), seeder les defaults
  if (!state.rewards || !state.rewards.length) {
    state.rewards = defaultState().rewards;
  }
  if (!state.routines || !state.routines.morning) {
    state.routines = defaultState().routines;
  }
  state.routines.completions = state.routines.completions || {};
  state._mt = state._mt || 0;

  initRouter();
  initClock();
  initCitation();
  initTasks();
  initInbox();
  initHabits();
  initFinance();
  initPomodoro();
  initSleep();
  initWeight();
  initJournal();
  initGoals();
  initCountdowns();
  initRewards();

  // FAILSAFE : force fermer toutes les modals au boot
  ['habit-modal', 'goal-modal', 'count-modal', 'reward-modal'].forEach(id => {
    const m = document.getElementById(id);
    if (m) m.hidden = true;
  });

  setView('today');

  if (serverOnline) initSSE();
});
