/*
 * Steam Buttons - steam:// URL helpers.
 *
 * Loaded by the property inspector (as a plain <script>) and required by the
 * plugin backend, so the logic that rewrites URLs lives in exactly one place.
 *
 * URL shapes understood (grammar: <verb>/<id>[/<mode>]/<language>/<args>/):
 *   steam://run/<appid>                          "run"
 *   steam://run/<appid>//<args>/                 run with launch options
 *   steam://launch/<appid>                       "launch"
 *   steam://launch/<appid>/dialog                "dialog" (launch-option picker)
 *   steam://launch/<appid>/<mode>//<args>/       launch/dialog with launch options
 *   steam://rungameid/<gameid>[//<args>/]        non-Steam shortcuts (64-bit game id)
 *
 * Switching between run / launch / dialog only touches the verb and the mode
 * segment. The language segment and the launch options are carried over as-is.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SteamUrl = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var URL_RE = /^steam:\/\/(run|launch|rungameid)\/(\d+)(.*)$/i;
  var METHODS = ['run', 'launch', 'dialog'];

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  // Encode only what would break a launch-options segment. Existing %XX is kept.
  function encodeArgs(args) {
    return String(args).replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@]/g, function (ch) {
      return encodeURIComponent(ch);
    });
  }

  /** Split a launch-option string on spaces, keeping "quoted strings" together. */
  function tokenize(str) {
    var out = [];
    var re = /"[^"]*"|\S+/g;
    var m;
    while ((m = re.exec(String(str || '')))) out.push(m[0]);
    return out;
  }

  /** @returns {null | {verb, id, mode, lang, args}} */
  function parse(url) {
    var m = URL_RE.exec(String(url || '').trim());
    if (!m) return null;
    var verb = m[1].toLowerCase();
    var id = m[2];
    var rest = m[3] || '';
    var segs = rest === '' ? [] : rest.replace(/^\//, '').split('/');
    var mode = '';
    if (verb === 'launch') mode = segs.length ? safeDecode(segs.shift()) : '';
    var lang = segs.length ? safeDecode(segs[0]) : '';
    var args = segs.length > 1 ? safeDecode(segs[1]) : '';
    return { verb: verb, id: id, mode: mode, lang: lang, args: args };
  }

  function build(p) {
    var url = 'steam://' + p.verb + '/' + p.id;
    var args = (p.args || '').trim();
    var lang = p.lang || '';
    var tail = !!(args || lang);
    if (p.verb === 'launch' && (p.mode || tail)) url += '/' + encodeArgs(p.mode || '');
    if (tail) url += '/' + encodeArgs(lang) + '/' + encodeArgs(args) + '/';
    return url;
  }

  /** 'run' | 'launch' | 'dialog', or null when the URL has no such choice (non-Steam / not a Steam URL). */
  function methodOf(url) {
    var p = typeof url === 'string' ? parse(url) : url;
    if (!p || p.verb === 'rungameid') return null;
    if (p.verb === 'run') return 'run';
    return String(p.mode).toLowerCase() === 'dialog' ? 'dialog' : 'launch';
  }

  /** Fresh URL for a library entry. */
  function forGame(game, method) {
    if (game.kind === 'nonsteam') return build({ verb: 'rungameid', id: game.id });
    if (method === 'dialog') return build({ verb: 'launch', id: game.id, mode: 'dialog' });
    if (method === 'launch') return build({ verb: 'launch', id: game.id });
    return build({ verb: 'run', id: game.id });
  }

  /** Switch between run / launch / dialog. Keeps language + launch options untouched. */
  function setMethod(url, method) {
    var p = parse(url);
    if (!p || p.verb === 'rungameid' || METHODS.indexOf(method) === -1) return url;
    if (method === 'run') { p.verb = 'run'; p.mode = ''; }
    else if (method === 'dialog') { p.verb = 'launch'; p.mode = 'dialog'; }
    else {
      // "launch": drop the dialog mode, but leave any custom mode the user typed alone
      var custom = p.verb === 'launch' && p.mode && String(p.mode).toLowerCase() !== 'dialog';
      p.verb = 'launch';
      if (!custom) p.mode = '';
    }
    return build(p);
  }

  function getTokens(url) {
    var p = parse(url);
    return p ? tokenize(p.args) : [];
  }

  function setTokens(url, tokens) {
    var p = parse(url);
    if (!p) return url;
    p.args = tokens.join(' ');
    return build(p);
  }

  function findSeq(hay, needle) {
    if (!needle.length) return -1;
    for (var i = 0; i + needle.length <= hay.length; i++) {
      var ok = true;
      for (var j = 0; j < needle.length; j++) {
        if (hay[i + j] !== needle[j]) { ok = false; break; }
      }
      if (ok) return i;
    }
    return -1;
  }

  function hasOption(url, option) {
    return findSeq(getTokens(url), tokenize(option)) !== -1;
  }

  /**
   * Toggle a launch option on/off. For "-flag value" options that already
   * exist with a different value (e.g. -w 1280 when adding -w 1920) the value
   * is replaced instead of adding a duplicate flag.
   */
  function toggleOption(url, option) {
    var p = parse(url);
    if (!p) return url;
    var tokens = tokenize(p.args);
    var opt = tokenize(option);
    if (!opt.length) return url;

    var at = findSeq(tokens, opt);
    if (at !== -1) {
      tokens.splice(at, opt.length);
    } else {
      var flagAt = -1;
      if (opt.length > 1 && /^[-+]/.test(opt[0])) flagAt = tokens.indexOf(opt[0]);
      if (flagAt !== -1 && tokens.length > flagAt + opt.length - 1) {
        tokens.splice.apply(tokens, [flagAt, opt.length].concat(opt));
      } else {
        tokens = tokens.concat(opt);
      }
    }
    p.args = tokens.join(' ');
    return build(p);
  }

  function clearOptions(url) {
    var p = parse(url);
    if (!p) return url;
    p.args = '';
    return build(p);
  }

  /**
   * Make a URL safe to hand to the OS. Only steam:// is allowed.
   * @returns {string|null} null when the URL must not be opened
   */
  function normalizeForOpen(url) {
    var s = String(url || '').trim();
    if (!/^steam:\/\/\S/i.test(s.replace(/ /g, '%20'))) return null;
    if (/[\u0000-\u001f\u007f]/.test(s)) return null;
    return s.replace(/[^\x21-\x7e]|["<>\\^`{|}]/g, function (ch) {
      return encodeURIComponent(ch);
    });
  }

  return {
    METHODS: METHODS,
    parse: parse,
    build: build,
    methodOf: methodOf,
    forGame: forGame,
    setMethod: setMethod,
    tokenize: tokenize,
    getTokens: getTokens,
    setTokens: setTokens,
    hasOption: hasOption,
    toggleOption: toggleOption,
    clearOptions: clearOptions,
    normalizeForOpen: normalizeForOpen
  };
});
