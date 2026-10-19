# Steam Buttons for OpenDeck

An [OpenDeck](https://github.com/nekename/OpenDeck) plugin that makes it easy to launch games, programs, and non-Steam shortcuts via Steam, with button icons from Steam's own artwork or [SteamGridDB](https://www.steamgriddb.com/). Entirely vibe-coded.

Full usage notes are in [`com.github.timsandtoms.steam-buttons.sdPlugin/README.md`](com.github.timsandtoms.steam-buttons.sdPlugin/README.md).

## Requirements

 Requires Node.js 20+.

## Install

Download `com.github.timsandtoms.steam-buttons.sdPlugin.zip` from the [latest release](../../releases/latest) and install it from OpenDeck's Plugins tab, or unzip it into OpenDeck's `plugins` folder and restart OpenDeck.

## Development

```
cd com.github.timsandtoms.steam-buttons.sdPlugin
npm ci
```

Then copy or symlink the `com.github.timsandtoms.steam-buttons.sdPlugin` folder into OpenDeck's `plugins` folder.

Tests (Node's built-in runner, no extra dependencies):

```
node --test test/*.test.js
```

Build exactly what a release would contain, without GitHub (zip lands in `dist/`):

```
node scripts/package.js            # just the zip
node scripts/package.js --install  # also installs it into OpenDeck's plugins folder (restart OpenDeck after)
```

(VS Code: *Terminal → Run Task → Build: local plugin zip…*)

Beta builds: run the release task with `minor-beta`, `patch-beta` or `beta` (or `node scripts/release.js minor-beta`) and push. A tag such as `v1.1.0-beta.1` is published as a GitHub **pre-release**: people can download it from the Releases page, but it never becomes the "latest release" that the OpenDeck plugin list follows. When it's ready, run the task with `current` to tag the final `v1.1.0`.

To publish a release: bump `Version` in `manifest.json` (and `version` in `package.json`), commit, then `git tag v1.0.0 && git push --tags`. GitHub Actions builds the zip and creates the release.

## License

[MIT](LICENSE)

Not affiliated with or endorsed by Valve. Steam is a trademark of Valve Corporation.
