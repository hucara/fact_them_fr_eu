import { supabase } from './supabase-client.js';

// ─── Label maps ───────────────────────────────────────────────────────────────
const TEMATICO_LABELS = {
  agriculture: 'Agriculture',
  defence: 'Defence',
  economy: 'Economy',
  energy: 'Energy',
  environment: 'Environment',
  equality: 'Equality',
  health: 'Health',
  housing: 'Housing',
  human_rights: 'Human Rights',
  industry_and_labour: 'Industry & Employment',
  internal_affairs: 'Internal Affairs',
  international_relations: 'Foreign Affairs',
  justice_and_corruption: 'Justice & Anti-Corruption',
  migration: 'Migration',
  other: 'Other',
  social_policy: 'Social Policy',
  transport: 'Transport',
};

const RESULTADO_LABELS = {
  CONFIRMED: 'Confirmed',
  CONFIRMED_WITH_NUANCE: 'Nuanced',
  DECONTEXTUALIZED: 'Out of context',
  FALSE: 'False',
  INACCURATE: 'Inaccurate',
  UNVERIFIABLE: 'Unverifiable',
  OVERESTIMATED: 'Overestimated',
  UNDERESTIMATED: 'Underestimated',
};

const RESULTADO_EMOJIS = {
  CONFIRMED: '✅',
  CONFIRMED_WITH_NUANCE: '⚠️',
  FALSE: '❌',
  DECONTEXTUALIZED: '🟠',
  INACCURATE: '🔸',
  UNVERIFIABLE: '❓',
  OVERESTIMATED: '🟠',
  UNDERESTIMATED: '🟠',
};

// Exact CSS colors for generated images (keyed by resultadoToClass output)
const IMG_COLORS = {
  verdadero: { color: '#52c97f', bgAlpha: 'rgba(82,201,127,.07)',   border: 'rgba(82,201,127,.4)'   },
  falso:     { color: '#e05070', bgAlpha: 'rgba(224,80,112,.08)',    border: 'rgba(224,80,112,.4)'   },
  enganoso:  { color: '#d4943a', bgAlpha: 'rgba(212,148,58,.07)',   border: 'rgba(212,148,58,.4)'   },
  parcial:   { color: '#4ab0e0', bgAlpha: 'rgba(74,176,224,.07)',   border: 'rgba(74,176,224,.4)'   },
  nv:        { color: '#3a5068', bgAlpha: 'rgba(255,255,255,.02)',  border: 'rgba(58,80,104,.35)'   },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// ─── State ────────────────────────────────────────────────────────────────────
let allClaims = [];
let claimsById = {};
let currentSessionIds = [];

// ─── Filter state ─────────────────────────────────────────────────────────────
const filterState = { resultado: [], tematico: [], politico: [] };
let sessionCalendar = null;
let msResultado = null, msTematico = null, msPolitico = null;

// ─── Búsqueda state ───────────────────────────────────────────────────────────
let allPoliticians = [];
let searchLoaded = false;
let activeSearchIndex = -1;
let searchClaimsCache = {};
let currentSearchClaims = [];

// ─── Búsqueda filter state ────────────────────────────────────────────────────
const searchFilterState = { resultado: [], tematico: [] };
let msSearchResultado = null, msSearchTematico = null;
let claimCount = 0;
let headerStatsBase = '';

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', boot);

async function boot() {
  setupTabs();
  history.replaceState({ tab: 'view-sesiones' }, '', window.location.href);
  setupHeroCTAs();
  setupFilters();
  setupFiltersToggle();
  setupSearchFilters();
  setupModal();
  setupShare();
  await Promise.all([loadSessions(), handleClaimDeepLink()]);
}

function setupFiltersToggle() {
  const btn = document.getElementById('btn-filters-toggle');
  const panel = document.getElementById('filters');
  if (!btn || !panel) return;
  btn.addEventListener('click', () => {
    const open = panel.classList.toggle('is-open');
    btn.setAttribute('aria-expanded', String(open));
  });
}

// ─── Búsqueda filters ────────────────────────────────────────────────────────
function setupSearchFilters() {
  msSearchResultado = new MultiSelect(
    document.getElementById('ms-search-resultado'), [],
    vals => { searchFilterState.resultado = vals; applySearchFilters(); }
  );
  msSearchTematico = new MultiSelect(
    document.getElementById('ms-search-tematico'), [],
    vals => { searchFilterState.tematico = vals; applySearchFilters(); }
  );
  document.getElementById('search-busqueda-claim')
    .addEventListener('input', applySearchFilters);
}

function populateSearchFilters(claims) {
  const tematicos = [...new Set(claims.map(c => c.ambito_tematico).filter(Boolean))].sort();
  const resultados = [...new Set(
    claims.flatMap(c => c.verification?.map(v => v.resultado) ?? []).filter(Boolean)
  )].sort();
  msSearchTematico.setOptions(tematicos.map(t => ({ value: t, label: TEMATICO_LABELS[t] ?? t })));
  msSearchResultado.setOptions(resultados.map(r => ({ value: r, label: RESULTADO_LABELS[r] ?? r })));
}

function applySearchFilters() {
  const search = norm(document.getElementById('search-busqueda-claim').value.trim());
  const filtered = currentSearchClaims.filter(c => {
    if (searchFilterState.tematico.length && !searchFilterState.tematico.includes(c.ambito_tematico)) return false;
    if (searchFilterState.resultado.length) {
      const claimResults = c.verification?.map(v => v.resultado) ?? [];
      if (!searchFilterState.resultado.some(r => claimResults.includes(r))) return false;
    }
    if (search) {
      const haystack = norm([c.texto_normalizado, c.texto_original].filter(Boolean).join(' '));
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
  renderSearchResults(filtered, document.getElementById('politician-search-input').value);
}

function resetSearchFilters() {
  searchFilterState.resultado = [];
  searchFilterState.tematico = [];
  document.getElementById('search-busqueda-claim').value = '';
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function activateTab(tabId, pushToHistory = true) {
  document.querySelectorAll('.tab-button').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === tabId));
  document.querySelectorAll('.view-container').forEach(v =>
    v.classList.toggle('active', v.id === tabId));
  if (tabId === 'view-estadisticas' && !window.statsLoaded) loadGlobalDashboard();
  if (tabId === 'view-busqueda' && !searchLoaded) loadPoliticians();
  if (pushToHistory) {
    history.pushState({ tab: tabId }, '', window.location.href);
  }
}

function setupTabs() {
  document.querySelectorAll('.tab-button').forEach(tab => {
    tab.addEventListener('click', () => {
      const current = document.querySelector('.tab-button.active')?.dataset.tab;
      if (tab.dataset.tab === current) return;
      activateTab(tab.dataset.tab, true);
    });
  });
  window.addEventListener('popstate', e => {
    if (e.state?.tab) activateTab(e.state.tab, false);
  });
}

// ─── Hero CTAs ────────────────────────────────────────────────────────────────
function setupHeroCTAs() {
  document.querySelectorAll('.hero-cta[data-cta]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const target = btn.dataset.cta;
      const tabBtn = document.querySelector(`.tab-button[data-tab="view-${target}"]`);
      if (tabBtn) tabBtn.click();
      document.getElementById('app-header')?.scrollIntoView({ behavior: 'smooth' });
    });
  });
}

// ─── MultiSelect component ────────────────────────────────────────────────────
class MultiSelect {
  constructor(container, options, onChange) {
    this.container = container;
    this.allOptions = options;
    this.selected = new Set();
    this.onChange = onChange;
    this.query = '';
    this.isOpen = false;
    this._outsideHandler = null;
    this._keyHandler = null;
    this.mount();
  }

