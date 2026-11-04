// ==UserScript==
// @name         Grafana Firing Alerts Copy
// @namespace    https://mdg-labs.dev/
// @version      3.3.0
// @description  Copy button for the "Firing alerts" panel (Status dashboard): whole table or all rows of one alert
// @match        https://grafana.mdg-labs.dev/*
// @grant        GM_setClipboard
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/mdg-labs/userscripts/main/grafana-table-copy.user.js
// @downloadURL  https://raw.githubusercontent.com/mdg-labs/userscripts/main/grafana-table-copy.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---- target: exactly this panel ----
  const DASHBOARD_PATH = '/d/overview/';  // dashboard UID "overview"
  const PANEL_KEY = 'panel-5';            // "Firing alerts"
  const CATEGORY_FIELD = 'alertname';     // column used for grouping (header "Alert")

  const SEP = ',';         // CSV (values with commas, quotes or line breaks get quoted)

  // ---- prompt wrapped around the copied CSV (for pasting into Claude Code) ----
  // Placeholders: {{time}} = copy timestamp, {{csv}} = the data
  const PROMPT = `These alerts are currently firing (copied {{time}}):

\`\`\`csv
{{csv}}
\`\`\`

Read the infra runbooks and investigate what's going on. Don't change anything yet - report your findings and proposed fixes first.`;

  const BTN_ID = 'gtc-btn';
  const MENU_ID = 'gtc-menu';

  const style = document.createElement('style');
  style.textContent = `
    #${BTN_ID} {
      display: inline-flex; align-items: center; gap: 4px; margin-left: 8px; flex-shrink: 0;
      height: 22px; padding: 0 8px; cursor: pointer;
      font: 500 12px/1 Inter, Helvetica, Arial, sans-serif;
      color: #ccccdc; background: transparent;
      border: 1px solid rgba(204,204,220,.25); border-radius: 3px;
    }
    #${BTN_ID}:hover, #${BTN_ID}.gtc-open { background: rgba(204,204,220,.08); border-color: rgba(204,204,220,.45); }
    #${BTN_ID}.gtc-done { color: #6ccf8e; border-color: #6ccf8e; }
    #${MENU_ID} {
      position: fixed; z-index: 10000; min-width: 240px; max-height: 60vh; overflow: auto; padding: 4px 0;
      font: 13px/1.4 Inter, Helvetica, Arial, sans-serif; color: #ccccdc;
      background: #181b1f; border: 1px solid rgba(204,204,220,.2); border-radius: 4px;
      box-shadow: 0 8px 24px rgba(0,0,0,.45);
    }
    #${MENU_ID} .gtc-item { display: flex; justify-content: space-between; gap: 16px; padding: 6px 12px; cursor: pointer; white-space: nowrap; }
    #${MENU_ID} .gtc-item:hover { background: rgba(204,204,220,.1); }
    #${MENU_ID} .gtc-n { opacity: .55; }
    #${MENU_ID} .gtc-sep { height: 1px; margin: 4px 0; background: rgba(204,204,220,.15); }
  `;
  document.head.appendChild(style);

  // ---- data (reads all rows from the table's React props, incl. rows scrolled out of view) ----
  function gridProps(grid) {
    const key = Object.keys(grid).find((k) => k.startsWith('__reactFiber'));
    let f = key && grid[key];
    for (let i = 0; i < 15 && f; i++, f = f.return) {
      const p = f.memoizedProps;
      if (p && Array.isArray(p.columns) && Array.isArray(p.rows)) return p;
    }
    return null;
  }

  function fmt(field, v) {
    if (v === null || v === undefined) return '';
    if (typeof field.display === 'function') {
      try {
        const d = field.display(v);
        return `${d.prefix ?? ''}${d.text ?? ''}${d.suffix ?? ''}`;
      } catch (_) { /* raw */ }
    }
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }

  function readTable(grid) {
    const p = gridProps(grid);
    if (!p) return null;
    const cols = p.columns.filter((c) => c.field && c.field.values);
    if (!cols.length) return null;
    const catIdx = Math.max(0, cols.findIndex((c) => c.field.name === CATEGORY_FIELD));
    const rows = p.rows
      .filter((r) => r && typeof r.__index === 'number' && !r.__depth)
      .map((r) => cols.map((c) => fmt(c.field, c.field.values[r.__index])));
    return {
      headers: cols.map((c) => (typeof c.name === 'string' ? c.name : c.key) || c.field.name),
      rows,
      catIdx,
    };
  }

  const esc = (v) => (String(v).includes(SEP) || /["\r\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  // header row is always included
  const toCsv = (headers, rows) => [headers, ...rows].map((r) => r.map(esc).join(SEP)).join('\n');
  const stamp = () => {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const off = -d.getTimezoneOffset(), s = off >= 0 ? '+' : '-';
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ` +
      `UTC${s}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
  };
  const toText = (headers, rows) =>
    PROMPT.replace('{{time}}', stamp()).replace('{{csv}}', () => toCsv(headers, rows));

  // ---- UI ----
  function flash(btn, msg) {
    const label = btn.querySelector('span');
    btn.classList.add('gtc-done');
    label.textContent = msg;
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.classList.remove('gtc-done'); label.textContent = 'Copy'; }, 1500);
  }

  function copy(btn, text, n) {
    try { GM_setClipboard(text, 'text'); } catch (_) { navigator.clipboard.writeText(text); }
    flash(btn, `Copied ${n}`);
  }

  function closeMenu() {
    document.getElementById(MENU_ID)?.remove();
    document.getElementById(BTN_ID)?.classList.remove('gtc-open');
  }

  function openMenu(btn, grid) {
    const t = readTable(grid);
    if (!t) return flash(btn, 'No data');
    btn.classList.add('gtc-open');

    const menu = document.createElement('div');
    menu.id = MENU_ID;
    const item = (label, n, rows) => {
      const el = document.createElement('div');
      el.className = 'gtc-item';
      el.innerHTML = `<span></span><span class="gtc-n">${n}</span>`;
      el.firstChild.textContent = label;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        copy(btn, toText(t.headers, rows), n);
        closeMenu();
      });
      menu.appendChild(el);
    };

    item('Whole table', t.rows.length, t.rows);

    const groups = new Map();
    t.rows.forEach((r) => {
      const k = r[t.catIdx];
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    });
    if (groups.size) {
      const sep = document.createElement('div');
      sep.className = 'gtc-sep';
      menu.appendChild(sep);
      [...groups.keys()].sort().forEach((k) => item(k || '(empty)', groups.get(k).length, groups.get(k)));
    }

    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = r.bottom + 4 + 'px';
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest(`#${MENU_ID}, #${BTN_ID}`)) closeMenu();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('scroll', closeMenu, true);

  // ---- attach to the target panel only ----
  function scan() {
    const existing = document.getElementById(BTN_ID);
    if (!location.pathname.startsWith(DASHBOARD_PATH)) { existing?.remove(); closeMenu(); return; }

    const panel = document.querySelector(`[data-viz-panel-key="${PANEL_KEY}"]`);
    const header = panel?.querySelector('[data-testid$="header-container"]');
    const grid = panel?.querySelector('.rdg[role=grid]');
    if (!header || !grid) return;
    if (existing && header.contains(existing)) return;
    existing?.remove();

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.title = 'Copy whole table or one alert';
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg><span>Copy</span>`;
    // don't let Grafana treat the click as a panel-header drag/select
    ['mousedown', 'pointerdown'].forEach((ev) => btn.addEventListener(ev, (e) => e.stopPropagation()));
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.classList.contains('gtc-open')) return closeMenu();
      const g = panel.querySelector('.rdg[role=grid]'); // re-query: grid may have been re-mounted
      openMenu(btn, g || grid);
    });

    const title = header.querySelector('h2')?.parentElement;
    if (title && title.parentElement === header) title.after(btn);
    else header.appendChild(btn);
  }

  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; scan(); });
  }).observe(document.body, { childList: true, subtree: true });
  scan();
})();
