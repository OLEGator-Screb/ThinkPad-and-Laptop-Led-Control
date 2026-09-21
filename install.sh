#!/usr/bin/env bash
# Installer for ThinkPad and Laptop LED Control — run from repo root.
set -euo pipefail

NO_UDEV=0
for arg in "$@"; do
  case "$arg" in
    --no-udev) NO_UDEV=1 ;;
    -h|--help)
      echo "Usage: ./install.sh [--no-udev]"
      echo "  --no-udev  Skip udev rule install (no sudo needed)"
      exit 0
      ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 1 ;;
  esac
done

cd "$(dirname "$0")"

UUID="thinkpad-led@example.com"
EXT="$HOME/.local/share/gnome-shell/extensions/$UUID"

echo "==> Installing extension files to $EXT"
mkdir -p "$EXT" "$EXT/schemas"
cp extension.js prefs.js utils.js metadata.json "$EXT/"
cp schemas/*.xml "$EXT/schemas/"

echo "==> Compiling schemas"
glib-compile-schemas "$EXT/schemas"

if [ "$NO_UDEV" -eq 0 ]; then
  echo "==> Installing udev rule (needs sudo)"
  sudo cp 90-thinkpad-led.rules /etc/udev/rules.d/
  sudo udevadm control --reload-rules
  sudo udevadm trigger --subsystem-match=leds --action=add
  echo "==> Applying instant permissions (best-effort)"
  sudo chgrp wheel /sys/class/leds/*/brightness 2>/dev/null || true
  sudo chmod 0664 /sys/class/leds/*/brightness 2>/dev/null || true
else
  echo "==> Skipping udev rule (--no-udev)"
fi

echo "==> Enabling extension"
if gnome-extensions list 2>/dev/null | grep -q "$UUID"; then
  gnome-extensions enable "$UUID" || true
else
  echo "Shell hasn't picked up the new files yet (it scans at startup)."
  echo "Log out and back in, then run: gnome-extensions enable $UUID"
fi

echo "Done."
echo "NOTE: On Wayland there is no Shell restart — log out and back in."
echo "Verify with:"
echo "  gnome-extensions list | grep $UUID"
echo "  ls -l /sys/class/leds/*/brightness"