  mount() {
    this.container.innerHTML = `
      <div class="ms-trigger" tabindex="0" role="combobox" aria-expanded="false" aria-haspopup="listbox">
        <div class="ms-chips"><input class="ms-input" type="text" autocomplete="off" spellcheck="false" /></div>
        <button class="ms-clear-all" type="button" hidden aria-label="Clear selection">✕</button>
        <svg class="ms-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="ms-dropdown" hidden role="listbox">
        <ul class="ms-list"></ul>
      </div>`;
    this.triggerEl  = this.container.querySelector('.ms-trigger');
    this.chipsEl    = this.container.querySelector('.ms-chips');
    this.inputEl    = this.container.querySelector('.ms-input');
    this.clearAllBtn = this.container.querySelector('.ms-clear-all');
    this.dropdownEl = this.container.querySelector('.ms-dropdown');
    this.listEl     = this.container.querySelector('.ms-list');

    this.inputEl.placeholder = '';

    this.triggerEl.addEventListener('mousedown', (e) => {
      if (e.target === this.clearAllBtn || e.target.closest('.ms-chip button')) return;
      e.preventDefault();
      this.isOpen ? this.close() : this.open();
    });
    this.inputEl.addEventListener('input', () => {
      this.query = this.inputEl.value;
      this.renderList();
    });
    this.clearAllBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.clearAll();
    });
    this.renderChips();
  }

  setOptions(options) {
    this.allOptions = options;
    this.selected.clear();
    this.query = '';
    this.inputEl.value = '';
    this.renderChips();
    if (this.isOpen) this.renderList();
  }

  renderChips() {
    this.chipsEl.querySelectorAll('.ms-chip, .ms-placeholder').forEach(el => el.remove());
    if (this.selected.size === 0) {
      const pl = document.createElement('span');
      pl.className = 'ms-placeholder';
      pl.textContent = this.container.dataset.placeholder ?? '';
      this.chipsEl.insertBefore(pl, this.inputEl);
    } else {
      this.selected.forEach(val => {
        const opt = this.allOptions.find(o => o.value === val);
        const label = opt ? opt.label : val;
        const chip = document.createElement('span');
        chip.className = 'ms-chip';
        chip.innerHTML = `${escHtml(label)} <button type="button" aria-label="Remove ${escHtml(label)}">✕</button>`;
        chip.querySelector('button').addEventListener('click', (e) => {
          e.stopPropagation();
          this.deselect(val);
        });
        this.chipsEl.insertBefore(chip, this.inputEl);
      });
    }
    this.clearAllBtn.hidden = this.selected.size === 0;
    this.triggerEl.setAttribute('aria-expanded', String(this.isOpen));
  }

  renderList() {
    const q = norm(this.query);
    const filtered = q
      ? this.allOptions.filter(o => norm(o.label).includes(q))
      : this.allOptions;
    if (!filtered.length) {
      this.listEl.innerHTML = '<li class="ms-empty">No results</li>';
      return;
    }
    this.listEl.innerHTML = filtered.map(opt => {
      const sel = this.selected.has(opt.value);
      let labelHtml = escHtml(opt.label);
      if (q) {
        const idx = norm(opt.label).indexOf(q);
        if (idx >= 0) {
          labelHtml = escHtml(opt.label.slice(0, idx))
            + '<mark>' + escHtml(opt.label.slice(idx, idx + q.length)) + '</mark>'
            + escHtml(opt.label.slice(idx + q.length));
        }
      }
      return `<li class="ms-option" role="option" aria-selected="${sel}" data-value="${escHtml(opt.value)}">
        <span class="ms-check">✓</span> ${labelHtml}</li>`;
    }).join('');
    this.listEl.querySelectorAll('.ms-option').forEach(li => {
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.toggleOption(li.dataset.value);
      });
    });
  }

  toggleOption(value) {
    this.selected.has(value) ? this.selected.delete(value) : this.selected.add(value);
    this.renderChips();
    this.renderList();
    this.onChange(Array.from(this.selected));
  }

  deselect(value) {
    this.selected.delete(value);
    this.renderChips();
    if (this.isOpen) this.renderList();
    this.onChange(Array.from(this.selected));
  }

  clearAll() {
    this.selected.clear();
    this.renderChips();
    if (this.isOpen) this.renderList();
    this.onChange([]);
  }

  open() {
    this.isOpen = true;
    this.dropdownEl.hidden = false;
    this.triggerEl.setAttribute('aria-expanded', 'true');
    this.renderList();
    this.inputEl.focus();
    this._outsideHandler = (e) => { if (!this.container.contains(e.target)) this.close(); };
    this._keyHandler = (e) => { if (e.key === 'Escape') this.close(); };
    document.addEventListener('mousedown', this._outsideHandler);
    document.addEventListener('keydown', this._keyHandler);
  }

  close() {
    this.isOpen = false;
    this.dropdownEl.hidden = true;
    this.triggerEl.setAttribute('aria-expanded', 'false');
    this.query = '';
    this.inputEl.value = '';
    document.removeEventListener('mousedown', this._outsideHandler);
    document.removeEventListener('keydown', this._keyHandler);
  }
}

// ─── SessionCalendar component ────────────────────────────────────────────────
class SessionCalendar {
  constructor(onSelect) {
    this.onSelect = onSelect;
    this.sessions = [];
    this.sessionsByDate = new Map();
    this.selectedId = null;
    this.viewYear = new Date().getFullYear();
    this.viewMonth = new Date().getMonth();
    this.isOpen = false;
    this._outsideHandler = null;
    this._keyHandler = null;

    const wrap = document.getElementById('session-calendar-wrap');
    wrap.innerHTML = `
      <button class="session-cal-trigger" id="session-cal-trigger" type="button"
              aria-haspopup="true" aria-expanded="false" aria-controls="session-cal-popup">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
          <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
        <span id="session-cal-label">Loading sessions…</span>
        <svg class="cal-trigger-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <div class="cal-popup" id="session-cal-popup" hidden role="dialog" aria-label="Seleccionar sesión">
        <div class="cal-header">
          <button class="cal-nav" id="cal-prev" type="button" aria-label="Mes anterior">‹</button>
          <span class="cal-month-label" id="cal-month-label"></span>
          <button class="cal-nav" id="cal-next" type="button" aria-label="Mes siguiente">›</button>
        </div>
        <div class="cal-weekdays">
          <span>Lu</span><span>Ma</span><span>Mi</span><span>Ju</span><span>Vi</span><span>Sá</span><span>Do</span>
        </div>
        <div class="cal-grid" id="cal-grid" role="grid"></div>
        <div class="cal-session-list" id="cal-session-list" hidden></div>
      </div>`;

    this.triggerEl    = document.getElementById('session-cal-trigger');
    this.labelEl      = document.getElementById('session-cal-label');
    this.popupEl      = document.getElementById('session-cal-popup');
    this.gridEl       = document.getElementById('cal-grid');
    this.monthLabelEl = document.getElementById('cal-month-label');
    this.sessionListEl = document.getElementById('cal-session-list');

    this.triggerEl.addEventListener('click', () => this.toggle());
    document.getElementById('cal-prev').addEventListener('click', () => this.prevMonth());
    document.getElementById('cal-next').addEventListener('click', () => this.nextMonth());
  }

  setSessions(sessions) {
    this.sessions = sessions;
    this.sessionsByDate = new Map();
    sessions.forEach(s => {
      if (!s.fecha) return;
      const key = s.fecha.slice(0, 10);
      if (!this.sessionsByDate.has(key)) this.sessionsByDate.set(key, []);
      this.sessionsByDate.get(key).push(s);
    });
  }

  // silent=true: updates visual state only, does not fire onSelect callback
  selectSession(id, silent = true) {
    const session = this.sessions.find(s => s.id === id);
    if (!session) return;
    this.selectedId = id;
    if (session.fecha) {
      const d = new Date(session.fecha + 'T00:00:00');
      this.viewYear = d.getFullYear();
      this.viewMonth = d.getMonth();
    }
    this.updateLabel(session);
    if (this.isOpen) this.render();
    if (!silent) this.onSelect([id]);
  }

  updateLabel(sessionOrSessions) {
    if (!sessionOrSessions) { this.labelEl.textContent = 'Seleccionar sesión…'; return; }
    const sessions = Array.isArray(sessionOrSessions) ? sessionOrSessions : [sessionOrSessions];
    if (!sessions.length) { this.labelEl.textContent = 'Seleccionar sesión…'; return; }
    const s = sessions[0];
    const fecha = s.fecha
      ? new Date(s.fecha + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
      : '—';
    const suffix = sessions.length > 1
      ? ` · ${sessions.length} sessions`
      : (s.organo ? ' · ' + s.organo : '');
    this.labelEl.textContent = fecha + suffix;
  }

  render() {
    const months = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];
    this.monthLabelEl.textContent = `${months[this.viewMonth]} ${this.viewYear}`;
    this.renderGrid();
  }

  renderGrid() {
    const { viewYear: y, viewMonth: m } = this;
    const firstDow = new Date(y, m, 1).getDay();
    const offset = firstDow === 0 ? 6 : firstDow - 1; // Mon-based
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

    let selDateStr = null;
    if (this.selectedId) {
      const sel = this.sessions.find(s => s.id === this.selectedId);
      if (sel?.fecha) selDateStr = sel.fecha.slice(0, 10);
    }

    const months = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];
    let html = '<span class="cal-day-empty"></span>'.repeat(offset);
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const hasSess = this.sessionsByDate.has(dateStr);
      const isSel   = dateStr === selDateStr;
      const isToday = dateStr === todayStr;
      let cls = 'cal-day';
      if (hasSess) cls += ' cal-day--has-session';
      if (isSel)   cls += ' cal-day--selected';
      if (isToday) cls += ' cal-day--today';
      html += hasSess
        ? `<button class="${cls}" type="button" data-date="${dateStr}" aria-label="${months[m]} ${d}">${d}</button>`
        : `<span class="${cls}">${d}</span>`;
    }
    this.gridEl.innerHTML = html;
    this.gridEl.querySelectorAll('.cal-day--has-session').forEach(btn => {
      btn.addEventListener('click', () => this.handleDayClick(btn.dataset.date));
    });
  }

  handleDayClick(dateStr) {
    const sessions = this.sessionsByDate.get(dateStr) ?? [];
    if (!sessions.length) return;
    const ids = sessions.map(s => s.id);
    this.selectedId = ids[0];
    this.updateLabel(sessions);
    this.renderGrid();
    this.sessionListEl.hidden = true;
    this.close();
    this.onSelect(ids);
  }

  prevMonth() {
    if (--this.viewMonth < 0) { this.viewMonth = 11; this.viewYear--; }
    this.render();
  }

  nextMonth() {
    if (++this.viewMonth > 11) { this.viewMonth = 0; this.viewYear++; }
    this.render();
  }

  toggle() { this.isOpen ? this.close() : this.open(); }

  open() {
    this.isOpen = true;
    this.popupEl.hidden = false;
    this.triggerEl.setAttribute('aria-expanded', 'true');
    this.render();
    this._outsideHandler = (e) => {
      if (!document.getElementById('session-calendar-wrap').contains(e.target)) this.close();
    };
    this._keyHandler = (e) => { if (e.key === 'Escape') this.close(); };
    document.addEventListener('mousedown', this._outsideHandler);
    document.addEventListener('keydown', this._keyHandler);
  }

  close() {
    this.isOpen = false;
    this.popupEl.hidden = true;
    this.triggerEl.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', this._outsideHandler);
    document.removeEventListener('keydown', this._keyHandler);
  }
}

