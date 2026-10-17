'use strict';
/*
 * Hands a steam:// URL to the operating system, which forwards it to Steam
 * (starting Steam first if it isn't running).
 */
const { spawn } = require('child_process');

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
      child.on('error', () => finish(false));
      child.on('exit', (code) => finish(code === 0));
      // Some handlers stay alive until the target app is up; treat that as success.
      setTimeout(() => { finish(true); try { child.unref(); } catch (e) { /* ignore */ } }, timeoutMs || 4000);
    } catch (e) { finish(false); }
  });
}

function commandsFor(url) {
  switch (process.platform) {
    case 'win32':
      return [
        ['rundll32.exe', ['url.dll,FileProtocolHandler', url]],
        ['explorer.exe', [url]]
      ];
    case 'darwin':
      return [['open', [url]]];
    default:
      return [
        ['xdg-open', [url]],
        ['gio', ['open', url]],
        ['flatpak-spawn', ['--host', 'xdg-open', url]],
        ['steam', [url]]
      ];
  }
}

/** @returns {Promise<boolean>} true if some launcher accepted the URL */
async function openSteamUrl(url) {
  if (process.env.STEAMBUTTONS_DRY_RUN) {
    console.log('[dry-run] open ' + url);
    return true;
  }
  for (const [cmd, args] of commandsFor(url)) {
    if (await run(cmd, args)) return true;
  }
  return false;
}

module.exports = { openSteamUrl };
