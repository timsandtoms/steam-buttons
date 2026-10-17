/* Steam Buttons – property inspector for the "Launch" action. */
(function () {
  'use strict';

  var SU = window.SteamUrl;

  var DEFAULT_CHIPS = ['-fullscreen', '-windowed', '-noborder', '-novid', '-novideo', '-console',
    '-w 1920', '-h 1080', '-dx11', '-dx12', '-vulkan', '-nojoy'];
  var SCOPES = ['installed', 'notinstalled', 'custom', 'all'];
  var ICON_STYLES = ['cover', 'fit', 'icon'];       // styles offered as the global default
  var CROP_MIN = 0.5, CROP_MAX = 4;               // zoom range of the custom crop (1 = fill the square)

  var PLACEHOLDER = {
    normal: 'Search your Steam library',
    custom: 'Enter the custom AppID here, for example 730'
  };

  var DEFAULT_GLOBAL = {
    defaultMethod: 'run',
    scope: 'installed',
    chips: DEFAULT_CHIPS.slice(),
    iconStyle: 'cover',
    steamPath: '',
    useProfile: false,
    cdn: true,
    customApps: []            // [{ id: '730', name: 'Counter-Strike 2' }]
  };

  var MAX_ROWS = 200;
  var MAX_CUSTOM = 200;
  var ICON_SIZE = 144;

  var state = {
    uuid: '', action: '', ws: null,
    settings: {},
    global: clone(DEFAULT_GLOBAL),
    libGames: [], games: [], meta: null, base: '', httpOk: null,
    loaded: false, scanning: false, scanTimer: null, scanNote: null, manualScan: false,
    open: false, active: -1, rows: [],
    editChips: false, initDone: false,
    cropOpen: false, crop: null,   // crop: { img, game, value: {x, y, z}, timer, drag }
    reqId: 0, iconSeq: 0, imgWaiters: {}, lookups: {}, customTimer: null, iconFor: null,
    saveTimer: null
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ------------------------------------------------------------ socket

  function send(obj) {
    if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj));
  }
  function toPlugin(payload) {
    send({ event: 'sendToPlugin', action: state.action, context: state.uuid, payload: payload });
  }

  window.connectElgatoStreamDeckSocket = function (port, uuid, registerEvent, info, actionInfo) {
    state.uuid = uuid;
    try {
      var ai = JSON.parse(actionInfo);
      state.action = ai.action;
      state.settings = (ai.payload && ai.payload.settings) || {};
    } catch (e) { /* keep defaults */ }

    state.ws = new WebSocket('ws://127.0.0.1:' + port);
    state.ws.onopen = function () {
      send({ event: registerEvent, uuid: uuid });
      send({ event: 'getGlobalSettings', context: uuid });
      // Some hosts never answer getGlobalSettings; don't wait forever.
      setTimeout(function () { init(true); }, 900);
    };
    state.ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      onMessage(msg);
    };
  };

  function onMessage(msg) {
    if (msg.event === 'didReceiveGlobalSettings') {
      mergeGlobal((msg.payload && msg.payload.settings) || {});
      if (state.initDone) { rebuildGames(); renderAll(); } else init(false);
    } else if (msg.event === 'didReceiveSettings') {
      var s = (msg.payload && msg.payload.settings) || {};
      if (document.activeElement !== $('url') && s.url !== undefined && s.url !== state.settings.url) {
        state.settings = s;
        renderAll();
      }
    } else if (msg.event === 'sendToPropertyInspector') {
      var p = msg.payload || {};
      if (p.event === 'library') onLibrary(p);
      else if (p.event === 'image') onImage(p);
      else if (p.event === 'custom') onCustom(p);
      else if (p.event === 'customInUse') onCustomInUse(p);
      else if (p.event === 'error') onPluginError(p);
    }
  }

  // ---------------------------------------------------------- settings

  function mergeGlobal(g) {
    var out = clone(DEFAULT_GLOBAL);
    if (typeof g.steamPath === 'string') out.steamPath = g.steamPath;
    if (typeof g.useProfile === 'boolean') out.useProfile = g.useProfile;
    if (typeof g.cdn === 'boolean') out.cdn = g.cdn;
    if (ICON_STYLES.indexOf(g.iconStyle) !== -1) out.iconStyle = g.iconStyle;
    if (SU.METHODS.indexOf(g.defaultMethod) !== -1) out.defaultMethod = g.defaultMethod;
    // Older versions stored defaultVerb ('launch' then meant launch + dialog) and showAll.
    if (g.defaultMethod === undefined && typeof g.defaultVerb === 'string') out.defaultMethod = g.defaultVerb === 'launch' ? 'dialog' : 'run';
    if (SCOPES.indexOf(g.scope) !== -1) out.scope = g.scope;
    else if (g.showAll === true) out.scope = 'all';
    if (Array.isArray(g.chips)) out.chips = g.chips.filter(function (c) { return typeof c === 'string' && c.trim(); });
    if (Array.isArray(g.customApps)) {
      out.customApps = g.customApps.filter(function (c) {
        return c && /^\d{1,10}$/.test(String(c.id)) && typeof c.name === 'string';
      }).map(function (c) { return { id: String(c.id), name: c.name }; }).slice(0, MAX_CUSTOM);
    }
    state.global = out;
  }

  function loadLocalGlobal() {
    try {
      var raw = window.localStorage.getItem('steam-buttons.global');
      if (raw) mergeGlobal(JSON.parse(raw));
    } catch (e) { /* storage unavailable */ }
  }

  function saveGlobal() {
    send({ event: 'setGlobalSettings', context: state.uuid, payload: state.global });
    try { window.localStorage.setItem('steam-buttons.global', JSON.stringify(state.global)); } catch (e) { /* ignore */ }
  }

  function saveSettings(now) {
    clearTimeout(state.saveTimer);
    var run = function () { send({ event: 'setSettings', context: state.uuid, payload: state.settings }); };
    if (now) run(); else state.saveTimer = setTimeout(run, 250);
  }

  // -------------------------------------------------------------- init

  function init(fromTimeout) {
    if (state.initDone) return;
    if (fromTimeout) loadLocalGlobal();
    state.initDone = true;
    // Buttons saved by older versions have no style of their own (''), so they would follow the
    // default. Pin the current default onto them so they stop changing with it.
    if (state.settings.selected && !state.settings.iconStyle) {
      state.settings.iconStyle = state.global.iconStyle;
      saveSettings(false);
    }
    rebuildGames();
    bind();
    renderAll();
    requestLibrary(false);
  }

  function renderAll() {
    $('url').value = state.settings.url || '';
    $('opt-default-method').value = state.global.defaultMethod;
    $('opt-icon-style').value = state.global.iconStyle;
    $('opt-steam-path').value = state.global.steamPath;
    $('opt-profile').checked = !!state.global.useProfile;
    $('opt-cdn').checked = !!state.global.cdn;
    renderScope(false);
    renderControls();
    renderCurrent();
    renderIconStyle();
    renderChipEditor();
    updateCount();
    if (state.open) renderList();
  }

  // ------------------------------------------------------- url controls

  function currentUrl() { return $('url').value.trim(); }

  function setUrl(url) {
    $('url').value = url;
    state.settings.url = url;
    renderControls();
    saveSettings(false);
  }

  function renderControls() {
    var url = currentUrl();
    var p = SU.parse(url);
    var method = SU.methodOf(p);
    SU.METHODS.forEach(function (m) {
      var b = $('method-' + m);
      b.disabled = !method;
      b.setAttribute('aria-pressed', String(method === m));
    });

    // Only explain the states where the buttons are unavailable; what each button does is in its tooltip.
    var hint = $('verb-hint');
    if (url && !p) hint.textContent = 'Not a steam://run, launch or rungameid URL, so options and switching are off. It will still be opened as written.';
    else if (p && p.verb === 'rungameid') hint.textContent = 'Non-Steam shortcut: run, launch and dialog don\u2019t apply.';
    else hint.textContent = '';

    var md = $('make-default');
    if (!method) { md.textContent = 'Default for new selections: ' + state.global.defaultMethod; md.disabled = true; }
    else if (method === state.global.defaultMethod) { md.textContent = '\u2713 Default for new selections'; md.disabled = true; }
    else { md.textContent = 'Make ' + method + ' the default?'; md.disabled = false; }

    $('clear-opts').disabled = !p || !p.args;
    renderChips();
  }

  function renderChips() {
    var box = $('chips');
    box.textContent = '';
    var url = currentUrl();
    var p = SU.parse(url);
    if (!state.global.chips.length) {
      box.appendChild(el('span', 'hint', 'No launch options yet. Use \u201cEdit list\u201d to add some.'));
      return;
    }
    state.global.chips.forEach(function (chip) {
      var b = el('button', 'chip', chip);
      b.type = 'button';
      b.disabled = !p;
      b.setAttribute('aria-pressed', String(!!p && SU.hasOption(url, chip)));
      b.addEventListener('click', function () { setUrl(SU.toggleOption(currentUrl(), chip)); });
      box.appendChild(b);
    });
  }

  function renderChipEditor() {
    $('chip-editor').hidden = !state.editChips;
    $('edit-chips').textContent = state.editChips ? 'Done' : 'Edit list';
    $('edit-chips').setAttribute('aria-expanded', String(state.editChips));
    if (!state.editChips) return;
    var rows = $('chip-rows');
    rows.textContent = '';
    state.global.chips.forEach(function (chip, i) {
      var row = el('div', 'editor-row');
      var input = el('input', 'mono');
      input.type = 'text';
      input.value = chip;
      input.spellcheck = false;
      input.setAttribute('aria-label', 'Launch option ' + (i + 1));
      input.addEventListener('change', function () {
        var v = input.value.trim();
        if (v) state.global.chips[i] = v; else state.global.chips.splice(i, 1);
        saveGlobal(); renderChips(); renderChipEditor();
      });
      var del = el('button', 'icon-btn', '\u00d7');
      del.type = 'button';
      del.setAttribute('aria-label', 'Remove ' + chip);
      del.addEventListener('click', function () {
        state.global.chips.splice(i, 1);
        saveGlobal(); renderChips(); renderChipEditor();
      });
      row.appendChild(input);
      row.appendChild(del);
      rows.appendChild(row);
    });
  }

  function addChip() {
    var input = $('chip-new');
    var v = input.value.trim();
    if (!v) return;
    if (state.global.chips.indexOf(v) === -1) state.global.chips.push(v);
    input.value = '';
    saveGlobal(); renderChips(); renderChipEditor();
    input.focus();
  }

  // ------------------------------------------------------- current pick

  function selectedGame() {
    var sel = state.settings.selected;
    if (!sel) return null;
    return state.games.filter(function (g) { return g.key === sel.key; })[0] || null;
  }

  function renderCurrent() {
    var sel = state.settings.selected;
    $('current-name').textContent = sel && sel.name ? sel.name : (SU.parse(currentUrl()) ? 'Custom URL' : 'Nothing selected');
    $('current-sub').textContent = state.settings.icon ? 'This icon is shown on the button.' : 'No icon set. Pick a title to use its icon.';
    var prev = $('key-preview');
    var ok = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(state.settings.icon || '');
    prev.style.backgroundImage = ok ? 'url("' + state.settings.icon + '")' : 'none';
  }

  function renderIconStyle() {
    var sel = $('icon-style');
    var game = selectedGame();
    sel.disabled = !game;
    sel.value = state.settings.iconStyle || state.global.iconStyle;
    $('icon-hint').textContent = game ? 'Applies to this button only.' : 'Pick a title above to choose how its icon looks.';
    var custom = !!game && sel.value === 'custom';
    $('crop').hidden = !(custom && state.cropOpen);
    $('crop-edit').hidden = !(custom && !state.cropOpen);
  }

  function syncSelectionFromUrl() {
    var p = SU.parse(currentUrl());
    if (!p || !state.games.length) return;
    var g = state.games.filter(function (x) { return x.id === p.id; })[0];
    if (g) state.settings.selected = { key: g.key, id: g.id, kind: g.kind, name: g.name };
    else if (state.settings.selected && state.settings.selected.id !== p.id) delete state.settings.selected;
    renderCurrent();
    renderIconStyle();
  }

  // ------------------------------------------------------------ library

  function libraryOptions() {
    return {
      steamPath: state.global.steamPath,
      useProfile: state.global.useProfile,
      cdn: state.global.cdn,
      customApps: state.global.customApps
    };
  }

  /**
   * The plugin keeps the scan for the whole session, so a plain request is normally
   * answered from its cache. Only refresh=true (the rescan button, or a changed
   * Steam folder / profile option) makes it read Steam again.
   */
  function requestLibrary(refresh) {
    state.scanning = true;
    state.manualScan = !!refresh;
    $('refresh').classList.add('busy');
    $('refresh').disabled = true;
    clearTimeout(state.scanNote);
    var note = function () {
      if (!state.scanning) return;
      setStatus('Scanning your Steam library\u2026');
      if (state.open && !state.loaded) renderList();
    };
    // A cached answer arrives almost instantly, so only announce a scan that takes a moment.
    if (refresh) note(); else state.scanNote = setTimeout(note, 350);
    toPlugin({ cmd: 'library', refresh: !!refresh, requestId: ++state.reqId, options: libraryOptions() });
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(function () {
      if (state.scanning) { finishScan(); setStatus('The scan is taking too long. Is the plugin running?'); }
    }, 30000);
  }

  function finishScan() {
    state.scanning = false;
    clearTimeout(state.scanTimer);
    clearTimeout(state.scanNote);
    $('refresh').classList.remove('busy');
    $('refresh').disabled = false;
  }

  var collator = (typeof Intl !== 'undefined' && Intl.Collator) ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }) : null;

  function norm(s) {
    return String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[\u2122\u00ae\u00a9:'\u2019"\-_.,!?&]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function makeGame(g) {
    return {
      key: g.key, kind: g.kind, id: g.id, name: g.name, installed: g.installed, custom: !!g.custom,
      hay: norm(g.name + ' ' + g.id)
    };
  }

  /** Library entries plus remembered custom AppIDs (unless the library already has that id). */
  function rebuildGames() {
    var seen = {};
    var games = state.libGames.map(function (g) { seen[g.id] = true; return makeGame(g); });
    state.global.customApps.forEach(function (c) {
      if (seen[c.id]) return;
      games.push(makeGame({ key: 'c' + c.id, kind: 'steam', id: c.id, name: c.name || ('AppID ' + c.id), installed: false, custom: true }));
    });
    games.sort(function (a, b) { return collator ? collator.compare(a.name, b.name) : (a.name < b.name ? -1 : 1); });
    state.games = games;
  }

  function onLibrary(p) {
    finishScan();
    state.meta = p.meta || {};
    state.base = p.base || '';
    state.libGames = p.games || [];
    rebuildGames();
    state.loaded = true;

    renderDiag();
    updateCount();
    var m = state.meta;
    if (m.error === 'not_found') {
      setStatus('Steam wasn\u2019t found. Open Settings and enter your Steam folder, then rescan.');
      $('settings').open = true;
    } else if (m.error === 'not_found_custom') {
      setStatus('That folder doesn\u2019t look like a Steam install (no steamapps or userdata inside).');
    } else if (m.warnings && m.warnings.length) {
      setStatus(m.warnings[0]);
    } else {
      setStatus(state.manualScan ? 'Rescanned.' : '');
    }
    state.manualScan = false;

    syncSelectionFromUrl();

    // Find out whether the web view can reach the plugin's artwork server.
    state.httpOk = null;
    probeHttp().then(function (ok) {
      state.httpOk = ok;
      if (state.open) renderList();
    });
    if (state.open) renderList();
  }

  function onPluginError(p) {
    if (p.cmd !== 'library') return;
    finishScan();
    setStatus('Could not scan Steam: ' + (p.message || 'unknown error'));
  }

  function probeHttp() {
    if (!state.base || typeof fetch !== 'function') return Promise.resolve(false);
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 1500);
    return fetch(state.base + '/ping', ctl ? { signal: ctl.signal } : {})
      .then(function (r) { clearTimeout(timer); return r.ok; })
      .catch(function () { clearTimeout(timer); return false; });
  }

  function renderDiag() {
    var m = state.meta || {};
    var lines = [];
    lines.push('Steam folder: ' + (m.steamRoot || 'not found'));
    if (m.user) lines.push('Steam account read: ' + (m.user.name || '(unnamed)') + ' [' + m.user.accountId + '] (most recent sign-in)');
    if (m.counts) {
      lines.push('Library folders: ' + m.libraryFolders);
      lines.push('Installed: ' + m.counts.installed + ', not installed: ' + m.counts.notInstalled + ', non-Steam: ' + m.counts.nonSteam);
      lines.push('appinfo.vdf entries read: ' + m.appInfoEntries);
    }
    if (m.scannedAt) lines.push('Scanned: ' + new Date(m.scannedAt).toLocaleTimeString() + ' (' + m.scanMs + ' ms), kept until you rescan or restart OpenDeck');
    (m.warnings || []).forEach(function (w) { lines.push('Warning: ' + w); });
    $('diag').textContent = lines.join('\n');
  }

  function setStatus(text) { $('status').textContent = text || ''; }

  /** One line of counts, shown beside the scope buttons. */
  function updateCount() {
    var box = $('count');
    if (!state.loaded) { box.textContent = ''; return; }
    var inst = 0, not = 0, cust = 0;
    state.games.forEach(function (g) {
      if (g.custom) cust++; else if (g.installed) inst++; else not++;
    });
    box.textContent = inst + ' installed \u00b7 ' + not + ' not installed \u00b7 ' + cust + ' custom \u00b7 ' + state.games.length + ' total';
  }

  // -------------------------------------------------------------- scope

  function renderScope(flash) {
    var scope = state.global.scope;
    SCOPES.forEach(function (s) { $('scope-' + s).setAttribute('aria-pressed', String(scope === s)); });
    $('clear-custom').hidden = scope !== 'custom';
    var search = $('search');
    search.placeholder = scope === 'custom' ? PLACEHOLDER.custom : PLACEHOLDER.normal;
    search.setAttribute('inputmode', scope === 'custom' ? 'numeric' : 'text');
    if (flash && scope === 'custom') flashSearch();
  }

  function flashSearch() {
    var s = $('search');
    s.classList.remove('flash');
    void s.offsetWidth; // restart the animation
    s.classList.add('flash');
    s.addEventListener('animationend', function done() { s.classList.remove('flash'); s.removeEventListener('animationend', done); });
  }

  function setScope(scope) {
    var before = state.global.scope;
    if (before === scope) { if (scope === 'custom') { $('search').focus(); openList(); } return; }
    state.global.scope = scope;
    // The search box holds text in most scopes but an AppID in Custom, so don't carry it across.
    if ((before === 'custom') !== (scope === 'custom')) $('search').value = '';
    saveGlobal();
    renderScope(true);
    state.active = 0;
    if (scope === 'custom') { $('search').focus(); openList(); }
    if (state.open) renderList();
  }

  // --------------------------------------------------------------- list

  function parseAppId(text) {
    var t = String(text || '').trim();
    var m = /^(\d{1,10})$/.exec(t) || /\/(?:app|run|launch)\/(\d{1,10})(?:[\/?#]|$)/.exec(t);
    if (!m) return null;
    var n = Number(m[1]);
    return n > 0 && n <= 4294967295 ? String(n) : null;
  }

  function inScope(g, scope) {
    if (scope === 'installed') return g.installed && !g.custom;
    if (scope === 'notinstalled') return !g.installed && !g.custom;
    if (scope === 'custom') return g.custom;
    return true;
  }

  function queryTokens() { return norm($('search').value).split(' ').filter(Boolean); }

  function matches(g, tokens) {
    for (var i = 0; i < tokens.length; i++) if (g.hay.indexOf(tokens[i]) === -1) return false;
    return true;
  }

  /** @returns {{rows: object[], notes: string[]}} */
  function buildRows() {
    var scope = state.global.scope;
    var text = $('search').value;
    if (scope !== 'custom') {
      var tokens = queryTokens();
      var rows = state.games.filter(function (g) { return inScope(g, scope) && matches(g, tokens); });
      var notes = [];
      if (!rows.length) {
        var msg = 'No matches.';
        if (!state.games.length) msg = 'Nothing found in your Steam library.';
        else if (tokens.length && scope !== 'all') {
          var others = state.games.filter(function (g) { return !inScope(g, scope) && matches(g, tokens); }).length;
          if (others) msg = 'No match here. ' + others + ' more ' + (others === 1 ? 'title matches' : 'titles match') + ' under other filters, or switch to \u201cEverything\u201d.';
        }
        notes.push(msg);
      }
      return { rows: rows, notes: notes };
    }

    // Custom: the box takes an AppID. Show that AppID first, then the remembered custom entries.
    var result = { rows: [], notes: [] };
    var id = parseAppId(text);
    var existing = id && state.games.filter(function (g) { return g.id === id; })[0];
    if (id && existing) {
      result.rows.push(existing);
    } else if (id) {
      var look = state.lookups[id];
      if (look && look.state === 'done') {
        var cand = makeGame({ key: 'c' + id, kind: 'steam', id: id, name: look.name || ('AppID ' + id), installed: false, custom: true });
        cand.candidate = true;
        cand.noArt = !look.hasArt;
        result.rows.push(cand);
      } else {
        result.notes.push('Looking up AppID ' + id + '\u2026');
      }
    } else if (text.trim()) {
      result.notes.push('Enter a number such as 730, or paste a store.steampowered.com/app/\u2026 link.');
    }
    var q = norm(text);
    state.games.forEach(function (g) {
      if (!g.custom || g === existing) return;
      if (!q || (id ? g.id.indexOf(id) === 0 : g.hay.indexOf(q) !== -1)) result.rows.push(g);
    });
    if (!result.rows.length && !result.notes.length) {
      result.notes.push('Type an AppID above to add one. Custom AppIDs you use are remembered here.');
    }
    return result;
  }

  var observer = null;

  function renderList() {
    var list = $('list');
    list.textContent = '';
    if (observer) observer.disconnect();
    if (typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) { observer.unobserve(e.target); loadThumb(e.target); }
        });
      }, { root: list, rootMargin: '120px' });
    } else observer = null;

    if (!state.loaded && state.global.scope !== 'custom') {
      list.appendChild(el('li', 'note', 'Scanning your Steam library\u2026'));
      state.rows = [];
      return;
    }

    var built = buildRows();
    state.rows = built.rows;
    built.notes.forEach(function (n) { list.appendChild(el('li', 'note', n)); });

    var shown = built.rows.slice(0, MAX_ROWS);
    var selKey = state.settings.selected && state.settings.selected.key;
    shown.forEach(function (g, i) {
      var li = el('li', (g.installed ? '' : 'dim') + (g.candidate ? ' candidate' : ''));
      li.id = 'opt-' + i;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(g.key === selKey));
      li.dataset.index = String(i);
      li.dataset.key = g.key;

      var img = el('img', 'thumb empty');
      img.alt = '';
      img.width = 28; img.height = 28;
      li.appendChild(img);

      var text = el('div', 'item-text');
      text.appendChild(el('div', 'title', g.name));
      var tags = [];
      if (g.candidate) tags.push(['New custom AppID ' + g.id + (g.noArt ? ' \u00b7 no artwork found' : ''), '']);
      else if (g.custom) tags.push(['Custom AppID ' + g.id, '']);
      if (g.kind === 'nonsteam') tags.push(['Non-Steam', '']);
      if (!g.installed && !g.custom) tags.push(['Not installed', 'tag-off']);
      if (tags.length) {
        var t = el('div', 'tags');
        tags.forEach(function (tag, n) {
          if (n) t.appendChild(document.createTextNode(' \u00b7 '));
          t.appendChild(el('span', tag[1], tag[0]));
        });
        text.appendChild(t);
      }
      li.appendChild(text);
      li.title = g.name;
      list.appendChild(li);
      if (observer) observer.observe(li); else loadThumb(li);
    });
    if (built.rows.length > MAX_ROWS) {
      list.appendChild(el('li', 'note', 'Showing the first ' + MAX_ROWS + ' of ' + built.rows.length + '. Keep typing to narrow it down.'));
    }
    setActive(shown.length ? Math.min(Math.max(state.active, 0), shown.length - 1) : -1, false);
  }

  function loadThumb(li) {
    var img = li.querySelector('img');
    var key = li.dataset.key;
    if (!img || !key) return;
    img.onload = function () { img.classList.remove('empty'); };
    function viaSocket() {
      requestImage(key, 'thumb').then(function (url) {
        if (url) img.src = url; else img.classList.add('empty');
      });
    }
    if (!state.base || state.httpOk === false) { viaSocket(); return; }
    // The reachability probe may still be running; if it later fails the list is redrawn.
    img.onerror = function () { if (state.httpOk === false) viaSocket(); else img.classList.add('empty'); };
    img.src = state.base + '/img/' + encodeURIComponent(key) + '/thumb';
  }

  function setActive(i, scroll) {
    var items = $('list').querySelectorAll('li[role="option"]');
    state.active = i;
    Array.prototype.forEach.call(items, function (li, n) { li.classList.toggle('active', n === i); });
    var cur = items[i];
    $('search').setAttribute('aria-activedescendant', cur ? cur.id : '');
    if (cur && scroll !== false && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }

  function openList() {
    if (state.open) return;
    state.open = true;
    $('list').hidden = false;
    $('search').setAttribute('aria-expanded', 'true');
    renderList();
  }

  function closeList() {
    state.open = false;
    $('list').hidden = true;
    $('search').setAttribute('aria-expanded', 'false');
    $('search').setAttribute('aria-activedescendant', '');
  }

  // ---------------------------------------------------- custom AppIDs

  function lookupCustom(id) {
    if (state.lookups[id]) return;
    state.lookups[id] = { state: 'pending' };
    toPlugin({ cmd: 'custom', id: id, options: { steamPath: state.global.steamPath, cdn: state.global.cdn } });
    setTimeout(function () {
      var l = state.lookups[id];
      if (l && l.state === 'pending') {
        state.lookups[id] = { state: 'done', name: null, hasArt: false };
        if (state.open && state.global.scope === 'custom') renderList();
      }
    }, 15000);
  }

  function onCustom(p) {
    state.lookups[p.id] = p.invalid ? { state: 'done', name: null, hasArt: false } : { state: 'done', name: p.name || null, hasArt: !!p.hasArt };
    if (state.open && state.global.scope === 'custom') renderList();
  }

  function rememberCustom(game) {
    var list = state.global.customApps;
    if (list.some(function (c) { return c.id === game.id; })) return;
    var name = game.name === 'AppID ' + game.id ? '' : game.name;
    list.push({ id: game.id, name: name });
    if (list.length > MAX_CUSTOM) list.shift();
    saveGlobal();
    rebuildGames();
    updateCount();
  }

  function onCustomInUse(p) {
    var keep = {};
    (p.ids || []).forEach(function (id) { keep[id] = true; });
    var sel = state.settings.selected;
    if (sel && String(sel.key).charAt(0) === 'c') keep[String(sel.key).slice(1)] = true;
    var before = state.global.customApps.length;
    state.global.customApps = state.global.customApps.filter(function (c) { return keep[c.id]; });
    var removed = before - state.global.customApps.length;
    if (removed) { saveGlobal(); rebuildGames(); updateCount(); if (state.open) renderList(); }
    setStatus(removed ? 'Removed ' + removed + ' unused custom AppID' + (removed === 1 ? '' : 's') + '.' : 'No unused custom AppIDs to remove.');
  }

  // ------------------------------------------------------------ artwork

  function requestImage(key, kind) {
    return new Promise(function (resolve) {
      var k = key + '|' + kind;
      var first = !state.imgWaiters[k];
      (state.imgWaiters[k] = state.imgWaiters[k] || []).push(resolve);
      if (first) {
        toPlugin({ cmd: 'image', key: key, kind: kind });
        setTimeout(function () { settleImage(key, kind, null); }, 15000);
      }
    });
  }

  function settleImage(key, kind, dataUrl) {
    var k = key + '|' + kind;
    var waiting = state.imgWaiters[k];
    if (!waiting) return;
    delete state.imgWaiters[k];
    waiting.forEach(function (fn) { fn(dataUrl); });
  }

  function onImage(p) { settleImage(p.key, p.kind, p.dataUrl || null); }

  function loadImage(game, kind) {
    return new Promise(function (resolve, reject) {
      function fromSocket() {
        requestImage(game.key, kind).then(function (url) {
          if (!url) return reject(new Error('no artwork'));
          var im = new Image();
          im.onload = function () { resolve(im); };
          im.onerror = function () { reject(new Error('bad image')); };
          im.src = url;
        });
      }
      if (state.httpOk === false || !state.base) return fromSocket();
      var im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = function () { resolve(im); };
      im.onerror = function () { if (state.httpOk === false) fromSocket(); else reject(new Error('no artwork')); };
      im.src = state.base + '/img/' + encodeURIComponent(game.key) + '/' + kind;
    });
  }

  function compose(img, style) {
    var S = ICON_SIZE;
    var canvas = document.createElement('canvas');
    canvas.width = canvas.height = S;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, S, S);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    var small = Math.max(w, h) <= 128;
    if (style === 'custom') {
      drawCrop(ctx, img, normalizeCrop(state.settings.crop) || defaultCrop(img), S);
    } else if (style === 'fit' || (style === 'icon' && small)) {
      var k = Math.min(S / w, S / h);
      ctx.drawImage(img, (S - w * k) / 2, (S - h * k) / 2, w * k, h * k);
    } else {
      var side = Math.min(w, h);
      var sx = (w - side) / 2;
      var sy = (h - side) * 0.25; // favour the top of tall cover art, where the title usually sits
      ctx.drawImage(img, sx, sy, side, side, 0, 0, S, S);
    }
    return canvas.toDataURL('image/jpeg', 0.92);
  }

  function iconFor(game, style) {
    return loadImage(game, style === 'icon' ? 'icon' : 'portrait').then(function (img) { return compose(img, style); });
  }

  // ---------------------------------------------------- custom crop

  function imgSize(img) { return { w: img.naturalWidth || img.width, h: img.naturalHeight || img.height }; }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /** Wraps a rotation in degrees into (-180, 180]. */
  function wrapDeg(r) { return ((((r + 180) % 360) + 360) % 360) - 180; }

  /** Validates a stored crop ({ x, y, z, r }: centre as a fraction of the image, zoom 1 = fill the square, r = rotation in degrees). */
  function normalizeCrop(c) {
    if (!c || typeof c !== 'object') return null;
    var x = Number(c.x), y = Number(c.y), z = Number(c.z), r = Number(c.r || 0);
    if (!isFinite(x) || !isFinite(y) || !isFinite(z) || !isFinite(r)) return null;
    return { x: clamp(x, 0, 1), y: clamp(y, 0, 1), z: clamp(z, CROP_MIN, CROP_MAX), r: wrapDeg(r) };
  }

  /** The crop the "cropped to a square" style uses, so the editor starts from what the button already shows. */
  function defaultCrop(img) {
    var d = imgSize(img);
    var side = Math.min(d.w, d.h);
    return { x: 0.5, y: d.h > side ? ((d.h - side) * 0.25 + side / 2) / d.h : 0.5, z: 1, r: 0 };
  }

  /**
   * Paints the crop square onto ctx at S x S, rotated by crop.r degrees. Areas outside the
   * picture (zoom < 1, or rotation exposing a corner past the image edge) stay black.
   */
  function drawCrop(ctx, img, crop, S) {
    var d = imgSize(img);
    var theta = ((crop.r || 0) * Math.PI) / 180;
    // A square rotated by theta needs to be this many times bigger to still fully cover an
    // axis-aligned square of the same centre - i.e. how much extra source image to sample.
    var k = Math.abs(Math.cos(theta)) + Math.abs(Math.sin(theta));
    var side = (Math.min(d.w, d.h) / crop.z) * k;
    var big = S * k;
    var sx = crop.x * d.w - side / 2, sy = crop.y * d.h - side / 2;
    var x0 = Math.max(sx, 0), y0 = Math.max(sy, 0);
    var x1 = Math.min(sx + side, d.w), y1 = Math.min(sy + side, d.h);
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, S, S);
    if (x1 > x0 && y1 > y0) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.translate(S / 2, S / 2);
      if (theta) ctx.rotate(theta);
      ctx.translate(-big / 2, -big / 2);
      ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0,
        (x0 - sx) / side * big, (y0 - sy) / side * big, (x1 - x0) / side * big, (y1 - y0) / side * big);
    }
    ctx.restore();
  }

  function roundCrop(c) {
    return {
      x: Math.round(c.x * 10000) / 10000, y: Math.round(c.y * 10000) / 10000,
      z: Math.round(c.z * 1000) / 1000, r: Math.round(c.r * 10) / 10
    };
  }

  function drawCropPreview() {
    var c = state.crop;
    var canvas = $('crop-canvas');
    if (!c || !canvas.getContext) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawCrop(ctx, c.img, c.value, canvas.width);
    $('crop-zoom').value = String(Math.round(c.value.z * 100));
    $('crop-rotate').value = String(Math.round(c.value.r));
  }

  /** Writes the crop into the button's settings and re-composes the key icon from it. */
  function commitCrop() {
    var c = state.crop;
    if (!c) return;
    clearTimeout(c.timer);
    state.iconFor = ++state.iconSeq; // supersede any icon compose still in flight
    state.settings.iconStyle = 'custom';
    state.settings.crop = roundCrop(c.value);
    state.settings.icon = compose(c.img, 'custom');
    renderCurrent();
    saveSettings(true);
  }

  function scheduleCrop() {
    var c = state.crop;
    if (!c) return;
    clearTimeout(c.timer);
    c.timer = setTimeout(commitCrop, 250);
  }

  function closeCrop() {
    if (state.crop) commitCrop();
    state.cropOpen = false;
    state.crop = null;
    renderIconStyle();
  }

  /** Opens the editor for the selected title. Resolves true when it opened, false when there is no artwork, null if superseded. */
  function openCrop(game) {
    var stamp = ++state.iconSeq;
    state.iconFor = stamp;
    $('current').classList.add('busy');
    return loadImage(game, 'portrait').then(function (img) {
      if (state.iconFor !== stamp) return null; // superseded by another action
      $('current').classList.remove('busy');
      state.crop = { img: img, game: game.key, value: normalizeCrop(state.settings.crop) || defaultCrop(img), timer: null, drag: null };
      state.cropOpen = true;
      renderIconStyle();
      drawCropPreview();
      commitCrop();
      return true;
    }).catch(function () {
      if (state.iconFor === stamp) $('current').classList.remove('busy');
      setStatus('No cover art found for \u201c' + game.name + '\u201d, so it can\u2019t be cropped.');
      return false;
    });
  }

  /**
   * Moves the crop by (dx, dy) - a fraction of the *picture on screen* moving in that direction,
   * i.e. pressing the right arrow moves the picture right, the same way dragging it does. Positive
   * dz multiplies the zoom in; a truthy dr rotates by that many degrees.
   */
  function nudgeCrop(dx, dy, dz, dr) {
    var c = state.crop;
    if (!c) return;
    var d = imgSize(c.img);
    var side = Math.min(d.w, d.h) / c.value.z;
    if (dx) c.value.x = clamp(c.value.x - dx * side / d.w, 0, 1);
    if (dy) c.value.y = clamp(c.value.y - dy * side / d.h, 0, 1);
    if (dz) c.value.z = clamp(c.value.z * dz, CROP_MIN, CROP_MAX);
    if (dr) c.value.r = wrapDeg(c.value.r + dr);
    drawCropPreview();
    scheduleCrop();
  }

  function bindCrop() {
    var canvas = $('crop-canvas');

    canvas.addEventListener('pointerdown', function (e) {
      if (!state.crop) return;
      state.crop.drag = { x: e.clientX, y: e.clientY };
      canvas.classList.add('dragging');
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', function (e) {
      var c = state.crop;
      if (!c || !c.drag) return;
      var rect = canvas.getBoundingClientRect();
      if (!rect.width) return;
      // Dragging the picture right/down moves it right/down, the same distance the pointer moved.
      nudgeCrop((e.clientX - c.drag.x) / rect.width, (e.clientY - c.drag.y) / rect.height, 0);
      c.drag = { x: e.clientX, y: e.clientY };
    });
    function endDrag() {
      var c = state.crop;
      canvas.classList.remove('dragging');
      if (c && c.drag) { c.drag = null; commitCrop(); }
    }
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    canvas.addEventListener('wheel', function (e) {
      if (!state.crop) return;
      e.preventDefault();
      nudgeCrop(0, 0, e.deltaY < 0 ? 1.1 : 1 / 1.1);
    }, { passive: false });

    // Directional pad and zoom +/- buttons: fire once on click, then repeat while held.
    function repeatable(el, fire) {
      var timer = null, delay = null;
      function stop() {
        clearTimeout(timer);
        timer = null;
        if (delay !== null) commitCrop();
        delay = null;
      }
      function tick(first) {
        fire();
        delay = first ? 450 : Math.max(60, delay * 0.85);
        timer = setTimeout(function () { tick(false); }, delay);
      }
      el.addEventListener('pointerdown', function (e) {
        if (!state.crop || e.button > 0) return;
        e.preventDefault();
        delay = 0;
        tick(true);
      });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) { el.addEventListener(ev, stop); });
    }
    var STEP = 0.02, ROT_STEP = 2;
    // Each button moves (or rotates) the picture itself in the direction shown, the same way
    // dragging it would - not the viewing window.
    repeatable($('crop-left'), function () { nudgeCrop(-STEP, 0, 0); });
    repeatable($('crop-right'), function () { nudgeCrop(STEP, 0, 0); });
    repeatable($('crop-up'), function () { nudgeCrop(0, -STEP, 0); });
    repeatable($('crop-down'), function () { nudgeCrop(0, STEP, 0); });
    repeatable($('crop-zoom-in'), function () { nudgeCrop(0, 0, 1.05); });
    repeatable($('crop-zoom-out'), function () { nudgeCrop(0, 0, 1 / 1.05); });
    repeatable($('crop-rotate-cw'), function () { nudgeCrop(0, 0, 0, ROT_STEP); });
    repeatable($('crop-rotate-ccw'), function () { nudgeCrop(0, 0, 0, -ROT_STEP); });
    $('crop-center').addEventListener('click', function () {
      var c = state.crop;
      if (!c) return;
      c.value.x = 0.5;
      c.value.y = 0.5;
      drawCropPreview();
      commitCrop();
    });
    $('crop-center-h').addEventListener('click', function () {
      var c = state.crop;
      if (!c) return;
      c.value.x = 0.5;
      drawCropPreview();
      commitCrop();
    });
    $('crop-center-v').addEventListener('click', function () {
      var c = state.crop;
      if (!c) return;
      c.value.y = 0.5;
      drawCropPreview();
      commitCrop();
    });

    $('crop-zoom').addEventListener('input', function (e) {
      var c = state.crop;
      if (!c) return;
      c.value.z = clamp(Number(e.target.value) / 100, CROP_MIN, CROP_MAX);
      drawCropPreview();
      scheduleCrop();
    });
    $('crop-rotate').addEventListener('input', function (e) {
      var c = state.crop;
      if (!c) return;
      c.value.r = wrapDeg(Number(e.target.value));
      drawCropPreview();
      scheduleCrop();
    });
    $('crop-reset').addEventListener('click', function () {
      var c = state.crop;
      if (!c) return;
      c.value = defaultCrop(c.img);
      drawCropPreview();
      commitCrop();
    });
    $('crop-done').addEventListener('click', closeCrop);
    $('crop-edit').addEventListener('click', function () {
      var game = selectedGame();
      if (game) openCrop(game);
    });
  }

  function applyIconFor(game) {
    var box = $('current');
    box.classList.add('busy');
    var style = state.settings.iconStyle || state.global.iconStyle;
    var stamp = ++state.iconSeq;
    state.iconFor = stamp;
    return iconFor(game, style).then(function (dataUrl) {
      if (state.iconFor !== stamp) return;
      state.settings.icon = dataUrl;
    }).catch(function () {
      if (state.iconFor !== stamp) return;
      state.settings.icon = '';
      setStatus('No artwork found for \u201c' + game.name + '\u201d, so the button keeps its default icon.');
    }).then(function () {
      if (state.iconFor !== stamp) return;
      box.classList.remove('busy');
      renderCurrent();
      saveSettings(true);
    });
  }

  // ------------------------------------------------------------- choose

  function choose(game) {
    closeList();
    if (game.custom) {
      rememberCustom(game);
      game = state.games.filter(function (g) { return g.key === game.key; })[0] || game;
    }
    $('search').value = '';
    state.settings.selected = { key: game.key, id: game.id, kind: game.kind, name: game.name };
    // New entries start from the current default, then keep their own style: later changes to the
    // default must not touch this button.
    state.settings.iconStyle = state.global.iconStyle;
    delete state.settings.crop; // a crop belongs to the title it was made for
    if (state.crop) clearTimeout(state.crop.timer);
    state.crop = null;
    state.cropOpen = false;
    setUrl(SU.forGame(game, state.global.defaultMethod));
    renderCurrent();
    renderIconStyle();
    saveSettings(true);
    applyIconFor(game);
  }

  // ------------------------------------------------------------- events

  function bind() {
    var url = $('url');
    url.addEventListener('input', function () {
      state.settings.url = url.value.trim();
      renderControls();
      syncSelectionFromUrl();
      saveSettings(false);
    });

    SU.METHODS.forEach(function (m) {
      $('method-' + m).addEventListener('click', function () { setUrl(SU.setMethod(currentUrl(), m)); });
    });
    $('make-default').addEventListener('click', function () {
      var method = SU.methodOf(currentUrl());
      if (!method) return;
      state.global.defaultMethod = method;
      $('opt-default-method').value = method;
      saveGlobal();
      renderControls();
    });

    $('clear-opts').addEventListener('click', function () { setUrl(SU.clearOptions(currentUrl())); });
    $('edit-chips').addEventListener('click', function () { state.editChips = !state.editChips; renderChipEditor(); });
    $('chip-add').addEventListener('click', addChip);
    $('chip-new').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addChip(); } });
    $('chip-reset').addEventListener('click', function () {
      state.global.chips = DEFAULT_CHIPS.slice();
      saveGlobal(); renderChips(); renderChipEditor();
    });

    // per-button icon style
    $('icon-style').addEventListener('change', function (e) {
      var game = selectedGame();
      if (!game) return;
      var previous = state.settings.iconStyle || state.global.iconStyle;
      var next = e.target.value;
      if (state.crop) { clearTimeout(state.crop.timer); state.crop = null; }
      state.cropOpen = false;
      if (next === 'custom') {
        // Keep any crop made earlier for this button; the editor opens once the artwork has loaded.
        state.settings.iconStyle = 'custom';
        openCrop(game).then(function (ok) {
          if (ok !== false) return;
          state.settings.iconStyle = previous; // no artwork to crop: keep what was there
          renderIconStyle();
          saveSettings(true);
        });
        renderIconStyle();
        return;
      }
      state.settings.iconStyle = next;
      renderIconStyle();
      saveSettings(true);
      applyIconFor(game);
    });
    bindCrop();

    // picker
    var search = $('search');
    search.addEventListener('focus', openList);
    search.addEventListener('click', openList);
    search.addEventListener('input', function () {
      state.active = 0;
      if (state.global.scope === 'custom') {
        clearTimeout(state.customTimer);
        state.customTimer = setTimeout(function () {
          var id = parseAppId(search.value);
          if (id && !state.games.some(function (g) { return g.id === id; })) lookupCustom(id);
        }, 250);
      }
      if (!state.open) openList(); else renderList();
    });
    search.addEventListener('keydown', function (e) {
      var count = $('list').querySelectorAll('li[role="option"]').length;
      if (e.key === 'ArrowDown') { e.preventDefault(); if (!state.open) openList(); else setActive(Math.min(state.active + 1, count - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(state.active - 1, 0)); }
      else if (e.key === 'Enter') {
        if (state.open && state.active >= 0 && state.rows[state.active]) { e.preventDefault(); choose(state.rows[state.active]); }
      } else if (e.key === 'Escape') { if (state.open) { e.preventDefault(); closeList(); } }
    });
    $('list').addEventListener('click', function (e) {
      var li = e.target.closest ? e.target.closest('li[role="option"]') : null;
      if (li) choose(state.rows[Number(li.dataset.index)]);
    });
    document.addEventListener('mousedown', function (e) {
      if (state.open && !$('picker').contains(e.target)) closeList();
    });

    $('refresh').addEventListener('click', function () { requestLibrary(true); });

    Array.prototype.forEach.call(document.querySelectorAll('[data-scope]'), function (b) {
      b.addEventListener('click', function () { setScope(b.dataset.scope); });
    });
    $('clear-custom').addEventListener('click', function () { toPlugin({ cmd: 'customInUse' }); });

    // settings
    $('opt-default-method').addEventListener('change', function (e) { state.global.defaultMethod = e.target.value; saveGlobal(); renderControls(); });
    $('opt-icon-style').addEventListener('change', function (e) { state.global.iconStyle = e.target.value; saveGlobal(); renderIconStyle(); });
    $('opt-steam-path').addEventListener('change', function (e) { state.global.steamPath = e.target.value.trim(); saveGlobal(); requestLibrary(true); });
    $('opt-profile').addEventListener('change', function (e) { state.global.useProfile = e.target.checked; saveGlobal(); requestLibrary(true); });
    $('opt-cdn').addEventListener('change', function (e) { state.global.cdn = e.target.checked; saveGlobal(); });
  }
})();