// ─── Session selector + content filters ───────────────────────────────────────
function setupFilters() {
  sessionCalendar = new SessionCalendar(ids => loadSession(ids));

  msResultado = new MultiSelect(
    document.getElementById('ms-resultado'), [],
    vals => { filterState.resultado = vals; applyFilters(); }
  );
  msTematico = new MultiSelect(
    document.getElementById('ms-tematico'), [],
    vals => { filterState.tematico = vals; applyFilters(); }
  );
  msPolitico = new MultiSelect(
    document.getElementById('ms-politico'), [],
    vals => { filterState.politico = vals; applyFilters(); }
  );

  document.getElementById('search-claim').addEventListener('input', applyFilters);

  document.getElementById('btn-clear-filters')?.addEventListener('click', clearAllFilters);
}

// ─── Sessions ─────────────────────────────────────────────────────────────────
async function loadSessions() {
  const [{ data, error }, { count: headerCount }] = await Promise.all([
    supabase.from('session').select('id, legislatura, tipo, numero, fecha, organo, status').order('fecha', { ascending: false }),
    supabase.from('claim').select('id', { count: 'exact', head: true }),
  ]);

  if (error || !data?.length) {
    const lbl = document.getElementById('session-cal-label');
    if (lbl) lbl.textContent = 'No sessions available';
    return;
  }

  const sessions = data.filter(s => s.status === 'verified' && s.fecha);

  claimCount = headerCount ?? 0;

  const statsEl = document.getElementById('header-stats');
  if (statsEl) {
    headerStatsBase = `<strong>${sessions.length}</strong> sessions · <strong>${claimCount.toLocaleString('en-GB')}</strong> claims`;
    statsEl.innerHTML = headerStatsBase;
  }

  if (!sessions.length) {
    const lbl = document.getElementById('session-cal-label');
    if (lbl) lbl.textContent = 'No sessions available';
    return;
  }

  sessionCalendar.setSessions(sessions);
  // Visually select the latest session, then load it
  sessionCalendar.selectSession(sessions[0].id, /* silent */ true);
  loadSession([sessions[0].id]);
}

// ─── Claims for a session ─────────────────────────────────────────────────────
async function loadSession(sessionIds) {
  const ids = Array.isArray(sessionIds) ? sessionIds : [sessionIds];
  currentSessionIds = ids;

  const container = document.getElementById('claims-container');
  container.innerHTML = '<p class="loading">Loading claims…</p>';

  const { data, error } = await supabase
    .from('claim')
    .select(`
      id, session_id, texto_normalizado, texto_original, entidad, metrica,
      valor_afirmado, periodo_temporal, ambito_geografico, ambito_tematico,
      fuente_citada, verificabilidad, centralidad, relevancia, tipo_claim,
      politician:politician_id (nombre_completo, partido, grupo_parlamentario),
      verification (
        resultado, confidence_score, afirmacion_correcta,
        omisiones, errores, fuentes, potencial_engano,
        recomendacion_redaccion, razonamiento_llm
      )
    `)
    .in('session_id', ids)
    .order('session_id')
    .order('id');

  if (error) {
    container.innerHTML = `<p class="error">Error loading claims: ${error.message}</p>`;
    return;
  }

  allClaims = data ?? [];
  const prevById = claimsById;
  claimsById = Object.fromEntries(allClaims.map(c => [c.id, c]));
  // Preserve any pre-loaded claims not in this session (e.g. deeplink)
  for (const [id, claim] of Object.entries(prevById)) {
    if (!claimsById[id]) claimsById[id] = claim;
  }

  // Reset filter state
  filterState.resultado = [];
  filterState.tematico  = [];
  filterState.politico  = [];
  populateFilters(allClaims);
  renderClaims(allClaims);
  updateClaimsCount(allClaims.length, allClaims.length);
  updateFilterPills();
}

// ─── Filters ──────────────────────────────────────────────────────────────────
function populateFilters(claims) {
  const tematicos = [...new Set(claims.map(c => c.ambito_tematico).filter(Boolean))].sort();
  const resultados = [...new Set(
    claims.flatMap(c => c.verification?.map(v => v.resultado) ?? []).filter(Boolean)
  )].sort();
  const politicos = [...new Map(
    claims.filter(c => c.politician?.nombre_completo)
      .map(c => [c.politician.nombre_completo, c.politician])
  ).values()].sort((a, b) =>
    (a.nombre_completo ?? '').localeCompare(b.nombre_completo ?? '')
  );

  msTematico?.setOptions(tematicos.map(t => ({ value: t, label: TEMATICO_LABELS[t] ?? snakeToLabel(t) })));
  msResultado?.setOptions(resultados.map(r => ({ value: r, label: RESULTADO_LABELS[r] ?? snakeToLabel(r) })));
  msPolitico?.setOptions(politicos.map(p => ({ value: p.nombre_completo, label: p.nombre_completo })));
}

function applyFilters() {
  const search = norm(document.getElementById('search-claim').value.trim());

  const filtered = allClaims.filter(c => {
    if (filterState.tematico.length && !filterState.tematico.includes(c.ambito_tematico)) return false;
    if (filterState.politico.length && !filterState.politico.includes(c.politician?.nombre_completo)) return false;
    if (filterState.resultado.length) {
      const claimResults = c.verification?.map(v => v.resultado) ?? [];
      if (!filterState.resultado.some(r => claimResults.includes(r))) return false;
    }
    if (search) {
      const haystack = norm([c.texto_normalizado, c.texto_original].filter(Boolean).join(' '));
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  renderClaims(filtered);
  updateClaimsCount(filtered.length, allClaims.length);
  updateFilterPills();
}

function updateClaimsCount(shown, total) {
  const el = document.getElementById('claims-count');
  if (el) el.hidden = true;

  const statsEl = document.getElementById('header-stats');
  if (!statsEl || !headerStatsBase) return;
  if (!total) { statsEl.innerHTML = headerStatsBase; return; }

  const pleno = shown === total
    ? `<strong>${total.toLocaleString('es-ES')}</strong> in this session`
    : `<strong>${shown.toLocaleString('es-ES')}</strong>/<strong>${total.toLocaleString('es-ES')}</strong> in this session`;

  statsEl.innerHTML = `${headerStatsBase} · ${pleno}`;
}

function updateFilterPills() {
  const pillsEl = document.getElementById('filter-pills');
  const clearBtn = document.getElementById('btn-clear-filters');
  if (!pillsEl) return;

  const pills = [];
  filterState.resultado.forEach(v =>
    pills.push({ label: RESULTADO_LABELS[v] ?? v, remove: () => msResultado.deselect(v) }));
  filterState.tematico.forEach(v =>
    pills.push({ label: TEMATICO_LABELS[v] ?? snakeToLabel(v), remove: () => msTematico.deselect(v) }));
  filterState.politico.forEach(v =>
    pills.push({ label: v, remove: () => msPolitico.deselect(v) }));

  const searchVal = document.getElementById('search-claim').value.trim();
  if (searchVal) pills.push({
    label: `"${searchVal}"`,
    remove: () => { document.getElementById('search-claim').value = ''; applyFilters(); },
  });

  pillsEl.hidden = pills.length === 0;
  if (clearBtn) clearBtn.hidden = pills.length === 0;

  const badge = document.getElementById('filters-badge');
  if (badge) {
    badge.hidden = pills.length === 0;
    badge.textContent = pills.length || '';
  }

  pillsEl.innerHTML = pills.map((p, i) =>
    `<button class="filter-pill" data-pill="${i}">${escHtml(p.label)} <span aria-hidden="true">✕</span></button>`
  ).join('');
  pillsEl.querySelectorAll('.filter-pill').forEach((btn, i) => {
    btn.addEventListener('click', () => pills[i].remove());
  });
}

function clearAllFilters() {
  msResultado?.clearAll();
  msTematico?.clearAll();
  msPolitico?.clearAll();
  document.getElementById('search-claim').value = '';
  filterState.resultado = [];
  filterState.tematico  = [];
  filterState.politico  = [];
  applyFilters();
}

// ─── Render claims ────────────────────────────────────────────────────────────
const DAY_SESSION_LABELS = ['Morning Plenary', 'Afternoon Plenary'];
function sessionDayLabel(index) {
  return DAY_SESSION_LABELS[index] ?? `Plenary ${index + 1}`;
}

const CLAIMS_PAGE_SIZE = 30;
let lazyObserver = null;
let pendingClaims = [];   // flat ordered list yet to render
let pendingGroups = null; // for multi-session: [{dividerHtml, claims[]}]

function bindClaimToggle(container) {
  container.querySelectorAll('.claim-toggle:not(a):not([data-bound])').forEach(btn => {
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => openModal(claimsById[btn.dataset.id]));
  });
}

function appendNextBatch(container) {
  const sentinel = container.querySelector('.claims-sentinel');
  const insert = html => {
    if (sentinel) sentinel.insertAdjacentHTML('beforebegin', html);
    else container.insertAdjacentHTML('beforeend', html);
  };

  if (pendingGroups) {
    let added = 0;
    while (added < CLAIMS_PAGE_SIZE && pendingGroups.length) {
      const g = pendingGroups[0];
      if (g.dividerHtml) { insert(g.dividerHtml); g.dividerHtml = null; }
      const take = Math.min(CLAIMS_PAGE_SIZE - added, g.claims.length);
      insert(g.claims.splice(0, take).map(c => claimCard(c)).join(''));
      added += take;
      if (!g.claims.length) pendingGroups.shift();
    }
  } else {
    insert(pendingClaims.splice(0, CLAIMS_PAGE_SIZE).map(c => claimCard(c)).join(''));
  }
  bindClaimToggle(container);
  updateSentinel(container);
}

function updateSentinel(container) {
  const remaining = pendingGroups
    ? pendingGroups.reduce((n, g) => n + g.claims.length, 0)
    : pendingClaims.length;

  let sentinel = container.querySelector('.claims-sentinel');
  if (remaining === 0) {
    if (sentinel) sentinel.remove();
    if (lazyObserver) { lazyObserver.disconnect(); lazyObserver = null; }
    return;
  }
  if (!sentinel) {
    sentinel = document.createElement('div');
    sentinel.className = 'claims-sentinel';
    sentinel.style.cssText = 'height:1px;margin-top:1rem;';
    container.appendChild(sentinel);
  }
  if (!lazyObserver) {
    lazyObserver = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) appendNextBatch(container);
    }, { rootMargin: '200px' });
    lazyObserver.observe(sentinel);
  }
}

