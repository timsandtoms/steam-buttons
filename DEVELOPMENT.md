# Development notes

Notes for working on Steam Buttons. Users don't need any of this; see [README.md](README.md).

## Setup

```
cd com.github.timsandtoms.steam-buttons.sdPlugin
npm ci
```

Then copy or symlink the `com.github.timsandtoms.steam-buttons.sdPlugin` folder into OpenDeck's `plugins` folder.

## Tests

Node's built-in test runner, no extra dependencies. CI runs these on every push.

```
node --test test/*.test.js
```

## Local builds

Build exactly what a release would contain, without GitHub (the zip lands in `dist/`):

```
node scripts/package.js            # just the zip
node scripts/package.js --install  # also installs it into OpenDeck's plugins folder (restart OpenDeck after)
```

VS Code: *Terminal → Run Task → Build: local plugin zip…*

## Releases

Run the VS Code task *Release: bump version and tag* (or `node scripts/release.js patch|minor|major`), then *Release: push* (`git push --follow-tags`). The script updates `manifest.json`, `package.json` and `package-lock.json` together; GitHub Actions builds the zip and creates the release.

Beta builds: run the release task with `minor-beta`, `patch-beta` or `beta` (or `node scripts/release.js minor-beta`) and push. A tag such as `v1.1.0-beta.1` is published as a GitHub **pre-release**: people can download it from the Releases page, but it never becomes the "latest release" that the OpenDeck plugin list follows. When it's ready, run the task with `current` to tag the final `v1.1.0`.
