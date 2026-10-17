# Steam Buttons for OpenDeck

An [OpenDeck](https://github.com/nekename/OpenDeck) plugin that makes it easy to launch games, programs, and non-Steam shortcuts via Steam. Entirely vibe-coded.

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

To publish a release: bump `Version` in `manifest.json` (and `version` in `package.json`), commit, then `git tag v1.0.0 && git push --tags`. GitHub Actions builds the zip and creates the release.

## License

[MIT](LICENSE)

Not affiliated with or endorsed by Valve. Steam is a trademark of Valve Corporation.