function renderClaims(claims) {
  const container = document.getElementById('claims-container');

  // Tear down previous lazy loader
  if (lazyObserver) { lazyObserver.disconnect(); lazyObserver = null; }
  pendingClaims = [];
  pendingGroups = null;

  if (!claims.length) {
    container.innerHTML = '<p class="empty">No claims match the current filters.</p>';
    return;
  }

  container.innerHTML = '';

  if (currentSessionIds.length > 1) {
    const sessionsMap = new Map((sessionCalendar?.sessions ?? []).map(s => [s.id, s]));
    const orderedIds = currentSessionIds
      .map(id => sessionsMap.get(id))
      .filter(Boolean)
      .sort((a, b) => (a.numero ?? 0) - (b.numero ?? 0))
      .map(s => s.id);

    const grouped = new Map();
    for (const c of claims) {
      if (!grouped.has(c.session_id)) grouped.set(c.session_id, []);
      grouped.get(c.session_id).push(c);
    }

    pendingGroups = orderedIds
      .filter(sid => grouped.has(sid))
      .map((sid, i) => ({
        dividerHtml: `<div class="session-divider" role="separator"><span>${escHtml(sessionDayLabel(i))}</span></div>`,
        claims: grouped.get(sid),
      }));
  } else {
    pendingClaims = [...claims];
  }

  appendNextBatch(container);
}

