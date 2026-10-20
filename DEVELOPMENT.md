# Development notes

Notes for working on Steam Buttons. Users don't need any of this; see [README.md](README.md).

All commands are run from the root of the repo (the folder with `README.md` in it), in VS Code's terminal.

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

## Building and testing locally: `scripts/package.js`

Builds the same zip a GitHub release would contain, so you can try changes in OpenDeck without publishing anything.

| Command | VS Code task | What it does |
| --- | --- | --- |
| `node scripts/package.js` | *Build: local plugin zip only* | Builds `dist/com.github.timsandtoms.steam-buttons.sdPlugin.zip` |
| `node scripts/package.js --install` | *Build: local plugin zip (and install into OpenDeck)* | Builds the zip **and** copies the plugin into OpenDeck's plugins folder, replacing the installed copy |

- **Restart OpenDeck** after `--install` so it loads the new version.
- To run a VS Code task: *Terminal → Run Task…* and pick it from the list.
- Needs npm and an internet connection (it installs the runtime dependencies fresh into a temporary copy). Your working folder isn't changed.
- `dist/` is ignored by git, so the zip never gets committed. Delete the folder whenever you like.

## Publishing a release: `scripts/release.js`

Bumps the version, commits, and tags. Pushing the tag makes GitHub Actions build the zip and publish the release. The OpenDeck plugin list offers whatever GitHub marks as the **latest release**.

**Before you start:** commit or stash everything. The script refuses to run if there are uncommitted changes.

**Step 1: bump and tag.** VS Code task *Release: bump version and tag*, then pick from the list, or run:

| Command | Example | Use it for |
| --- | --- | --- |
| `node scripts/release.js patch` | 1.0.0 → 1.0.1 | Bug fixes |
| `node scripts/release.js minor` | 1.0.1 → 1.1.0 | New features |
| `node scripts/release.js major` | 1.1.0 → 2.0.0 | Big or breaking changes |
| `node scripts/release.js 1.2.3` | → 1.2.3 | An exact version (can't be lower than the current one) |
| `node scripts/release.js current` | tags 1.1.0 as is | Tagging the version already in the files, e.g. finishing a beta |

It updates the version in `manifest.json`, `package.json` and `package-lock.json`, commits them as "Release vX.Y.Z", and creates the tag `vX.Y.Z`. **Nothing is published yet.**

**Step 2: push.** VS Code task *Release: push*, or:

```
git push --follow-tags
```

Then watch the **Actions** tab on GitHub. When the Release run is green, the new release and its zip appear on the Releases page.

### Beta (pre-release) builds

For a test build that people can download but that the OpenDeck plugin list **won't** offer:

| Command | Result |
| --- | --- |
| `node scripts/release.js minor-beta` | Files go to 1.1.0, tag `v1.1.0-beta.1` |
| `node scripts/release.js patch-beta` | Files go to 1.0.1, tag `v1.0.1-beta.1` |
| `node scripts/release.js beta` | Next beta of the current version: `v1.1.0-beta.2`, `-beta.3`, … (no file changes) |

Push the same way. When the beta is good, run `node scripts/release.js current` and push to publish the final `v1.1.0`.

### If something goes wrong

- **Made a release commit and tag but haven't pushed yet, and want to undo:**
```
  git tag -d v1.1.0
  git reset --hard HEAD~1
```
  (Use the tag you actually made. `git reset --hard` throws away the release commit, so only do this before pushing.)
- **"The tag … already exists":** tags are never reused. Pick a higher version.
- **Release run failed with "Version mismatch":** the tag doesn't match the version in `manifest.json` / `package.json`. That only happens if you tag by hand; use the script instead.
- **A Release run failed for another reason:** fix and commit the problem, delete the tag on GitHub and on your computer (`git tag -d vX.Y.Z`), then run `node scripts/release.js current` and push again. Don't use the **Re-run** button after deleting a tag; it replays the old run and fails.