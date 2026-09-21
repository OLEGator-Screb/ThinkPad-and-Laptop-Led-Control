# ThinkPad and Laptop LED Control — GNOME Shell Extension

Control ThinkPad and laptop sysfs LEDs from GNOME Quick Settings.

Repo: https://github.com/OLEGator-Screb/ThinkPad-and-Laptop-Led-Control

## Features

- **Autodetect** LEDs matching `tpacpi::*`, `platform::*`, `input*::*` under `/sys/class/leds` (requires `thinkpad_acpi`).
- **Per-LED toggle + slider** — on/off tile in Quick Settings; live brightness slider (0..max) in Preferences.
- **Display names** — custom label per LED (`led-names`); falls back to the sysfs name.
- **Quick-settings visibility** — choose which LEDs get tiles (`led-quick`).
- **Disk/net bindings** — bind an LED to disk or network activity in `blink` (on/off) or `pulse` (sine brightness) mode.
- **Morse sender** — blink ITU Morse (A–Z, 0–9) on a chosen LED:
  - Preferences → Morse sender group: target LED, message, dot-unit spinner, Send/Stop.
  - Quick Settings → Morse tile: sends the saved message/target/unit; tap to stop. Message, target and unit are shared with Preferences.

## Requirements

- GNOME Shell 45–50.
- `thinkpad_acpi` loaded so LEDs appear under `/sys/class/leds`.
- Write access to each LED's `brightness` node (see udev rule below).
- Tested on: ThinkPad X1 Carbon Gen 10.

## Install

```bash
git clone https://github.com/OLEGator-Screb/ThinkPad-and-Laptop-Led-Control
cd ThinkPad-and-Laptop-Led-Control
./install.sh
# if "Permission denied": bash install.sh  (upload lost the +x bit)
# never run the whole script under sudo — it calls sudo itself for the udev part
```

Skip the sudo/udev part with: `./install.sh --no-udev`

The installer copies `extension.js prefs.js utils.js metadata.json` to
`~/.local/share/gnome-shell/extensions/thinkpad-led@OLEGator-Screb/`,
compiles `schemas/*.xml`, installs `90-thinkpad-led.rules` to
`/etc/udev/rules.d/` (reloads + triggers udev, applies instant
`chgrp wheel`/`chmod 0664` on LED brightness nodes), then enables the
extension.

Group caveat: the rule uses `GROUP="wheel"`. On Debian/Ubuntu the admin
groups are usually sudo/adm, not wheel — either adapt the rule
(`GROUP="sudo"`, plus `sudo adduser $USER sudo`) or rely on the
`TAG+="uaccess"` line, which covers the locally logged-in user via
systemd-logind regardless of group. Then reload + trigger udev, relogin.

On Wayland there is no Shell restart — **log out and back in** after enabling.
Check permissions with: `ls -l /sys/class/leds/*/brightness`

## Troubleshooting

- **Extension not listed after copy** — GNOME Shell scans extensions at startup; relogin (Wayland) or restart Shell (X11), then check `gnome-extensions list`.
- **Permission denied on write** — the udev rule was not applied: re-run the reload/trigger step, check group membership (`groups`, `wheel`), or apply the instant `chgrp`/`chmod` above.
- **`input3` lock LEDs owned by kernel** — Caps/Num/Scroll-lock LEDs may be driven by the input subsystem; manual writes can be overridden or rejected.
- **Disposed-actor crash** — fixed: activity/morse timers carry per-kind generation tokens and exit stale instead of touching destroyed tiles; `disable()` bumps tokens before tearing down timers, then destroys menus before items.
- **Empty list semantics** — empty `led-list` means *all detected* unless `led-list-custom` is true (explicit-empty-means-none); empty `led-quick` means *show all* unless `led-quick-custom` is true. Toggling every LED back on restores the default empty state.

## File layout

- `extension.js` — indicator, per-LED toggles, activity polling/bindings, Morse sender.
- `prefs.js` — per-LED switches/sliders/names/visibility/bindings, Morse group.
- `utils.js` — shared Morse table/events, LED filter, sysfs read/write helpers.
- `metadata.json` — uuid `thinkpad-led@OLEGator-Screb`, Shell 45–50.
- `schemas/org.gnome.shell.extensions.thinkpad-led.gschema.xml` — `led-list`, `led-list-custom`, `led-names`, `led-quick`, `led-quick-custom`, `led-binding`, `morse-text`, `morse-led`, `morse-unit`.
- `90-thinkpad-led.rules` — udev rule granting `wheel` + `uaccess` write access to LED brightness nodes.
- `LICENSE` — GNU AGPL v3.0 (see file; canonical text at https://www.gnu.org/licenses/agpl-3.0.html).

## Development

AI assistance was used during development (code drafting, comments and docs).
All behavior was reviewed and tested by the author before release.