function claimCard(claim) {
  const v = claim.verification?.[0] ?? null;
  const pol = claim.politician;

  const resultadoClass = v ? resultadoToClass(v.resultado) : 'nv';
  const resultadoLabel = v ? formatResultado(v.resultado) : 'Unverified';
  const score = v && v.confidence_score != null ? Math.round(v.confidence_score * 100) : null;

  const tags = [
    claim.ambito_tematico ? `<span class="tag tag-tematico">${escHtml(snakeToLabel(claim.ambito_tematico))}</span>` : '',
    claim.ambito_geografico ? `<span class="tag tag-geo">${escHtml(snakeToLabel(claim.ambito_geografico))}</span>` : '',
  ].filter(Boolean).join('');

  return `
    <article class="claim-card" data-resultado="${resultadoClass}"${pol?.grupo_parlamentario === 'EU Commission' ? ' data-gobierno' : ''}>
      <header class="claim-header">
        <div class="claim-meta-top">
          ${pol
      ? `<span class="politician-name">${escHtml(formatNombre(pol.nombre_completo))}${pol.grupo_parlamentario ? `<span class="politician-partido">· ${escHtml(pol.grupo_parlamentario)}</span>` : ''}</span>`
      : '<span class="politician-name unknown">Unknown MEP</span>'}
        </div>
        <span class="resultado-badge resultado-${resultadoClass}">${resultadoLabel}</span>
      </header>

      <blockquote class="claim-text" title="${escHtml(claim.texto_original)}">
        ${escHtml(capitalize(claim.texto_normalizado))}
      </blockquote>

      ${score !== null ? `
        <div class="confidence-bar" title="Confianza del modelo: ${score}%">
          <div class="confidence-track">
            <div class="confidence-fill confidence-${resultadoClass}" style="width:${score}%"></div>
          </div>
          <span class="confidence-label">${score}% confidence</span>
        </div>` : ''}

      ${tags ? `<div class="claim-tags">${tags}</div>` : ''}

      <div class="claim-actions">
        ${v ? `<a class="claim-toggle" href="${claimPageUrl(claim)}">See more →</a>` : ''}
        <div class="share-wrapper">
          <button class="share-btn" data-claim-id="${claim.id}" aria-label="Share claim">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
            </svg>
          </button>
          <div class="share-menu" hidden>${buildShareMenu(claim)}</div>
        </div>
      </div>
    </article>`;
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function setupModal() {
  const overlay = document.getElementById('modal-overlay');
  const closeBtn = document.getElementById('modal-close');

  closeBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
}

function openModal(claim) {
  if (!claim) return;

  const v = claim.verification?.[0] ?? null;
  const pol = claim.politician;

  const resultadoClass = v ? resultadoToClass(v.resultado) : 'nv';
  const resultadoLabel = v ? formatResultado(v.resultado) : 'Unverified';
  const score = v && v.confidence_score != null ? Math.round(v.confidence_score * 100) : null;

  const tags = [
    claim.ambito_tematico ? `<span class="tag tag-tematico">${escHtml(snakeToLabel(claim.ambito_tematico))}</span>` : '',
    claim.ambito_geografico ? `<span class="tag tag-geo">${escHtml(snakeToLabel(claim.ambito_geografico))}</span>` : '',
  ].filter(Boolean).join('');

  const details = v
    ? [renderErrores(v.errores), renderOmisiones(v.omisiones), renderFuentes(v.fuentes)]
      .filter(Boolean).join('')
    : '';

  const card = document.getElementById('modal-card');
  card.dataset.resultado = resultadoClass;

  document.getElementById('modal-content').innerHTML = `
    <header class="claim-header" style="margin-bottom:1.25rem">
      <div class="claim-meta-top">
        ${pol
      ? `<span class="politician-name" style="font-size:1.05rem">${escHtml(formatNombre(pol.nombre_completo))}${pol.grupo_parlamentario === 'EU Commission' ? `<span class="politician-gobierno" title="EU Commission">🏛️</span>` : ''}${pol.grupo_parlamentario && pol.grupo_parlamentario !== 'EU Commission' ? `<span class="politician-partido">· ${escHtml(pol.grupo_parlamentario)}</span>` : ''}</span>`
      : '<span class="politician-name unknown">Unknown MEP</span>'}
      </div>
      <span class="resultado-badge resultado-${resultadoClass}">${resultadoLabel}</span>
    </header>

    <blockquote class="claim-text modal-claim-text" title="${escHtml(claim.texto_original)}">
      ${escHtml(capitalize(claim.texto_normalizado))}
    </blockquote>

    ${score !== null ? `
      <div class="confidence-bar" style="margin-bottom:1rem" title="Model confidence: ${score}%">
        <div class="confidence-track" style="width:160px">
          <div class="confidence-fill confidence-${resultadoClass}" style="width:${score}%"></div>
        </div>
        <span class="confidence-label">${score}% confidence</span>
      </div>` : ''}

    ${tags ? `<div class="claim-tags" style="margin-bottom:1.25rem">${tags}</div>` : ''}

    ${details ? `<dl class="modal-detail-list">${details}</dl>` : ''}

    <div class="modal-share">
      <div class="share-wrapper">
        <button class="share-btn share-btn--labeled" data-claim-id="${claim.id}" aria-label="Share claim">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
          </svg>
          Share
        </button>
        <div class="share-menu" hidden>${buildShareMenu(claim)}</div>
      </div>
    </div>
  `;

  const overlay = document.getElementById('modal-overlay');
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
  document.getElementById('modal-close').focus();
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  document.body.style.overflow = '';
}

// ─── Slug / claim page URL ────────────────────────────────────────────────────
function slugify(text, id) {
  let s = String(text || '').trim().toLowerCase();
  s = s.replace(/[áä]/g, 'a').replace(/[éë]/g, 'e').replace(/[íï]/g, 'i')
       .replace(/[óö]/g, 'o').replace(/[úü]/g, 'u').replace(/ñ/g, 'n').replace(/ç/g, 'c');
  s = s.replace(/[^a-z0-9\s-]/g, '');
  const words = s.trim().split(/\s+/).slice(0, 8);
  const slug = words.join('-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return slug ? `${slug}-${id}` : String(id);
}

function claimPageUrl(claim) {
  return `/claim/${slugify(claim.texto_normalizado, claim.id)}.html`;
}

// ─── Share ────────────────────────────────────────────────────────────────────
function buildShareUrl(claim) {
  return `https://facthem.eu${claimPageUrl(claim)}`;
}

function formatNombre(str) {
  const parts = String(str ?? '').split(',');
  return parts.length === 2 ? `${parts[1].trim()} ${parts[0].trim()}` : String(str ?? '');
}

function buildShareText(claim) {
  const pol = claim.politician;
  const v = claim.verification?.[0] ?? null;
  const resultadoKey = v?.resultado?.toUpperCase() ?? null;
  const resultadoLabel = v ? formatResultado(v.resultado) : 'Unverified';
  const emoji = resultadoKey ? (RESULTADO_EMOJIS[resultadoKey] ?? '🔍') : '🔍';
  const nombre = pol ? formatNombre(pol.nombre_completo) : 'An MEP';
  const partido = pol?.grupo_parlamentario ? ` (${pol.grupo_parlamentario})` : '';
  const texto = String(claim.texto_normalizado ?? '').trim();
  const truncated = texto.length > 200 ? texto.slice(0, 200) + '…' : texto;
  return `🔍 ${nombre}${partido} stated: "${truncated}"\n${emoji} ${resultadoLabel} | facthem.eu`;
}

function buildShareTextPlain(claim) {
  return buildShareText(claim);
}

function buildShareMenu(claim) {
  const shareUrl = buildShareUrl(claim);
  const shareText = buildShareTextPlain(claim);
  const fullText = shareText + '\n\n' + shareUrl;
  const encodedUrl = encodeURIComponent(shareUrl);
  const encodedFullText = encodeURIComponent(fullText);
  const encodedWa = encodeURIComponent(fullText);

  return `
    <a class="share-option" href="https://wa.me/?text=${encodedWa}" target="_blank" rel="noopener">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347zM12 0C5.373 0 0 5.373 0 12c0 2.127.557 4.123 1.532 5.856L0 24l6.335-1.652A11.954 11.954 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z"/></svg>
      WhatsApp
    </a>
    <a class="share-option" href="https://twitter.com/intent/tweet?text=${encodedFullText}&via=facthem_ES" target="_blank" rel="noopener">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
      X / Twitter
    </a>
    <a class="share-option" href="https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}" target="_blank" rel="noopener">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
      Facebook
    </a>
    <a class="share-option" href="https://t.me/share/url?url=${encodedUrl}&text=${encodeURIComponent(shareText + '\n')}" target="_blank" rel="noopener">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
      Telegram
    </a>
    <button class="share-option share-copy-btn" data-url="${escHtml(shareUrl)}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      <span>Copy link</span>
    </button>`;
}

function setupShare() {
  document.addEventListener('click', e => {
    const shareBtn = e.target.closest('.share-btn');
    const copyBtn = e.target.closest('.share-copy-btn');
    const imgBtn = e.target.closest('.share-img-btn');

    if (shareBtn) {
      e.stopPropagation();
      const menu = shareBtn.closest('.share-wrapper').querySelector('.share-menu');
      const isHidden = menu.hidden;
      document.querySelectorAll('.share-menu').forEach(m => { m.hidden = true; });
      menu.hidden = !isHidden;
      return;
    }

    if (copyBtn) {
      e.stopPropagation();
      handleShareCopy(copyBtn, copyBtn.dataset.url);
      return;
    }

    if (imgBtn) {
      e.stopPropagation();
      const claim = claimsById[imgBtn.dataset.claimId];
      if (claim) handleShareImage(imgBtn, claim);
      return;
    }

    document.querySelectorAll('.share-menu').forEach(m => { m.hidden = true; });
  });
}

async function handleShareCopy(btn, url) {
  try {
    await navigator.clipboard.writeText(url);
    const span = btn.querySelector('span');
    if (span) {
      span.textContent = 'Copied!';
      setTimeout(() => { span.textContent = 'Copy link'; }, 2000);
    }
  } catch { /* clipboard not available */ }
}

function updateOGTags(claim) {
  const pol = claim.politician;
  const v = claim.verification?.[0] ?? null;
  const nombre = pol ? formatNombre(pol.nombre_completo) : 'An MEP';
  const resultado = v ? formatResultado(v.resultado) : 'Unverified';
  const texto = String(claim.texto_normalizado ?? '').trim();
  const desc = texto.length > 160 ? texto.slice(0, 160) + '…' : texto;
  const title = `${nombre} — ${resultado} | Facthem`;

  document.title = title;
  setMeta('name', 'description', desc);
  setMeta('property', 'og:title', title);
  setMeta('property', 'og:description', desc);
  setMeta('property', 'og:url', `https://facthem.eu${claimPageUrl(claim)}`);
  setMeta('name', 'twitter:title', title);
  setMeta('name', 'twitter:description', desc);
}

function setMeta(attr, value, content) {
  const el = document.querySelector(`meta[${attr}="${value}"]`);
  if (el) el.setAttribute('content', content);
}

// ─── Share image (Canvas) ──────────────────────────────────────────────────────
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function wrapText(ctx, text, maxWidth, maxLines) {
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const word of words) {
    const test = cur ? `${cur} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && cur) {
      lines.push(cur);
      if (lines.length >= maxLines) {
        lines[lines.length - 1] = lines[lines.length - 1].replace(/[,.]?$/, '…');
        return lines;
      }
      cur = word;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

async function generateShareImage(claim) {
  const canvas = document.createElement('canvas');
  const W = 1200, H = 630;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const pol = claim.politician;
  const v = claim.verification?.[0] ?? null;
  const clsKey = v ? resultadoToClass(v.resultado) : 'nv';
  const c = IMG_COLORS[clsKey] ?? IMG_COLORS.nv;
  const resultadoLabel = v ? formatResultado(v.resultado) : 'Unverified';
  const nombre = pol ? formatNombre(pol.nombre_completo) : 'An MEP';
  const partido = pol?.grupo_parlamentario ?? '';
  const texto = capitalize(String(claim.texto_normalizado ?? '').trim());
  const score = v?.confidence_score != null ? Math.round(v.confidence_score * 100) : null;
  const font = "'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif";

  // Outer background
  ctx.fillStyle = '#0d0d0d';
  ctx.fillRect(0, 0, W, H);

  // Card rect
  const cx = 40, cy = 40, cw = W - 80, ch = H - 80, cr = 12;
  // Card gradient background
  const grad = ctx.createLinearGradient(cx, cy, cx, cy + ch * 0.35);
  grad.addColorStop(0, c.bgAlpha);
  grad.addColorStop(1, '#141414');
  ctx.fillStyle = grad;
  roundRect(ctx, cx, cy, cw, ch, cr);
  ctx.fill();
  // Card border
  ctx.strokeStyle = '#2a2424';
  ctx.lineWidth = 1.5;
  roundRect(ctx, cx, cy, cw, ch, cr);
  ctx.stroke();
  // Card border-top (verdict color, 6px)
  ctx.fillStyle = c.color;
  ctx.beginPath();
  ctx.moveTo(cx + cr, cy);
  ctx.lineTo(cx + cw - cr, cy);
  ctx.quadraticCurveTo(cx + cw, cy, cx + cw, cy + cr);
  ctx.lineTo(cx + cw, cy + 6);
  ctx.lineTo(cx, cy + 6);
  ctx.lineTo(cx, cy + cr);
  ctx.quadraticCurveTo(cx, cy, cx + cr, cy);
  ctx.closePath();
  ctx.fill();

  // ── Content padding
  const px = cx + 52, maxW = cw - 104;
  let y = cy + 74;

  // ── Header row: politician name + partido badge | resultado badge
  ctx.font = `700 34px ${font}`;
  ctx.fillStyle = '#e4e0e0';
  ctx.fillText(nombre, px, y);
  const nombreW = ctx.measureText(nombre).width;

  if (partido) {
    const bFont = `500 22px ${font}`;
    ctx.font = bFont;
    const bPad = 14, bH = 34, bR = 4;
    const bW = ctx.measureText(partido).width + bPad * 2;
    const bx = px + nombreW + 16, by = y - 26;
    ctx.fillStyle = 'rgba(255,255,255,.05)';
    roundRect(ctx, bx, by, bW, bH, bR); ctx.fill();
    ctx.strokeStyle = '#2a2424'; ctx.lineWidth = 1;
    roundRect(ctx, bx, by, bW, bH, bR); ctx.stroke();
    ctx.fillStyle = '#9a8e8e';
    ctx.fillText(partido, bx + bPad, by + 23);
  }

  // Resultado badge (right-aligned)
  const badgeLabel = resultadoLabel.toUpperCase();
  const badgeFont = `800 20px ${font}`;
  ctx.font = badgeFont;
  ctx.letterSpacing = '0.08em';
  const dotR = 6, dotGap = 10, badgePad = 18, badgeH = 38, badgeR = 3;
  const labelW = ctx.measureText(badgeLabel).width;
  const badgeW = dotR * 2 + dotGap + labelW + badgePad * 2;
  const bx2 = cx + cw - 52 - badgeW, by2 = y - 28;
  ctx.fillStyle = c.bgAlpha;
  roundRect(ctx, bx2, by2, badgeW, badgeH, badgeR); ctx.fill();
  ctx.strokeStyle = c.border; ctx.lineWidth = 1;
  roundRect(ctx, bx2, by2, badgeW, badgeH, badgeR); ctx.stroke();
  ctx.fillStyle = c.color;
  // dot
  ctx.beginPath();
  ctx.arc(bx2 + badgePad + dotR, by2 + badgeH / 2, dotR, 0, Math.PI * 2);
  ctx.fill();
  // label
  ctx.fillText(badgeLabel, bx2 + badgePad + dotR * 2 + dotGap, by2 + 26);
  ctx.letterSpacing = '0px';

  y += 52;

  // ── Decorative quote mark
  ctx.font = `900 180px Georgia, 'Times New Roman', serif`;
  ctx.fillStyle = 'rgba(200,96,122,0.30)';
  ctx.fillText('\u201C', px - 8, y + 100);

  // ── Claim text (italic)
  ctx.font = `italic 400 28px ${font}`;
  ctx.fillStyle = '#e4e0e0';
  const textIndent = px + 52;
  const textMaxW = maxW - 52;
  const textLines = wrapText(ctx, texto, textMaxW, 4);
  textLines.forEach((line, i) => { ctx.fillText(line, textIndent, y + i * 46); });
  y += textLines.length * 46 + 24;

  // ── Confidence bar
  if (score !== null) {
    const trackW = 220, trackH = 6, trackR = 99;
    ctx.fillStyle = '#2a2424';
    roundRect(ctx, px, y, trackW, trackH, trackR); ctx.fill();
    ctx.fillStyle = c.color;
    roundRect(ctx, px, y, Math.round(trackW * score / 100), trackH, trackR); ctx.fill();
    ctx.font = `500 20px ${font}`;
    ctx.fillStyle = '#9a8e8e';
    ctx.fillText(`${score}% confianza`, px + trackW + 14, y + trackH + 5);
    y += 30;
  }

  // ── Footer
  const footerY = cy + ch - 40;
  // "Facthem" in gradient (matching .hero-title)
  const fFont = `900 40px ${font}`;
  ctx.font = fFont;
  const fW = ctx.measureText('Facthem').width;
  const fGrad = ctx.createLinearGradient(px, footerY - 30, px + fW, footerY);
  fGrad.addColorStop(0, '#f0b8c4');
  fGrad.addColorStop(1, '#c8607a');
  ctx.fillStyle = fGrad;
  ctx.fillText('Facthem', px, footerY);
  // "verificador parlamentario" small
  ctx.font = `400 18px ${font}`;
  ctx.fillStyle = '#9a8e8e';
  ctx.fillText('verificador parlamentario', px + fW + 14, footerY - 2);
  // "facthem.eu" right
  ctx.font = `500 20px ${font}`;
  ctx.fillStyle = '#9a8e8e';
  const fesW = ctx.measureText('facthem.eu').width;
  ctx.fillText('facthem.eu', cx + cw - 52 - fesW, footerY);

  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

async function handleShareImage(btn, claim) {
  const span = btn.querySelector('span');
  const originalText = span?.textContent ?? '';
  if (span) span.textContent = 'Generando…';
  try {
    const blob = await generateShareImage(claim);
    const file = new File([blob], 'facthem-claim.png', { type: 'image/png' });
    const shareUrl = buildShareUrl(claim);
    const shareText = buildShareText(claim);
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], text: shareText, url: shareUrl });
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'facthem-claim.png';
      a.click();
      URL.revokeObjectURL(url);
    }
  } catch (err) {
    if (err?.name !== 'AbortError') console.error('Share image failed:', err);
  } finally {
    if (span) span.textContent = originalText || 'Share image';
  }
}

async function handleClaimDeepLink() {
  const claimId = new URLSearchParams(window.location.search).get('claim');
  if (!claimId) return;

  const { data, error } = await supabase
    .from('claim')
    .select(`
      id, texto_normalizado, texto_original, entidad, metrica,
      valor_afirmado, periodo_temporal, ambito_geografico, ambito_tematico,
      fuente_citada, verificabilidad, centralidad, relevancia, tipo_claim,
      politician:politician_id (nombre_completo, partido, grupo_parlamentario),
      verification (
        resultado, confidence_score, afirmacion_correcta,
        omisiones, errores, fuentes, potencial_engano,
        recomendacion_redaccion, razonamiento_llm
      )
    `)
    .eq('id', claimId)
    .single();

  if (!error && data) {
    claimsById[data.id] = data;
    updateOGTags(data);
    openModal(data);
  } else {
    console.warn('[deeplink] claim not found or fetch failed', claimId, error?.message);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isValidValue(v) {
  return v && v !== 'N/A' && v !== '-' && v !== 'n/a';
}

function capitalize(str) {
  const s = String(str ?? '').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function snakeToLabel(str) {
  return capitalize(String(str ?? '').replace(/_/g, ' '));
}

function toListItems(text) {
  return text
    .split(/\n|;/)
    .map(s => s.replace(/^[\s\-•*\d.]+/, '').trim())
    .filter(Boolean);
}

function renderErrores(raw) {
  if (!isValidValue(raw)) return '';
  let items = [];
  try {
    const parsed = JSON.parse(raw);
    items = Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [String(parsed)];
  } catch {
    items = [raw.trim()].filter(Boolean);
  }
  if (!items.length) return '';
  return `<div class="detail-row detail-errores">
    <dt>Error detected</dt>
    <dd>${items.map(i => `<em>${escHtml(capitalize(i))}</em>`).join('<br><br>')}</dd>
  </div>`;
}

function renderOmisiones(raw) {
  if (!isValidValue(raw)) return '';
  let items = [];
  try { items = JSON.parse(raw); } catch { items = toListItems(raw); }
  if (!Array.isArray(items) || !items.length) return '';
  return `<div class="detail-row">
    <dt>Omissions</dt>
    <dd><ul class="detail-list omisiones">
      ${items.map(i => `<li>${escHtml(capitalize(String(i)))}</li>`).join('')}
    </ul></dd>
  </div>`;
}

const FUENTE_TIPO_ORDER = { 'Primary': 0, 'Academic': 1, 'Secondary': 2, 'Tertiary': 3, 'Primaria': 0, 'Académica': 1, 'Secundaria': 2, 'Terciaria': 3 };
const FUENTE_TIPO_LABELS = { 'Primaria': 'Primary', 'Académica': 'Academic', 'Secundaria': 'Secondary', 'Terciaria': 'Tertiary' };

function renderFuentes(raw) {
  if (!isValidValue(raw)) return '';
  let items = [];
  try { items = JSON.parse(raw); } catch {
    const plain = toListItems(raw);
    if (!plain.length) return '';
    return `<div class="detail-row">
      <dt>Sources</dt>
      <dd><ul class="detail-list fuentes">${plain.map(i => `<li>${escHtml(i)}</li>`).join('')}</ul></dd>
    </div>`;
  }
  if (!Array.isArray(items) || !items.length) return '';

  const sorted = [...items].sort((a, b) =>
    (FUENTE_TIPO_ORDER[a.tipo] ?? 9) - (FUENTE_TIPO_ORDER[b.tipo] ?? 9)
  );

  const bullets = sorted.map(s => {
    const isPrimary = s.tipo === 'Primaria' || s.tipo === 'Primary';
    const tipoLabel = FUENTE_TIPO_LABELS[s.tipo] ?? s.tipo ?? '';
    const tipoKey = tipoLabel.toLowerCase().replace(/[^a-z]/g, '') || 'other';
    const name = escHtml(s.nombre ?? 'Source');
    const link = s.url
      ? `<a class="source-link" href="${escHtml(s.url)}" target="_blank" rel="noopener">${name}</a>`
      : `<span>${name}</span>`;
    const tipoBadge = tipoLabel
      ? `<span class="source-tipo source-tipo--${tipoKey}">${escHtml(tipoLabel)}</span>`
      : '';
    const dato = s.dato_especifico
      ? `<span class="source-dato">${escHtml(s.dato_especifico)}</span>`
      : '';
    return `<li class="fuente-item${isPrimary ? ' fuente-item--primary' : ''}">${tipoBadge}${link}${dato}</li>`;
  }).join('');

  return `<div class="detail-row">
    <dt>Sources</dt>
    <dd><ul class="detail-list fuentes">${bullets}</ul></dd>
  </div>`;
}

function resultadoToClass(resultado) {
  if (!resultado) return 'nv';
  const map = {
    'CONFIRMED': 'verdadero',
    'CONFIRMED_WITH_NUANCE': 'parcial',
    'DECONTEXTUALIZED': 'enganoso',
    'INACCURATE': 'nv',
    'FALSE': 'falso',
    'UNVERIFIABLE': 'nv',
    'OVERESTIMATED': 'enganoso',
    'UNDERESTIMATED': 'enganoso',
  };
  return map[resultado.toUpperCase()] ?? 'nv';
}

function formatResultado(resultado) {
  if (!resultado) return 'Unverified';
  return RESULTADO_LABELS[resultado.toUpperCase()] ?? snakeToLabel(resultado);
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
async function loadGlobalDashboard() {
  window.statsLoaded = true;
  const grid = document.getElementById('dashboard-grid');
  const loader = document.getElementById('dashboard-loading');

  const { data, error } = await supabase
    .from('dashboard_stats')
    .select('stats')
    .eq('id', 1)
    .single();

  if (error || !data?.stats) {
    loader.innerHTML = `<p class="error">Error loading statistics: ${error?.message ?? 'no data'}</p>`;
    return;
  }

  loader.style.display = 'none';
  grid.classList.remove('hidden');

  const stats = typeof data.stats === 'string' ? JSON.parse(data.stats) : data.stats;
  renderDashboard(stats);
}

function renderDashboard(s) {
  const grid = document.getElementById('dashboard-grid');

  const total = s.total_claims || 0;
  const totalFalsos = s.total_falsos || 0;
  const totalConfirm = s.total_confirmados || 0;
  const porcFalsos = total > 0 ? Math.round((totalFalsos / total) * 100) : 0;
  const porcConfirmados = total > 0 ? Math.round((totalConfirm / total) * 100) : 0;

  const d = (field) => s[field] || {};
  const polLabel = (f) => {
    const o = d(f);
    return o.name ? `${formatNombre(o.name)}${o.grupo_parlamentario ? ` · ${o.grupo_parlamentario}` : ''}` : '-';
  };

  const cb = s.combo_breaker || {};
  const bc = s.bocachancla || {};
  const cbLabel = cb.politico ? `${formatNombre(cb.politico)} · ${cb.grupo_parlamentario ?? cb.partido ?? ''}` : '-';
  const bcLabel = bc.politico ? `${formatNombre(bc.politico)} · ${bc.grupo_parlamentario ?? bc.partido ?? ''}` : '-';
  const cbSub = cb.fecha ? `${cb.count} confirmados en el pleno del ${new Date(cb.fecha).toLocaleDateString('es-ES')}` : '-';
  const bcSub = bc.fecha ? `${bc.count} falsedades en el pleno del ${new Date(bc.fecha).toLocaleDateString('es-ES')}` : '-';

  const temaLabel = (f) => {
    const name = d(f).name;
    return name ? (TEMATICO_LABELS[name] ?? snakeToLabel(name)) : '-';
  };

  const tfrRate = s.top_tema_falso_rate || {};
  const tfrLabel = tfrRate.name ? (TEMATICO_LABELS[tfrRate.name] ?? snakeToLabel(tfrRate.name)) : '-';

  const topTemas = (s.temas_por_volumen || []).map(t => ({
    tema: TEMATICO_LABELS[t.tema] ?? snakeToLabel(t.tema),
    dominante: t.partido_dominante || '—',
    especializado: t.partido_especializado || '—',
  }));

  const claimsPorPartido = (s.claims_por_partido || [])
    .filter(p => p.count >= 40)
    .map(p => ({
      tema: p.partido,
      partido: p.count.toString(),
    }));

  grid.innerHTML = `
    ${statCard('Group with most claims', d('top_partido_claims').name || '-', `${d('top_partido_claims').count || 0} total claims`, false, 'The political group with the highest number of claims in total.')}
    ${statCard('MEP with most claims', polLabel('top_politico_claims'), `${d('top_politico_claims').count || 0} total claims`, false, 'The MEP who has made the most claims overall.')}
    ${statCard('Most debated topic', temaLabel('top_tema'), `${d('top_tema').count || 0} mentions`, false, 'The topic area with the most claims made.')}
    ${statCardDual('MEP with most false claims',
        polLabel('top_politico_falso_volumen'), `${d('top_politico_falso_volumen').count || 0} false/misleading`,
        polLabel('top_politico_falso_tasa'), d('top_politico_falso_tasa').count || 0, d('top_politico_falso_tasa').total || 0, d('top_politico_falso_tasa').rate || 0,
        true, 'falsehood', 'The MEP with the most claims verified as false or misleading.')}
    ${statCard('Group with most false claims', d('top_partido_falso').name || '-', `${d('top_partido_falso').count || 0} false/misleading`, true, 'The group with the most claims verified as false or misleading.')}
    ${statCard('Falsehood rate', `${porcFalsos}%`, `${totalFalsos} of ${total} claims`, true, 'Percentage of claims verified as false or misleading.')}
    ${statCard('Most contested topic', temaLabel('top_tema_falso'), `${d('top_tema_falso').count || 0} false claims`, true, 'The topic area where the most false claims have been detected.')}
    ${statCardDual('The Master of Evasion',
        polLabel('top_politico_nv_volumen'), `${d('top_politico_nv_volumen').count || 0} unverifiable claims`,
        polLabel('top_politico_nv_tasa'), d('top_politico_nv_tasa').count || 0, d('top_politico_nv_tasa').total || 0, d('top_politico_nv_tasa').rate || 0,
        false, 'unverifiable', 'The MEP who makes the most claims that cannot be verified due to lack of concrete data.')}
    ${statCard('Truth rate', `${porcConfirmados}%`, `${totalConfirm} of ${total} claims`, false, 'Percentage of claims verified as completely true.')}
    ${statCard('Most slippery group', d('top_partido_nv').name || '-', `${d('top_partido_nv').count || 0} unverifiable claims`, false, 'The group that makes the most unverifiable claims.')}
    ${statCard('The Mother of All Misinformation', tfrLabel, `${Math.round((tfrRate.rate || 0) * 100)}% falsehood rate`, true, 'The topic area where MEPs lie most shamelessly in proportion.')}
    ${statCardDual('The Grand Nuancer',
        polLabel('top_politico_matiz_volumen'), `${d('top_politico_matiz_volumen').count || 0} nuanced confirmations`,
        polLabel('top_politico_matiz_tasa'), d('top_politico_matiz_tasa').count || 0, d('top_politico_matiz_tasa').total || 0, d('top_politico_matiz_tasa').rate || 0,
        false, 'nuanced', 'The MEP who most often says something true… but with an important caveat.')}
    ${statCard('The "yes, but…" group', d('top_partido_matiz').name || '-', `${d('top_partido_matiz').count || 0} nuanced confirmations`, false, 'The group that accumulates the most half-truths.')}
    ${statCard('Combo Breaker', cbLabel, cbSub, false, 'The MEP who scored the most confirmed claims in a single plenary.')}
    ${statCard('The Loose Cannon', bcLabel, bcSub, true, 'The MEP who chained the most false claims in a single plenary.')}
    ${statCardDual('Chief Exaggerator',
        polLabel('top_politico_sobre_volumen'), `${d('top_politico_sobre_volumen').count || 0} overestimated figures`,
        polLabel('top_politico_sobre_tasa'), d('top_politico_sobre_tasa').count || 0, d('top_politico_sobre_tasa').total || 0, d('top_politico_sobre_tasa').rate || 0,
        true, 'overestimation', 'The MEP who most often inflates real figures to make them sound more dramatic.')}
    ${statCard('The Inflated Figures Group', d('top_partido_sobre').name || '-', `${d('top_partido_sobre').count || 0} overestimations`, true, 'The group that most often overstates data that is actually smaller.')}
    ${statCard('The Massaged Numbers Group', d('top_partido_subest').name || '-', `${d('top_partido_subest').count || 0} underestimations`, true, 'The group that most often minimises real data.')}
    ${statCard('The Armchair Expert', polLabel('top_politico_cunado'), `${d('top_politico_cunado').count || 0} topics · ${Math.round((d('top_politico_cunado').rate || 0) * 100)}% of total`, false, 'The MEP who has an opinion on absolutely everything.')}
    ${statCardDual('The Downplayer',
        polLabel('top_politico_subest_volumen'), `${d('top_politico_subest_volumen').count || 0} underestimated figures`,
        polLabel('top_politico_subest_tasa'), d('top_politico_subest_tasa').count || 0, d('top_politico_subest_tasa').total || 0, d('top_politico_subest_tasa').rate || 0,
        true, 'underestimation', 'The MEP who most often reduces real figures to make them sound less serious.')}
    ${statCard('The Captain Obvious Group', d('top_partido_impreciso').name || '-', `${d('top_partido_impreciso').count || 0} inaccuracies`, false, 'The group that most often says something so vague it cannot be verified.')}
    ${statCard('The Cherry-Pickers', d('top_partido_descont').name || '-', `${d('top_partido_descont').count || 0} out-of-context claims`, true, 'The group that most often uses real data stripped of its context to change its meaning.')}
    ${statCardDual('The Master of Empty Words',
        polLabel('top_politico_impreciso_volumen'), `${d('top_politico_impreciso_volumen').count || 0} inaccurate claims`,
        polLabel('top_politico_impreciso_tasa'), d('top_politico_impreciso_tasa').count || 0, d('top_politico_impreciso_tasa').total || 0, d('top_politico_impreciso_tasa').rate || 0,
        false, 'inaccuracy', 'The MEP who most often makes a claim so vague there is no way to verify it.')}
    ${statCardDual('The Context Stripper',
        polLabel('top_politico_descont_volumen'), `${d('top_politico_descont_volumen').count || 0} out-of-context claims`,
        polLabel('top_politico_descont_tasa'), d('top_politico_descont_tasa').count || 0, d('top_politico_descont_tasa').total || 0, d('top_politico_descont_tasa').rate || 0,
        true, 'out-of-context', 'The MEP who most often uses real data stripped of its context to change its meaning.')}
    ${statCardListTemas('Groups by topic', topTemas)}
    ${statCardList('Claims by group', claimsPorPartido, 'Total claims recorded per political group.')}
  `;
}

function statCard(title, value, subtitle, isFalsoSubtitle = false, description = '') {
  const subClass = isFalsoSubtitle ? 'stat-subtitle falso-subtitle' : 'stat-subtitle';
  return `
    <div class="stat-card">
      <div class="stat-title">${title}</div>
      <div class="stat-value">${value}</div>
      <div class="${subClass}">${subtitle}</div>
      ${description ? `<div class="stat-desc">${description}</div>` : ''}
    </div>`;
}

function statCardDual(title, volLabel, volSub, tasaLabel, tasaCount, tasaTotal, tasaRate, isFalso, tasaKeyword, description = '') {
  const subClass = isFalso ? 'stat-subtitle falso-subtitle' : 'stat-subtitle';
  const tasaSub = `${Math.round(tasaRate * 100)}% ${tasaKeyword} · ${tasaCount} of ${tasaTotal} claims`;
  return `
    <div class="stat-card stat-card--dual">
      <div class="stat-title">${title}</div>
      <div class="stat-dual">
        <div class="stat-dual-col">
          <div class="stat-dual-label">By volume</div>
          <div class="stat-value">${volLabel}</div>
          <div class="${subClass}">${volSub}</div>
        </div>
        <div class="stat-dual-col">
          <div class="stat-dual-label">By rate</div>
          <div class="stat-value">${tasaLabel}</div>
          <div class="${subClass}">${tasaSub}</div>
        </div>
      </div>
      ${description ? `<div class="stat-desc">${description}</div>` : ''}
    </div>`;
}

function statCardList(title, rows, description = '') {
  const items = rows.map(r =>
    `<div class="stat-list-row">
      <span class="stat-list-tema">${escHtml(r.tema)}</span>
      <span class="stat-list-partido">${escHtml(r.partido)}</span>
    </div>`
  ).join('');
  return `
    <div class="stat-card stat-card--list">
      <div class="stat-title">${title}</div>
      <div class="stat-list">${items}</div>
      ${description ? `<div class="stat-desc">${description}</div>` : ''}
    </div>`;
}

function statCardListTemas(title, rows) {
  const header = `<div class="stat-list-row stat-list-row--header">
    <span class="stat-list-tema"></span>
    <span class="stat-list-partido stat-list-col-label">Dominant</span>
    <span class="stat-list-partido stat-list-col-label">Most focused</span>
  </div>`;
  const items = rows.map(r =>
    `<div class="stat-list-row">
      <span class="stat-list-tema">${escHtml(r.tema)}</span>
      <span class="stat-list-partido">${escHtml(r.dominante)}</span>
      <span class="stat-list-partido">${escHtml(r.especializado)}</span>
    </div>`
  ).join('');
  return `
    <div class="stat-card stat-card--list stat-card--temas">
      <div class="stat-title">${title}</div>
      <div class="stat-list stat-list--table">${header}${items}</div>
      <div class="stat-desc">
        Shows the main relationship between groups and debate topics. Dominant: most claims on that topic. Most focused: the group that prioritises it most relative to its overall activity.
      </div>
    </div>`;
}

// ─── Búsqueda tab ─────────────────────────────────────────────────────────────
async function loadPoliticians() {
  searchLoaded = true;
  const input = document.getElementById('politician-search-input');
  input.placeholder = 'Loading MEPs…';
  input.disabled = true;

  const { data, error } = await supabase
    .from('politician')
    .select('id, nombre_completo, partido, grupo_parlamentario')
    .order('nombre_completo');

  input.disabled = false;
  input.placeholder = 'Type an MEP\'s name…';

  if (error || !data?.length) {
    input.placeholder = 'Error loading MEPs. Reload the page.';
    return;
  }

  allPoliticians = data;
  setupPoliticianAutocomplete();
}

function setupPoliticianAutocomplete() {
  const input = document.getElementById('politician-search-input');
  const clearBtn = document.getElementById('search-clear-btn');
  const combobox = document.getElementById('politician-combobox');

  input.addEventListener('input', onSearchInput);
  input.addEventListener('keydown', onSearchKeydown);
  input.addEventListener('focus', onSearchFocus);
  clearBtn.addEventListener('click', clearSearch);

  document.addEventListener('click', e => {
    if (!combobox.contains(e.target)) closeSuggestions();
  });
}

function onSearchInput(e) {
  const query = e.target.value.trim();
  const clearBtn = document.getElementById('search-clear-btn');
  clearBtn.hidden = query.length === 0;
  activeSearchIndex = -1;

  if (query.length < 2) { closeSuggestions(); return; }

  const norm = query.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const tokens = norm.split(/\s+/).filter(Boolean);
  const matches = allPoliticians
    .filter(p => {
      const normName = p.nombre_completo.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      return tokens.every(t => normName.includes(t));
    })
    .slice(0, 8);

  renderSuggestions(matches, query);
}

function onSearchFocus() {
  const input = document.getElementById('politician-search-input');
  if (input.value.trim().length >= 2) onSearchInput({ target: input });
}

function onSearchKeydown(e) {
  const list = document.getElementById('politician-suggestions');
  const items = [...list.querySelectorAll('.suggestion-item')];

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeSearchIndex = Math.min(activeSearchIndex + 1, items.length - 1);
    updateActiveItem(items);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeSearchIndex = Math.max(activeSearchIndex - 1, -1);
    updateActiveItem(items);
  } else if (e.key === 'Enter') {
    if (activeSearchIndex >= 0 && items[activeSearchIndex]) {
      items[activeSearchIndex].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    }
  } else if (e.key === 'Escape') {
    closeSuggestions();
  }
}

function updateActiveItem(items) {
  const input = document.getElementById('politician-search-input');
  items.forEach((item, i) => {
    const active = i === activeSearchIndex;
    item.classList.toggle('suggestion-item--active', active);
    item.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  input.setAttribute('aria-activedescendant',
    activeSearchIndex >= 0 ? (items[activeSearchIndex]?.id ?? '') : '');
}

function renderSuggestions(matches, query) {
  const list = document.getElementById('politician-suggestions');
  const input = document.getElementById('politician-search-input');

  if (!matches.length) { closeSuggestions(); return; }

  list.innerHTML = matches.map((p, i) => {
    const formattedName = formatNombre(p.nombre_completo);
    const highlighted = highlightMatch(escHtml(formattedName), query);
    const partido = p.grupo_parlamentario
      ? `<span class="suggestion-partido">· ${escHtml(p.grupo_parlamentario)}</span>`
      : '';
    const gobierno = p.grupo_parlamentario === 'EU Commission' ? '  🏛️' : '';
    return `<li class="suggestion-item" role="option" id="suggestion-${i}" aria-selected="false"
      data-id="${p.id}" data-name="${escHtml(formattedName)}">${highlighted}${partido}${gobierno}</li>`;
  }).join('');

  list.querySelectorAll('.suggestion-item').forEach(item => {
    item.addEventListener('mousedown', e => {
      e.preventDefault();
      selectPolitician(item.dataset.id, item.dataset.name);
    });
  });

  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

function highlightMatch(escapedText, rawQuery) {
  const norm = rawQuery.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const normText = escapedText.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const idx = normText.indexOf(norm);
  if (idx === -1) return escapedText;
  return (
    escapedText.slice(0, idx) +
    `<mark class="suggestion-mark">${escapedText.slice(idx, idx + rawQuery.length)}</mark>` +
    escapedText.slice(idx + rawQuery.length)
  );
}

function closeSuggestions() {
  const list = document.getElementById('politician-suggestions');
  const input = document.getElementById('politician-search-input');
  list.hidden = true;
  list.innerHTML = '';
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
  activeSearchIndex = -1;
}

function clearSearch() {
  const input = document.getElementById('politician-search-input');
  const clearBtn = document.getElementById('search-clear-btn');
  const area = document.getElementById('search-results-area');
  input.value = '';
  clearBtn.hidden = true;
  closeSuggestions();
  document.getElementById('search-filters').hidden = true;
  resetSearchFilters();
  currentSearchClaims = [];
  area.innerHTML = `<div class="search-welcome">
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
    </svg>
    <p>Search for an MEP to see all their verified claims.</p>
  </div>`;
  input.focus();
}

async function selectPolitician(politicianId, politicianName) {
  const input = document.getElementById('politician-search-input');
  const area = document.getElementById('search-results-area');

  input.value = politicianName;
  closeSuggestions();
  document.getElementById('search-clear-btn').hidden = false;

  if (searchClaimsCache[politicianId]) {
    currentSearchClaims = searchClaimsCache[politicianId];
    resetSearchFilters();
    document.getElementById('search-filters').hidden = false;
    populateSearchFilters(currentSearchClaims);
    renderSearchResults(currentSearchClaims, politicianName);
    return;
  }

  area.innerHTML = '<p class="loading">Loading claims…</p>';

  const { data, error } = await supabase
    .from('claim')
    .select(`
      id, texto_normalizado, texto_original, ambito_tematico, ambito_geografico,
      politician:politician_id (nombre_completo, partido, grupo_parlamentario),
      verification (resultado, confidence_score, errores, omisiones, fuentes),
      session:session_id (id, fecha, organo, legislatura, tipo, numero)
    `)
    .eq('politician_id', politicianId)
    .not('verification', 'is', null)
    .order('session_id', { ascending: false });

  if (error) {
    area.innerHTML = `<p class="error">Error loading claims: ${escHtml(error.message)}</p>`;
    return;
  }

  const claims = data ?? [];
  searchClaimsCache[politicianId] = claims;
  currentSearchClaims = claims;
  resetSearchFilters();
  document.getElementById('search-filters').hidden = false;
  populateSearchFilters(claims);
  renderSearchResults(claims, politicianName);
}

function renderSearchResults(claims, politicianName) {
  const area = document.getElementById('search-results-area');

  if (!claims.length) {
    area.innerHTML = `<p class="empty">No verified claims found for <strong>${escHtml(politicianName)}</strong>.</p>`;
    return;
  }

  const grouped = new Map();
  for (const claim of claims) {
    const key = claim.session?.id ?? 'unknown';
    if (!grouped.has(key)) grouped.set(key, { session: claim.session, claims: [] });
    grouped.get(key).claims.push(claim);
  }

  const total = claims.length;
  const falsos = claims.filter(c => c.verification?.[0]?.resultado === 'FALSE').length;
  const pct = total > 0 ? Math.round((falsos / total) * 100) : 0;
  const countBadge = `<div class="search-count-badge">
    <span><strong>${total}</strong> claim${total === 1 ? '' : 's'}</span>
    <span class="badge-sep">·</span>
    <span><strong>${falsos}</strong> false</span>
    <span class="badge-sep">·</span>
    <span><strong>${pct}%</strong> false</span>
  </div>`;

  const groupsHtml = [...grouped.values()].map(({ session, claims: sessionClaims }) => {
    const fecha = session?.fecha
      ? new Date(session.fecha).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
      : 'Unknown session';
    const organ = session?.organo ? ` · ${escHtml(session.organo)}` : '';
    return `<section class="search-session-group">
      <h3 class="search-session-header">
        <span class="search-session-date">${escHtml(fecha)}</span>
        <span class="search-session-organ">${organ}</span>
      </h3>
      <div class="search-claims-grid">${sessionClaims.map(c => claimCard(c)).join('')}</div>
    </section>`;
  }).join('');

  area.innerHTML = countBadge + groupsHtml;

  const byId = Object.fromEntries(claims.map(c => [c.id, c]));
  area.querySelectorAll('.claim-toggle:not(a)').forEach(btn => {
    btn.addEventListener('click', () => openModal(byId[btn.dataset.id]));
  });
}
