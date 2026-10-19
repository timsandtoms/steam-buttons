# Steam Buttons for OpenDeck

One action, **Launch**. Pick a game or program from your Steam library and the button gets its icon and the `steam://` URL that starts it. Pressing the button opens that URL.

## Requirements

* OpenDeck (Windows, macOS or Linux)
* **Node.js 20 or newer** installed on the machine (OpenDeck runs Node-based plugins with the system Node)
* Steam installed and signed in at least once

## Install

Copy the `com.github.timsandtoms.steam-buttons.sdPlugin` folder into OpenDeck's `plugins` folder and restart OpenDeck
(Linux `~/.config/opendeck/plugins/`, Windows `%appdata%\opendeck\plugins\`, macOS `~/Library/Application Support/opendeck/plugins/`),
or use the plugin install-from-file option in OpenDeck with the supplied `.zip` / `.streamDeckPlugin`.

## Using it

1. Drag **Steam Buttons → Launch** onto a key.
2. Click the search box and pick a title. The URL field fills in and the key takes the title's icon.
3. Optional: switch **run / launch / dialog**, click launch-option buttons, change the icon style, or edit the URL by hand.

| Control | What it does |
| --- | --- |
| **Steam URL** | What is opened when you press the key. Only `steam://` URLs are ever opened. |
| **run / launch / dialog** | Rewrites only the verb and mode segment; language and launch options are kept. `run` = `steam://run/<id>`, `launch` = `steam://launch/<id>`, `dialog` = `steam://launch/<id>/dialog` (Steam's launch-option picker). Hover a button for details. |
| **Make … the default?** | Sets which method new selections use. Also in Settings. |
| **Installed / Not installed / Custom / Everything** | Filter the list. The counts beside the buttons are installed / not installed / custom / total. |
| **Custom** | For an AppID that isn't listed: type it (or paste a store link) into the box. Artwork and, where available, the name are looked up. Entries you use are remembered; **Clear unused custom entries** forgets those no button is using. |
| **Rescan** (↻) | Re-reads Steam. The scan is otherwise done once per session and kept. |
| **Launch options** | Click to add/remove an option; highlighted = present. `-w 1280` replaces an existing `-w 1920` rather than duplicating it. **Edit list** lets you add, rename and remove buttons (shared by all keys). |
| **Button icon** | Icon style for *this* button: cover art cropped, whole cover art, Steam's small icon, **Custom crop…**, or **SteamGridDB art…** (see below). |
| **Undo / Redo / Restore original** | Under Button icon. Every icon change (a new style, a SteamGridDB pick, a whole crop-editing session) is one step, so a mis-click is one click to take back. **Restore original** jumps to the icon the button had when you opened the panel. Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z work too (outside text boxes). History lasts while the panel is open and starts over when you pick a different title. |
| **Custom crop…** | Opens a square editor on the cover art. Drag the picture to move it, or use the arrow buttons — they move the picture itself, the same direction as dragging (press and hold to repeat, faster the longer you hold). Scroll, the slider, or the +/− buttons zoom (50%–400%; below 100% shows more of the art, with black around it). The rotate buttons and slider turn the picture (−180° to 180°); the square is always filled, with black in any corner the picture doesn't reach. The dot button re-centres both ways; **Center horizontally** / **Center vertically** re-centre just that one axis, handy for lining up a logo without disturbing the other axis or the zoom. None of the centering buttons touch zoom or rotation. The key updates as you go; **Reset** goes back to the automatic crop, **Done** closes the editor, and **Edit crop…** reopens it. The crop is kept per button and is cleared when you pick a different title. It is not offered as a default for new entries. Zoom goes down to 25% so a wide logo can be shown whole. |
| **SteamGridDB art…** | Browse community artwork from [steamgriddb.com](https://www.steamgriddb.com/) and put it on the button, laid out like the site: the game (found by its Steam app id; use the search box to switch to another), **Grids / Heroes / Logos / Icons** tabs, **Style** and **Size** filters, and a wall of artwork. Click any piece to preview it on the key straight away; click another to try it. **Adjust crop…** opens the crop editor above on that artwork (logos start fitted whole). Only still images are listed. Adult and humorous artwork is hidden unless you allow it in Settings. Needs a free API key, see below. |
| **Settings → SteamGridDB API key** | Your own key, from steamgriddb.com → Preferences → API. The first time you choose SteamGridDB art the panel asks for it, or paste it here. It is kept in OpenDeck's plugin settings on your computer and is only ever sent to steamgriddb.com. |
| **Settings → Default button icon for new entries** | The style new selections start with. Changing it never affects buttons that already have a title. |

URL shapes produced:

```
steam://run/730                                   run
steam://run/730//-novid%20-windowed/              run + launch options
steam://launch/730                                launch
steam://launch/730/dialog                         dialog
steam://launch/730/dialog//-novid%20-windowed/    dialog + launch options
steam://rungameid/<64-bit id>                     non-Steam shortcuts
```

## How the library is found

* **Installed**: `appmanifest_*.acf` in every Steam library folder (Proton, Steam Linux Runtime, redistributables and other tools are hidden).
* **Owned, not installed**: app ids that Steam's local caches mention (your `localconfig.vdf`, collections, library cache), named and filtered through `appcache/appinfo.vdf`. For a complete list, turn on *Settings → List owned games … using my public Steam profile*: the plugin requests `steamcommunity.com/profiles/<your SteamID64>/games?tab=all&xml=1` (no login or API key; needs "Game details" set to public) and adds the titles it returns that aren't installed.
* **Non-Steam**: `userdata/<you>/config/shortcuts.vdf`.
* **Several Steam accounts on one PC**: only the account that signed in most recently is read (its shortcuts, collections, artwork, and the SteamID64 used by the profile lookup). Installed games are machine-wide, so they appear whoever is signed in. After switching accounts in Steam, press Rescan.

The scan runs once per session (the first time an inspector opens) and is kept until you press Rescan or restart OpenDeck.

Icons come from Steam's local library cache (or your own custom artwork), or from SteamGridDB if you choose that option. Missing artwork and names for custom AppIDs are looked up from Steam's servers unless you turn that off in Settings. The plugin re-applies the icon it saved for a key whenever OpenDeck loads it.

## Troubleshooting

* **"Steam wasn't found"**: enter the Steam folder in Settings.
* **Nothing happens on press**: check the plugin log. On Linux the plugin tries `xdg-open`, `gio open`, `flatpak-spawn --host xdg-open`, then `steam`.
* **SteamGridDB says the key was rejected**: copy it again from steamgriddb.com → Preferences → API (no spaces) and paste it into Settings.
* **SteamGridDB has nothing for a title**: use the search box in the panel to pick the matching game; non-Steam shortcuts are matched by name, so they often need this.
* The SteamGridDB option needs internet access. Art already on a key keeps working offline, because the finished icon is stored with the button.
* Steam decides whether it honours launch options passed via URL; some titles ignore them.
* Flatpak Steam: the plugin looks in `~/.var/app/com.valvesoftware.Steam`. If OpenDeck itself is sandboxed it may need read access to that folder.
