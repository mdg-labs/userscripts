// ==UserScript==
// @name         GitHub Issue & PR Toolkit
// @namespace    https://github.com/ghotso
// @version      3.0.0
// @description  Sub-Issue-Liste: zeigt status:* und safety-critical Labels jeder Sub-Issue an (gebündelter GraphQL-Request, PAT nötig; verschachtelte und repo-übergreifende Sub-Issues, Refresh-Bubble unten rechts). Copy-Button "<repo>#<nr>" im Header von Issues (auch im Sub-Issue-Sidepane) und Pull Requests.
// @author       Michael
// @match        https://github.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @connect      api.github.com
// @updateURL    https://raw.githubusercontent.com/mdg-labs/userscripts/main/github-issue-pr-toolkit.user.js
// @downloadURL  https://raw.githubusercontent.com/mdg-labs/userscripts/main/github-issue-pr-toolkit.user.js
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    // true  = nur Labels anzeigen, die auf highlightPrefix ODER einen exakten
    //         Namen aus exactNamesToShow passen
    // false = alle Labels der Sub-Issue anzeigen
    onlyHighlightedLabels: true,
    highlightPrefix: 'status:',
    exactNamesToShow: ['safety-critical', 'bug', 'maintainer-only', 'epic', 'maintainer-task'],
    // wie lange die pro Issue-Seite geladenen Labels gecacht bleiben (ms)
    cacheTtlMs: 2 * 60 * 1000,
    // Debounce für DOM-Änderungen, bevor neu gescannt wird (ms)
    scanDebounceMs: 250,
    // Copy-Button: false = "repo#12", true = "owner/repo#12"
    copyIncludeOwner: false,
  };

  const TOKEN_KEY = 'ghSubIssueLabelsPAT';
  const REFRESH_BTN_ID = 'subissue-labels-refresh-btn';
  const COPY_BTN_ATTR = 'data-copy-issue-ref';

  GM_registerMenuCommand('GitHub PAT für Sub-Issue-Labels setzen', async () => {
    const current = (await GM_getValue(TOKEN_KEY, '')) || '';
    const value = window.prompt(
      'GitHub Personal Access Token (Fine-grained, Berechtigung "Issues: Read-only" auf die Repos, oder classic mit "repo"/"public_repo" Scope):',
      current
    );
    if (value === null) return;
    await GM_setValue(TOKEN_KEY, value.trim());
    console.info('[gh-toolkit] Token gespeichert.');
    cache.clear();
    scheduleScan();
  });

  function gmFetchJson(url, options) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: options.method || 'GET',
        url,
        headers: options.headers || {},
        data: options.data,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            try {
              resolve(JSON.parse(res.responseText));
            } catch (e) {
              reject(new Error('Ungültige JSON-Antwort: ' + e.message));
            }
          } else {
            reject(new Error(`HTTP ${res.status}: ${res.responseText.slice(0, 300)}`));
          }
        },
        onerror: () => reject(new Error('Netzwerkfehler beim GraphQL-Request')),
      });
    });
  }

  // pageKey -> { ts, refsKey, labelsByKey: Map<"owner/repo#num", label[]> }
  const cache = new Map();
  let warnedNoToken = false;
  let inFlightKey = null;

  function getSubIssueContainer() {
    return document.querySelector('[data-testid="sub-issues-issue-container"]');
  }

  // liefert ALLE Ebenen (auch verschachtelte Sub-Sub-Issues)
  function getSubIssueRows(container) {
    return Array.from(container.querySelectorAll('li[role="treeitem"]'));
  }

  // nur die eigene Zeile, NICHT das verschachtelte <ul> mit Kind-Issues
  function getRowScope(li) {
    return li.querySelector(':scope > div.PRIVATE_TreeView-item-container') || li;
  }

  function getPageKey() {
    const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    return m ? `${m[1]}/${m[2]}#${m[3]}` : null;
  }

  // Sub-Issues können aus anderen Repos stammen -> owner/repo aus dem Link lesen
  function getRowIssueRef(li) {
    const scope = getRowScope(li);
    const link = scope.querySelector('a[href*="/issues/"]');
    if (!link) return null;
    const url = new URL(link.getAttribute('href') || '', location.origin);
    const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    if (!m) return null;
    const ref = { owner: m[1], repo: m[2], number: parseInt(m[3], 10) };
    ref.key = `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();
    return ref;
  }

  function hexToLabelVars(hex) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;
    const d = max - min;
    if (d !== 0) {
      s = d / (1 - Math.abs(2 * l - 1));
      switch (max) {
        case rn:
          h = ((gn - bn) / d) % 6;
          break;
        case gn:
          h = (bn - rn) / d + 2;
          break;
        default:
          h = (rn - gn) / d + 4;
      }
      h *= 60;
      if (h < 0) h += 360;
    }
    return { r, g, b, h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
  }

  function buildLabelSpan(label) {
    const vars = hexToLabelVars(label.color || 'ededed');
    const span = document.createElement('span');
    span.className = 'IssueLabel hx_IssueLabel d-inline-block mt-1 tmp-mt-1 v-align-middle';
    span.style.setProperty('--label-r', vars.r);
    span.style.setProperty('--label-g', vars.g);
    span.style.setProperty('--label-b', vars.b);
    span.style.setProperty('--label-h', vars.h);
    span.style.setProperty('--label-s', vars.s);
    span.style.setProperty('--label-l', vars.l);
    if (label.description) span.title = label.description;
    span.textContent = label.name;
    return span;
  }

  // gruppiert Refs nach Repo; jedes Repo bekommt ein eigenes Alias r0, r1, ...
  function buildGraphQLQuery(refs) {
    const byRepo = new Map();
    for (const ref of refs) {
      const rk = `${ref.owner}/${ref.repo}`.toLowerCase();
      if (!byRepo.has(rk)) byRepo.set(rk, { owner: ref.owner, repo: ref.repo, numbers: new Set() });
      byRepo.get(rk).numbers.add(ref.number);
    }
    const aliasToRepo = [];
    const parts = [];
    let idx = 0;
    for (const entry of byRepo.values()) {
      const alias = `r${idx++}`;
      aliasToRepo.push({ alias, owner: entry.owner, repo: entry.repo, numbers: [...entry.numbers] });
      const fields = [...entry.numbers]
        .map((n) => `i${n}: issue(number: ${n}) { number labels(first: 30) { nodes { name color description } } }`)
        .join('\n');
      parts.push(
        `${alias}: repository(owner: ${JSON.stringify(entry.owner)}, name: ${JSON.stringify(entry.repo)}) {\n${fields}\n}`
      );
    }
    return { query: `query {\n${parts.join('\n')}\n}`, aliasToRepo };
  }

  async function fetchLabelsForRefs(pageKey, refs) {
    const refsKey = refs.map((r) => r.key).sort().join(',');
    const cached = cache.get(pageKey);
    if (cached && cached.refsKey === refsKey && Date.now() - cached.ts < CONFIG.cacheTtlMs) {
      return cached.labelsByKey;
    }

    const token = (await GM_getValue(TOKEN_KEY, '')) || '';
    if (!token) {
      if (!warnedNoToken) {
        warnedNoToken = true;
        console.warn(
          '[gh-toolkit] Kein GitHub-Token gesetzt. Über das Tampermonkey-Menü "GitHub PAT für Sub-Issue-Labels setzen" hinterlegen.'
        );
      }
      return new Map();
    }

    if (inFlightKey === pageKey) {
      // einfacher Schutz gegen parallele Doppel-Requests derselben Seite
      await new Promise((r) => setTimeout(r, 300));
      const c2 = cache.get(pageKey);
      if (c2 && c2.refsKey === refsKey) return c2.labelsByKey;
    }
    inFlightKey = pageKey;

    try {
      const { query, aliasToRepo } = buildGraphQLQuery(refs);
      const json = await gmFetchJson('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          Authorization: `bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/vnd.github+json',
        },
        data: JSON.stringify({ query }),
      });

      if (json.errors) {
        // z.B. fehlende Berechtigung auf ein fremdes Repo -> restliche Daten trotzdem nutzen
        console.error('[gh-toolkit] GraphQL-Fehler:', json.errors);
      }

      const labelsByKey = new Map();
      const data = json.data || {};
      for (const { alias, owner, repo, numbers } of aliasToRepo) {
        const repoData = data[alias];
        if (!repoData) continue;
        for (const num of numbers) {
          const issueData = repoData[`i${num}`];
          if (issueData && issueData.labels) {
            labelsByKey.set(`${owner}/${repo}#${num}`.toLowerCase(), issueData.labels.nodes);
          }
        }
      }

      cache.set(pageKey, { ts: Date.now(), refsKey, labelsByKey });
      return labelsByKey;
    } catch (e) {
      console.error('[gh-toolkit] Request fehlgeschlagen:', e);
      return new Map();
    } finally {
      inFlightKey = null;
    }
  }

  function getOrCreateBadgeBox(li) {
    const scope = getRowScope(li);
    let box = scope.querySelector('[data-subissue-labels]');
    if (box) return box;

    const titleContainer = scope.querySelector('[data-nested-list-view-component="title-container"]');
    if (!titleContainer) return null;

    box = document.createElement('span');
    box.setAttribute('data-subissue-labels', '1');
    box.style.display = 'inline-flex';
    box.style.flexWrap = 'wrap';
    box.style.alignItems = 'center';
    box.style.gap = '4px';
    box.style.marginLeft = '8px';
    box.style.verticalAlign = 'middle';
    titleContainer.appendChild(box);
    return box;
  }

  function renderLabels(box, labels) {
    const visible = labels.filter(
      (label) =>
        !CONFIG.onlyHighlightedLabels ||
        label.name.startsWith(CONFIG.highlightPrefix) ||
        CONFIG.exactNamesToShow.includes(label.name)
    );
    // unnötige DOM-Mutationen vermeiden (sonst triggert der Observer endlos neu)
    const sig = visible.map((l) => l.name + ':' + l.color).join('|');
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.innerHTML = '';
    for (const label of visible) box.appendChild(buildLabelSpan(label));
  }

  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, CONFIG.scanDebounceMs);
  }

  async function scan() {
    const container = getSubIssueContainer();
    if (!container) return;
    const pageKey = getPageKey();
    if (!pageKey) return;

    // Key = owner/repo#num, damit gleiche Nummern aus verschiedenen Repos nicht kollidieren
    const rowsByKey = new Map();
    const refsByKey = new Map();
    for (const li of getSubIssueRows(container)) {
      const ref = getRowIssueRef(li);
      if (!ref) continue;
      if (!rowsByKey.has(ref.key)) rowsByKey.set(ref.key, []);
      rowsByKey.get(ref.key).push(li);
      refsByKey.set(ref.key, ref);
    }
    if (!refsByKey.size) return;

    const labelsByKey = await fetchLabelsForRefs(pageKey, [...refsByKey.values()]);
    if (!labelsByKey.size) return;

    for (const [key, lis] of rowsByKey) {
      const labels = labelsByKey.get(key);
      if (!labels) continue;
      for (const li of lis) {
        const box = getOrCreateBadgeBox(li);
        if (box) renderLabels(box, labels);
      }
    }
  }

  // ---------- Icons ----------

  // Octicons (16px)
  const ICON_SYNC =
    'M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z';
  const ICON_COPY =
    'M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z';
  const ICON_CHECK =
    'M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z';

  function buildIcon(d, size) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
  }

  // ---------- Copy-Button "<repo>#<nr>" (Issues + Pull Requests) ----------

  function formatRef(owner, repo, number) {
    return CONFIG.copyIncludeOwner ? `${owner}/${repo}#${number}` : `${repo}#${number}`;
  }

  async function copyText(text) {
    try {
      GM_setClipboard(text, 'text');
      return true;
    } catch (_) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (e) {
        console.error('[gh-toolkit] Kopieren fehlgeschlagen:', e);
        return false;
      }
    }
  }

  // getText wird erst beim Klick aufgerufen (GitHub verwendet Sidepane/Header beim Wechsel wieder)
  function buildCopyButton(getText, editBtn) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute(COPY_BTN_ATTR, '1');
    if (editBtn) {
      // Optik des "Edit title"-Buttons übernehmen (GitHubs Klassennamen sind gehasht)
      btn.className = editBtn.className;
      for (const k of ['data-component', 'data-size', 'data-variant', 'data-no-visuals', 'data-loading']) {
        if (editBtn.hasAttribute(k)) btn.setAttribute(k, editBtn.getAttribute(k));
      }
    } else {
      Object.assign(btn.style, {
        background: 'transparent',
        border: '0',
        padding: '4px',
        marginLeft: '4px',
        cursor: 'pointer',
        color: 'var(--fgColor-muted, #59636e)',
        verticalAlign: 'middle',
        lineHeight: '0',
      });
    }
    btn.appendChild(buildIcon(ICON_COPY, 16));

    let resetTimer = null;
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const text = getText();
      if (!text) return;
      const ok = await copyText(text);
      btn.replaceChildren(buildIcon(ok ? ICON_CHECK : ICON_COPY, 16));
      btn.style.color = ok ? 'var(--fgColor-success, #1a7f37)' : 'var(--fgColor-danger, #d1242f)';
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        btn.replaceChildren(buildIcon(ICON_COPY, 16));
        btn.style.color = editBtn ? '' : 'var(--fgColor-muted, #59636e)';
      }, 1500);
    });
    return btn;
  }

  function setCopyLabel(btn, text) {
    const label = `"${text}" kopieren`;
    if (btn.title !== label) {
      btn.title = label;
      btn.setAttribute('aria-label', label);
    }
  }

  // --- Issues: Hauptansicht UND Sub-Issue-Sidepane (Overlay mit eigenem issue-header) ---

  function getHeaderIssueText(header) {
    // Sidepane: Nummer ist ein Link auf das Sub-Issue; Hauptansicht: nur Text -> URL nehmen
    const link = header.querySelector('h1 a[href*="/issues/"]');
    const path = link ? new URL(link.getAttribute('href') || '', location.origin).pathname : location.pathname;
    const m = path.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    return m ? formatRef(m[1], m[2], m[3]) : null;
  }

  function ensureIssueCopyButtons() {
    for (const header of document.querySelectorAll('[data-testid="issue-header"]')) {
      const h1 = header.querySelector('h1');
      if (!h1) continue;
      const text = getHeaderIssueText(header);
      if (!text) continue;
      let btn = h1.querySelector(`[${COPY_BTN_ATTR}]`);
      if (!btn) {
        // Edit-Button fehlt, wenn man keine Schreibrechte aufs Repo hat -> Fallback hinter die Nummer
        const editBtn = h1.querySelector('[data-testid="edit-issue-title-button"]');
        btn = buildCopyButton(() => getHeaderIssueText(header), editBtn);
        if (editBtn) editBtn.parentElement.insertBefore(btn, editBtn);
        else (h1.querySelector(':scope > span') || h1).appendChild(btn);
      }
      setCopyLabel(btn, text);
    }
  }

  // --- Pull Requests: Titel-Header (und Sticky-Header beim Scrollen) ---

  function getPrRef() {
    const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    return m ? { owner: m[1], repo: m[2], number: m[3] } : null;
  }

  function getPrText() {
    const ref = getPrRef();
    return ref ? formatRef(ref.owner, ref.repo, ref.number) : null;
  }

  function ensurePrCopyButtons() {
    const ref = getPrRef();
    if (!ref) return;
    const text = formatRef(ref.owner, ref.repo, ref.number);
    const numRe = new RegExp(`#${ref.number}(?!\\d)`);

    // PR-Titel-h1 = ein h1 außerhalb von Kommentaren/Markdown, das "#<nr>" enthält
    for (const h1 of document.querySelectorAll('h1')) {
      if (h1.closest('.markdown-body, .comment-body, [data-testid="issue-header"]')) continue;
      if (!numRe.test(h1.textContent)) continue;

      let btn = h1.querySelector(`[${COPY_BTN_ATTR}]`);
      if (!btn) {
        btn = buildCopyButton(getPrText, null);
        // direkt hinter das Element mit "#<nr>" setzen, sonst ans Ende des h1
        const numEl = [...h1.querySelectorAll('span, a, bdi')]
          .reverse()
          .find((el) => el.textContent.trim() === `#${ref.number}`);
        if (numEl) numEl.after(btn);
        else h1.appendChild(btn);
      }
      setCopyLabel(btn, text);
    }
  }

  function ensureCopyButtons() {
    ensureIssueCopyButtons();
    ensurePrCopyButtons();
  }

  // ---------- Refresh-Bubble ----------

  let refreshing = false;

  async function manualRefresh(btn) {
    if (refreshing) return;
    refreshing = true;
    const icon = btn.firstChild;
    const spin = icon.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], {
      duration: 800,
      iterations: Infinity,
    });
    btn.style.opacity = '0.7';
    try {
      cache.clear();
      if (scanTimer) clearTimeout(scanTimer);
      await scan();
    } finally {
      spin.cancel();
      btn.style.opacity = '1';
      refreshing = false;
    }
  }

  function ensureRefreshButton() {
    let btn = document.getElementById(REFRESH_BTN_ID);
    const hasContainer = !!getSubIssueContainer();

    if (!btn) {
      if (!document.body) return;
      btn = document.createElement('button');
      btn.id = REFRESH_BTN_ID;
      btn.type = 'button';
      btn.title = 'Sub-Issue-Labels neu laden';
      btn.setAttribute('aria-label', 'Sub-Issue-Labels neu laden');
      Object.assign(btn.style, {
        position: 'fixed',
        right: '20px',
        bottom: '20px',
        width: '44px',
        height: '44px',
        borderRadius: '50%',
        border: '1px solid var(--borderColor-default, #d0d7de)',
        background: 'var(--bgColor-default, #ffffff)',
        color: 'var(--fgColor-default, #1f2328)',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0',
        zIndex: '9999',
        transition: 'opacity 0.15s',
      });
      btn.appendChild(buildIcon(ICON_SYNC, 20));
      btn.addEventListener('click', () => manualRefresh(btn));
      document.body.appendChild(btn);
    }

    // nur anzeigen, wenn die Seite überhaupt eine Sub-Issue-Liste hat
    const display = hasContainer ? 'flex' : 'none';
    if (btn.style.display !== display) btn.style.display = display;
  }

  // ---------- Observer ----------

  const listObserver = new MutationObserver(() => scheduleScan());
  let observedContainer = null;

  function ensureObserverAttached() {
    ensureRefreshButton();
    ensureCopyButtons();
    const container = getSubIssueContainer();
    if (container && container !== observedContainer) {
      listObserver.disconnect();
      listObserver.observe(container, { childList: true, subtree: true });
      observedContainer = container;
      scheduleScan();
    }
  }

  // pro Frame höchstens einmal prüfen, GitHub feuert sehr viele Mutationen
  let rafPending = false;
  function scheduleEnsure() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      ensureObserverAttached();
    });
  }

  // Der Sub-Issues-Bereich und das Sidepane laden asynchron nach; dauerhaft beobachten,
  // da GitHub zwischen Seiten per Turbo/PJAX ohne vollständigen Seitenreload wechselt.
  // @match ist deshalb github.com/* – sonst würde das Script beim Wechsel z.B. von der
  // PR-Liste in einen PR nicht geladen.
  const bodyObserver = new MutationObserver(() => scheduleEnsure());
  bodyObserver.observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener('turbo:load', () => {
    observedContainer = null;
    ensureObserverAttached();
  });
  document.addEventListener('pjax:end', () => {
    observedContainer = null;
    ensureObserverAttached();
  });

  ensureObserverAttached();
})();
