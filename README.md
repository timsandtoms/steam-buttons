# Steam Buttons for OpenDeck

Launch Steam games, programs and non-Steam shortcuts from an [OpenDeck](https://github.com/nekename/OpenDeck) button. Pick a title from your Steam library and the button gets its icon and the `steam://` link that starts it. Icons come from Steam's own artwork or from community art on [SteamGridDB](https://www.steamgriddb.com/).

## Features

- **Your whole library in one list**: installed games, games you own but haven't installed, and your non-Steam shortcuts, with filters and search.
- **Automatic button icons** from Steam's artwork: cropped cover art, the whole cover, or Steam's small icon.
- **Custom crop editor**: drag, zoom and rotate the art until it fits the key the way you want.
- **SteamGridDB art**: browse grids, heroes, logos and icons from the community and put any of them on a button (needs a free API key).
- **Launch options**: add options like `-novid` or `-windowed` to a button with one click.
- **Run, launch or show Steam's launch-option picker**, per button.
- **Undo / redo** for every icon change.
- Works on **Windows, macOS and Linux**, including Flatpak Steam.

## Requirements

- OpenDeck
- **Node.js 20 or newer** installed on your computer (OpenDeck uses it to run this plugin)
- Steam installed and signed in at least once

## Install

Install **Steam Buttons** from OpenDeck's plugin list.

Or download `com.github.timsandtoms.steam-buttons.sdPlugin.zip` from the [latest release](https://github.com/timsandtoms/steam-buttons/releases/latest) and install it from OpenDeck's Plugins tab.

## Getting started

1. Drag **Steam Buttons → Launch** onto a key.
2. Click the search box and pick a game or program. The key takes its icon right away.
3. Optional: change the icon style, add launch options, or choose **SteamGridDB art…** for community artwork.

## SteamGridDB

To use SteamGridDB art you need your own free API key: sign in at [steamgriddb.com](https://www.steamgriddb.com/), go to **Preferences → API**, and paste the key into the plugin's **Settings**. The key stays on your computer and is only ever sent to steamgriddb.com. Adult and humorous artwork is hidden unless you turn it on in Settings.

## Privacy

The plugin reads your Steam library from the files on your computer. It only goes online to fetch missing artwork and names from Steam, to fetch SteamGridDB art when you ask for it, and, if you turn it on in Settings, to read your public Steam profile's game list. Each of these can be turned off.

## Troubleshooting

- **"Steam wasn't found"**: enter your Steam folder in Settings.
- **Nothing happens when you press the key**: check OpenDeck's plugin log. On Linux the plugin tries `xdg-open`, `gio open`, `flatpak-spawn --host xdg-open`, then `steam`.
- **SteamGridDB says the key was rejected**: copy it again from steamgriddb.com → Preferences → API (no spaces).
- **SteamGridDB has nothing for a title**: use the search box in the SteamGridDB panel to pick the right game. Non-Steam shortcuts are matched by name, so they often need this.
- **Launch options are ignored**: Steam decides whether to honour options passed this way, and some games ignore them.
- **Some owned games are missing**: turn on *Settings → List owned games … using my public Steam profile* (your profile's game details must be public), then press Rescan (↻).

Full details on every control are in the [plugin guide](https://github.com/timsandtoms/steam-buttons/blob/main/com.github.timsandtoms.steam-buttons.sdPlugin/README.md).

## License

[MIT](https://github.com/timsandtoms/steam-buttons/blob/main/LICENSE)

Not affiliated with or endorsed by Valve. Steam is a trademark of Valve Corporation.
