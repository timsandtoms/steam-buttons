# Steam Buttons for OpenDeck

An [OpenDeck](https://github.com/nekename/OpenDeck) plugin that launches Steam games, programs and non-Steam shortcuts from a button. Pick a title from your Steam library and the key gets its artwork and the `steam://` URL that starts it.

Full usage notes are in [`com.github.timsandtoms.steam-buttons.sdPlugin/README.md`](com.github.timsandtoms.steam-buttons.sdPlugin/README.md).

## Install

Download `com.github.timsandtoms.steam-buttons.sdPlugin.zip` from the [latest release](../../releases/latest) and install it from OpenDeck's Plugins tab, or unzip it into OpenDeck's `plugins` folder and restart OpenDeck. Requires Node.js 20+.

## Development

```
cd com.github.timsandtoms.steam-buttons.sdPlugin
npm ci
```

Then copy or symlink the `com.github.timsandtoms.steam-buttons.sdPlugin` folder into OpenDeck's `plugins` folder.

To publish a release: bump `Version` in `manifest.json` (and `version` in `package.json`), commit, then `git tag v1.0.0 && git push --tags`. GitHub Actions builds the zip and creates the release.

## License

[MIT](LICENSE)

Not affiliated with or endorsed by Valve. Steam is a trademark of Valve Corporation.
