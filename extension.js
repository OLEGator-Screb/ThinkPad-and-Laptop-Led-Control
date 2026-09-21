/* ThinkPad and Laptop LED Control — Quick Settings toggles for tpacpi/platform/input LEDs.
 * Reads/writes /sys/class/leds/<name>/brightness (0..max_brightness).
 * Morse timing: 1 unit = morse-unit ms (default 120); dash = 3u, letter gap = 3u, word gap = 7u.
 * Timer callbacks carry generation tokens and exit stale instead of touching destroyed actors.
 */
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {
    SYSFS_LEDS, DEFAULT_MORSE_UNIT_MS, MORSE_UNIT_STEP,
    MORSE_TABLE, textToMorseEvents, keepLed, clampMorseUnit,
    readTextFile, readIntFile, writeIntFile,
} from './utils.js';

// Re-export the shared pure helpers previously defined here (module surface unchanged).
export { MORSE_TABLE, textToMorseEvents, keepLed, clampMorseUnit };

const POLL_MS = 250;
const BLINK_MS = 300;
const DISK_THRESHOLD = 0;
const NET_THRESHOLD = 0;

// Empty led-list = all detected (unless listCustom); empty led-quick = all ordered (unless quickCustom).
export function selectQuickLeds(detectedNames, ledList, ledQuick, listCustom = false, quickCustom = false) {
    const enabled = (ledList ?? []).filter(keepLed);
    const ordered = enabled.length > 0 ? [...enabled] : (listCustom ? [] : [...(detectedNames ?? [])]);
    const quick = (ledQuick ?? []).filter(keepLed);
    const visible = quick.length === 0
        ? (quickCustom ? [] : [...ordered])
        : ordered.filter(n => quick.includes(n));
    return { ordered, visible };
}

// Enumerate candidate LEDs under /sys/class/leds.
export function detectLEDs() {
    const leds = [];
    try {
        const dir = Gio.File.new_for_path(SYSFS_LEDS);
        if (!dir.query_exists(null))
            return leds;
        const enumerator = dir.enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (!keepLed(name))
                continue;
            const brightness = readIntFile(`${SYSFS_LEDS}/${name}/brightness`) ?? 0;
            const max = readIntFile(`${SYSFS_LEDS}/${name}/max_brightness`) ?? 1;
            leds.push({ name, brightness, max: Math.max(1, max) });
        }
        try { enumerator.close(null); } catch { /* ignore */ }
    } catch (e) {
        log(`thinkpad-led: enumerate ${SYSFS_LEDS} failed: ${e.message}`);
    }
    return leds;
}

function readBrightness(led) {
    return readIntFile(`${SYSFS_LEDS}/${led.name}/brightness`);
}

function writeBrightness(led, value) {
    const v = Math.max(0, Math.min(led.max, Math.round(value)));
    return writeIntFile(`${SYSFS_LEDS}/${led.name}/brightness`, v);
}

// Total read+write sectors across all disks in /proc/diskstats.
function readDiskTotal() {
    const text = readTextFile('/proc/diskstats');
    if (text === null)
        return null;
    let total = 0;
    for (const line of text.split('\n')) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 14)
            continue;
        const sectorsRead = parseInt(cols[5], 10);
        const sectorsWritten = parseInt(cols[9], 10);
        if (!Number.isNaN(sectorsRead))
            total += sectorsRead;
        if (!Number.isNaN(sectorsWritten))
            total += sectorsWritten;
    }
    return total;
}

// Total rx+tx bytes (non-loopback) in /proc/net/dev.
function readNetTotal() {
    const text = readTextFile('/proc/net/dev');
    if (text === null)
        return null;
    let total = 0;
    for (const line of text.split('\n')) {
        const colon = line.indexOf(':');
        if (colon < 0)
            continue;
        const iface = line.slice(0, colon).trim();
        if (iface === 'lo' || iface === 'Inter')
            continue;
        const fields = line.slice(colon + 1).trim().split(/\s+/);
        if (fields.length < 9)
            continue;
        const rx = parseInt(fields[0], 10);
        const tx = parseInt(fields[8], 10);
        if (!Number.isNaN(rx))
            total += rx;
        if (!Number.isNaN(tx))
            total += tx;
    }
    return total;
}

function parseBinding(value) {
    if (typeof value !== 'string')
        return null;
    const [source, mode] = value.split(':');
    if ((source !== 'disk' && source !== 'net') || (mode !== 'blink' && mode !== 'pulse'))
        return null;
    return { source, mode };
}

const LedToggle = GObject.registerClass(
    class LedToggle extends QuickSettings.QuickToggle {
        _init(led, displayName, onManual) {
            super._init({
                title: displayName ?? led.name,
                subtitle: led.name,
                iconName: 'input-keyboard-symbolic',
                toggleMode: true,
            });
            this._led = led;
            this._displayName = displayName ?? led.name;
            this._onManual = onManual ?? null;
            this.refresh();
            this.connect('clicked', () => {
                try {
                    const value = this.checked ? this._led.max : 0;
                    // Claim the manual override BEFORE the sysfs write so a
                    // 300ms binding tick cannot slip in between and blink it back.
                    this._onManual?.(this._led.name, value);
                    writeBrightness(this._led, value);
                    this.refresh();
                } catch (e) {
                    log(`thinkpad-led: toggle click failed: ${e.message}`);
                }
            });
        }

        refresh() {
            try {
                const b = readBrightness(this._led);
                this.checked = (b ?? 0) > 0;
            } catch (e) {
                log(`thinkpad-led: toggle refresh skipped: ${e.message}`);
            }
        }
    });


const MorseToggle = GObject.registerClass(
    class MorseToggle extends QuickSettings.QuickMenuToggle {
        _init(api) {
            super._init({
                title: 'Morse',
                subtitle: 'Send saved message',
                iconName: 'mail-send-symbolic',
                toggleMode: true,
            });
            this._api = api;
            this.menu.setHeader('mail-send-symbolic', 'Morse code', 'Blink a message in ITU Morse');

            this._ledSub = new PopupMenu.PopupSubMenuMenuItem('Target LED', true);
            this.menu.addMenuItem(this._ledSub);
            this._ledItems = new Map();
            this._rebuildLedItems();

            const entryItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
            this._entry = new St.Entry({
                hint_text: 'Message (A–Z, 0–9)',
                text: api.getText() ?? '',
                can_focus: true,
                x_expand: true,
            });
            try {
                this._entry.clutter_text.connect('text-changed', () => {
                    try {
                        api.setText(this._entry.get_text());
                    } catch (e) {
                        log(`thinkpad-led: morse text save failed: ${e.message}`);
                    }
                    this._syncSendItem();
                });
            } catch (e) {
                log(`thinkpad-led: morse entry wiring failed: ${e.message}`);
            }
            entryItem.add_child(this._entry);
            this.menu.addMenuItem(entryItem);

            const unitItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
            const unitLabel = new St.Label({
                text: 'Dot unit (ms)',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const minus = new St.Button({ label: '−', style_class: 'button' });
            this._unitValue = new St.Label({
                text: `${api.getUnit()}`,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const plus = new St.Button({ label: '+', style_class: 'button' });
            minus.connect('clicked', () => this._shiftUnit(-MORSE_UNIT_STEP));
            plus.connect('clicked', () => this._shiftUnit(MORSE_UNIT_STEP));
            unitItem.add_child(unitLabel);
            unitItem.add_child(minus);
            unitItem.add_child(this._unitValue);
            unitItem.add_child(plus);
            this.menu.addMenuItem(unitItem);

            this._sendItem = this.menu.addAction('Send', () => {
                this.menu.close();
                try {
                    api.onToggle();
                } catch (e) {
                    log(`thinkpad-led: morse menu send failed: ${e.message}`);
                }
            });
            this.connect('clicked', () => {
                try {
                    api.onToggle();
                } catch (e) {
                    log(`thinkpad-led: morse click failed: ${e.message}`);
                }
            });
            this.syncFromSettings();
        }

        _rebuildLedItems() {
            try {
                this._ledSub.menu.removeAll();
            } catch { /* first build */ }
            this._ledItems.clear();
            let names = [];
            try {
                names = this._api.getLedNames() ?? [];
            } catch { /* leave empty */ }
            for (const name of names) {
                const item = new PopupMenu.PopupMenuItem(name);
                item.connect('activate', () => {
                    try {
                        this._api.setLed(name);
                    } catch (e) {
                        log(`thinkpad-led: morse LED save failed: ${e.message}`);
                    }
                    this._syncLedChecks();
                });
                this._ledSub.menu.addMenuItem(item);
                this._ledItems.set(name, item);
            }
            this._syncLedChecks();
        }

        _syncLedChecks() {
            let current = '';
            try {
                current = this._api.getLed() ?? '';
            } catch { /* leave unchecked */ }
            for (const [name, item] of this._ledItems) {
                try {
                    item.setOrnament(name === current
                        ? PopupMenu.Ornament.CHECK
                        : PopupMenu.Ornament.NONE);
                } catch { /* ignore */ }
            }
        }

        _shiftUnit(delta) {
            try {
                const next = clampMorseUnit(this._api.getUnit() + delta);
                this._api.setUnit(next);
                if (this._unitValue)
                    this._unitValue.text = `${next}`;
            } catch (e) {
                log(`thinkpad-led: morse unit save failed: ${e.message}`);
            }
        }

        _syncSendItem() {
            try {
                const sending = this._api.isSending();
                const text = this._entry?.get_text() ?? this._api.getText() ?? '';
                if (this._sendItem) {
                    this._sendItem.label.text = sending ? 'Stop' : 'Send';
                    this._sendItem.sensitive = sending || text.trim().length > 0;
                }
            } catch { /* ignore */ }
        }

        // Refresh menu widgets in place.
        syncFromSettings() {
            try {
                const text = this._api.getText() ?? '';
                if (this._entry && this._entry.get_text() !== text)
                    this._entry.set_text(text);
                if (this._unitValue)
                    this._unitValue.text = `${this._api.getUnit()}`;
                this._syncLedChecks();
                this._syncSendItem();
                const sending = this._api.isSending();
                this.checked = sending;
                if (!sending)
                    this.subtitle = 'Send saved message';
            } catch (e) {
                log(`thinkpad-led: morse menu sync skipped: ${e.message}`);
            }
        }

        setSending(sending, detail) {
            try {
                this.checked = sending;
                this.subtitle = sending
                    ? (detail ?? 'Sending… (tap to stop)')
                    : 'Send saved message';
                if (this._sendItem) {
                    this._sendItem.label.text = sending ? 'Stop' : 'Send';
                    this._sendItem.sensitive = sending
                        || ((this._entry?.get_text() ?? '').trim().length > 0);
                }
            } catch { /* actor may be destroyed */ }
        }
    });

const LedIndicator = GObject.registerClass(
    class LedIndicator extends QuickSettings.SystemIndicator {

        _init(ledEntries, onManual, morseApi) {
            super._init();
            this._toggles = new Map();
            for (const { led, title } of ledEntries ?? []) {
                const toggle = new LedToggle(led, title, onManual);
                this.quickSettingsItems.push(toggle);
                this._toggles.set(led.name, toggle);
            }
            this._morse = new MorseToggle(morseApi);
            this.quickSettingsItems.push(this._morse);
        }
    });

export default class ThinkpadLedExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        // Generation tokens: stale callbacks exit instead of touching destroyed actors.
        this._pollToken = 0;
        this._bindToken = 0;
        this._morseToken = 0;
        this._morse = null;
        this._settingsChangedIds = [
            this._settings.connect('changed::led-list', () => this._reselect()),
            this._settings.connect('changed::led-list-custom', () => this._reselect()),
            this._settings.connect('changed::led-quick', () => this._reselect()),
            this._settings.connect('changed::led-quick-custom', () => this._reselect()),
            this._settings.connect('changed::led-names', () => this._reselect()),
            this._settings.connect('changed::led-binding', () => this._restartBindings()),
            this._settings.connect('changed::morse-text', () => this._syncMorseWidgets()),
            this._settings.connect('changed::morse-led', () => this._syncMorseWidgets()),
            this._settings.connect('changed::morse-unit', () => this._syncMorseWidgets()),
        ];

        const leds = detectLEDs();
        if (leds.length === 0)
            log('thinkpad-led: no tpacpi/platform/input LEDs found under /sys/class/leds');

        this._leds = leds;
        this._onManual = (name, value) => this._noteManual(name, value);
        this._indicator = null;
        this._rebuildIndicator();

        // Poll /proc counters every POLL_MS.
        this._activity = { disk: null, net: null, diskActive: false, netActive: false };
        const pollToken = this._pollToken;
        this._monitorId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            if (pollToken !== this._pollToken)
                return GLib.SOURCE_REMOVE;
            try {
                this._pollActivity();
            } catch (e) {
                log(`thinkpad-led: activity poll failed: ${e.message}`);
            }
            return GLib.SOURCE_CONTINUE;
        });

        this._bindState = new Map();
        this._restartBindings();
    }

    _enabledNames() {
        try {
            const list = this._settings?.get_strv('led-list') ?? [];
            return list.filter(n => keepLed(n));
        } catch {
            return [];
        }
    }

    _displayNames() {
        try {
            return this._settings?.get_value('led-names').deep_unpack() ?? {};
        } catch {
            return {};
        }
    }

    _displayName(name) {
        const names = this._displayNames();
        return (names && names[name]) || name;
    }

    _quickNames() {
        try {
            const list = this._settings?.get_strv('led-quick') ?? [];
            return list.filter(n => keepLed(n));
        } catch {
            return [];
        }
    }

    _listCustomized() {
        try {
            return this._settings?.get_boolean('led-list-custom') ?? false;
        } catch {
            return false;
        }
    }

    _quickCustomized() {
        try {
            return this._settings?.get_boolean('led-quick-custom') ?? false;
        } catch {
            return false;
        }
    }

    _bindings() {
        try {
            return this._settings?.get_value('led-binding').deep_unpack() ?? {};
        } catch {
            return {};
        }
    }

    _morseUnit() {
        try {
            const u = this._settings?.get_int('morse-unit') ?? DEFAULT_MORSE_UNIT_MS;
            return clampMorseUnit(u);
        } catch {
            return DEFAULT_MORSE_UNIT_MS;
        }
    }

    _lookupLed(name) {
        return this._leds.find(l => l.name === name)
            ?? { name, brightness: 0, max: readIntFile(`${SYSFS_LEDS}/${name}/max_brightness`) ?? 255 };
    }

    _pollActivity() {
        const disk = readDiskTotal();
        if (disk !== null) {
            if (this._activity.disk !== null)
                this._activity.diskActive = (disk - this._activity.disk) > DISK_THRESHOLD;
            this._activity.disk = disk;
        }
        const net = readNetTotal();
        if (net !== null) {
            if (this._activity.net !== null)
                this._activity.netActive = (net - this._activity.net) > NET_THRESHOLD;
            this._activity.net = net;
        }
    }

    _isActive(source) {
        if (source === 'disk')
            return this._activity?.diskActive ?? false;
        return this._activity?.netActive ?? false;
    }

    // True while Morse owns the LED (bindings must not write to it).
    _isMorseActive(name) {
        try {
            return !!this._morse && this._morse.led?.name === name;
        } catch {
            return false;
        }
    }

    _pauseBindingForMorse(name) {
        try {
            const st = this._bindState?.get(name);
            if (st?.timerId) {
                try { GLib.source_remove(st.timerId); } catch { /* already gone */ }
                st.timerId = 0;
            }
        } catch { /* ignore */ }
    }

    _resumeBindingForMorse(name) {
        try {
            const st = this._bindState?.get(name);
            if (!st || !name || st.timerId)
                return;
            const token = this._bindToken;
            // Adopt the post-Morse brightness so the binding does not snap back.
            try { st.manual = readBrightness(st.led) ?? st.manual; } catch { /* ignore */ }
            st.lastActive = this._isActive(st.binding.source);
            st.blinkOn = false;
            st.timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BLINK_MS, () => {
                if (token !== this._bindToken)
                    return GLib.SOURCE_REMOVE;
                try {
                    this._tickBoundLed(name, token);
                } catch (e) {
                    log(`thinkpad-led: bound-LED tick failed: ${e.message}`);
                }
                return GLib.SOURCE_CONTINUE;
            });
        } catch { /* ignore */ }
    }

    // Manual writes override the binding until activity flips.
    _noteManual(name, value) {
        const st = this._bindState.get(name);
        if (!st)
            return;
        st.override = true;
        st.manual = value;
    }

    _restartBindings() {
        // Invalidate old timers first so in-flight callbacks exit stale.
        this._bindToken = (this._bindToken ?? 0) + 1;
        if (this._bindState) {
            for (const [, st] of this._bindState) {
                if (st.timerId) {
                    try { GLib.source_remove(st.timerId); } catch { /* already gone */ }
                    st.timerId = 0;
                }
            }
        }
        this._bindState = new Map();
        if (!this._settings)
            return;
        const token = this._bindToken;
        const bindings = this._bindings();
        for (const [name, raw] of Object.entries(bindings)) {
            const binding = parseBinding(raw);
            if (!binding)
                continue;
            const led = this._lookupLed(name);
            const st = {
                binding,
                led,
                manual: readBrightness(led) ?? 0,
                override: false,
                lastActive: this._isActive(binding.source),
                blinkOn: false,
                phase: 0,
                timerId: 0,
            };
            // Leave disarmed while Morse owns the LED; stopMorse() re-arms it.
            if (this._isMorseActive(name)) {
                this._bindState.set(name, st);
                continue;
            }
            st.timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BLINK_MS, () => {
                if (token !== this._bindToken)
                    return GLib.SOURCE_REMOVE;
                try {
                    this._tickBoundLed(name, token);
                } catch (e) {
                    log(`thinkpad-led: bound-LED tick failed: ${e.message}`);
                }
                return GLib.SOURCE_CONTINUE;
            });
            this._bindState.set(name, st);
        }
    }

    _tickBoundLed(name, token) {
        if (token !== this._bindToken)
            return;
        if (this._isMorseActive(name))
            return;
        const st = this._bindState?.get(name);
        if (!st)
            return;
        const active = this._isActive(st.binding.source);
        // Activity flip clears the override and adopts the live value.
        if (active !== st.lastActive) {
            st.lastActive = active;
            if (st.override) {
                st.override = false;
                st.manual = readBrightness(st.led) ?? st.manual;
            }
        }
        if (st.override)
            return;
        if (st.binding.mode === 'blink') {
            if (active) {
                st.blinkOn = !st.blinkOn;
                writeBrightness(st.led, st.blinkOn ? st.led.max : 0);
            } else if (st.blinkOn || (readBrightness(st.led) ?? -1) !== st.manual) {
                st.blinkOn = false;
                writeBrightness(st.led, st.manual);
            }
        } else { // pulse
            if (active) {
                st.phase += 0.6;
                const level = Math.round(st.led.max * (0.5 + 0.5 * Math.sin(st.phase)));
                writeBrightness(st.led, level);
            } else if ((readBrightness(st.led) ?? -1) !== st.manual) {
                writeBrightness(st.led, st.manual);
            }
        }
        this._safeIndicatorRefresh(name);
    }

    _safeIndicatorRefresh(name) {
        try {
            this._indicator?._toggles?.get(name)?.refresh();
        } catch (e) {
            log(`thinkpad-led: quick-settings refresh skipped: ${e.message}`);
        }
    }

    _refreshMorseButton() {
        try {
            const sending = !!this._morse;
            this._indicator?._morse?.setSending(
                sending, sending ? `Sending on ${this._morse.led.name}… (tap to stop)` : undefined);
        } catch (e) {
            log(`thinkpad-led: morse button refresh skipped: ${e.message}`);
        }
    }

    _syncMorseWidgets() {
        try {
            this._indicator?._morse?.syncFromSettings();
        } catch (e) {
            log(`thinkpad-led: morse menu sync skipped: ${e.message}`);
        }
    }

    _morseApi() {
        return {
            getText: () => {
                try {
                    return this._settings?.get_string('morse-text') ?? '';
                } catch {
                    return '';
                }
            },
            setText: text => this._settings?.set_string('morse-text', text ?? ''),
            getLed: () => {
                try {
                    return this._settings?.get_string('morse-led') ?? '';
                } catch {
                    return '';
                }
            },
            setLed: name => this._settings?.set_string('morse-led', name ?? ''),
            getLedNames: () => (this._leds ?? []).map(l => l.name),
            getUnit: () => this._morseUnit(),
            setUnit: unit => this._settings?.set_int('morse-unit', clampMorseUnit(unit)),
            onToggle: () => this._onMorseClicked(),
            isSending: () => !!this._morse,
        };
    }

    _onMorseClicked() {
        if (this._morse) {
            this.stopMorse(true);
            return;
        }
        let text = '';
        let ledName = '';
        let unit = DEFAULT_MORSE_UNIT_MS;
        try {
            text = this._settings?.get_string('morse-text') ?? '';
            ledName = this._settings?.get_string('morse-led') ?? '';
            unit = this._morseUnit();
        } catch { /* use defaults */ }
        if (!text || !text.trim()) {
            try {
                if (this._indicator?._morse)
                    this._indicator._morse.subtitle = 'No message saved — open the menu to type one';
            } catch { /* ignore */ }
            return;
        }
        if (!ledName) {
            try {
                ledName = this._indicator?._toggles?.values()?.next()?.value?._led?.name ?? '';
            } catch { /* ignore */ }
        }
        if (!ledName)
            return;
        this.sendMorse(ledName, text, unit);
    }

    // Blink text in Morse on ledName via one-shot timeouts; cancels any in-progress send.
    sendMorse(ledName, text, unitMs) {
        this.stopMorse(true);
        const unit = clampMorseUnit(unitMs ?? this._morseUnit());
        const events = textToMorseEvents(text);
        if (!ledName || events.length === 0)
            return false;
        const led = this._lookupLed(ledName);
        const restore = readBrightness(led) ?? 0;
        this._morse = {
            led, restore, unit, events, index: 0, timerId: 0,
            token: this._morseToken,
        };
        // Suspend the binding while Morse owns the LED.
        this._pauseBindingForMorse(ledName);
        try {
            this._settings?.set_string('morse-text', text ?? '');
            this._settings?.set_string('morse-led', ledName);
            this._settings?.set_int('morse-unit', unit);
        } catch { /* persistence is best-effort */ }
        this._refreshMorseButton();
        this._applyMorseEvent();
        return true;
    }

    _applyMorseEvent() {
        const m = this._morse;
        if (!m || m.token !== this._morseToken)
            return;
        if (m.index >= m.events.length) {
            this.stopMorse(true);
            return;
        }
        const ev = m.events[m.index];
        try {
            writeBrightness(m.led, ev.on ? m.led.max : 0);
        } catch { /* write errors already logged */ }
        const waitMs = Math.max(1, ev.units * m.unit);
        m.index += 1;
        const token = m.token;
        m.timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, waitMs, () => {
            if (token !== this._morseToken)
                return GLib.SOURCE_REMOVE;
            const cur = this._morse;
            if (!cur || cur.token !== token)
                return GLib.SOURCE_REMOVE;
            cur.timerId = 0;
            try {
                this._applyMorseEvent();
            } catch (e) {
                log(`thinkpad-led: morse step failed: ${e.message}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    isMorseSending() {
        return !!this._morse;
    }

    // Cancel any in-progress send and restore prior brightness.
    stopMorse(restore = true) {
        this._morseToken = (this._morseToken ?? 0) + 1;
        const m = this._morse;
        this._morse = null;
        if (m) {
            if (m.timerId) {
                try { GLib.source_remove(m.timerId); } catch { /* already gone */ }
                m.timerId = 0;
            }
            if (restore) {
                try {
                    writeBrightness(m.led, m.restore);
                } catch { /* ignore */ }
            }
            // Hand the LED back to its activity binding (re-arms the timer).
            this._resumeBindingForMorse(m.led?.name);
        }
        this._refreshMorseButton();
    }

    _reselect() {
        try {
            if (!this._settings)
                return;
            this._rebuildIndicator();
        } catch (e) {
            log(`thinkpad-led: reselect skipped: ${e.message}`);
        }
    }

    // Rebuild the indicator: addExternalIndicator() only wires items present at call time.
    _rebuildIndicator() {
        const detectedNames = (this._leds ?? []).map(l => l.name);
        const { visible } = selectQuickLeds(
            detectedNames, this._enabledNames(), this._quickNames(),
            this._listCustomized(), this._quickCustomized());
        const entries = visible.map(n => ({
            led: this._lookupLed(n),
            title: this._displayName(n),
        }));
        this._destroyIndicator();
        this._indicator = new LedIndicator(entries, this._onManual, this._morseApi());
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
        this._refreshMorseButton();
    }

    // Tear down: menus first (not auto-destroyed with items), then items, then the actor.
    _destroyIndicator() {
        const ind = this._indicator;
        this._indicator = null;
        if (!ind)
            return;
        try {
            for (const item of ind.quickSettingsItems ?? []) {
                try {
                    item.menu?.destroy();
                } catch { /* plain toggles have no menu */ }
                try {
                    item.destroy();
                } catch { /* already gone */ }
            }
        } catch { /* ignore */ }
        try {
            ind.destroy();
        } catch { /* ignore */ }
    }

    disable() {
        // 1. Invalidate all timer generations first.
        this._pollToken = (this._pollToken ?? 0) + 1;
        this._bindToken = (this._bindToken ?? 0) + 1;
        this._morseToken = (this._morseToken ?? 0) + 1;
        // 2. Cancel morse send, restore brightness.
        const morse = this._morse;
        this._morse = null;
        if (morse) {
            if (morse.timerId) {
                try { GLib.source_remove(morse.timerId); } catch { /* already gone */ }
                morse.timerId = 0;
            }
            try {
                writeBrightness(morse.led, morse.restore);
            } catch { /* ignore */ }
        }
        // 3. Remove the activity monitor timer.
        if (this._monitorId) {
            try { GLib.source_remove(this._monitorId); } catch { /* already gone */ }
            this._monitorId = 0;
        }
        // 4. Remove bound-LED timers, restore manual values.
        if (this._bindState) {
            for (const [, st] of this._bindState) {
                if (st.timerId) {
                    try { GLib.source_remove(st.timerId); } catch { /* already gone */ }
                    st.timerId = 0;
                }
                if (!st.override) {
                    try {
                        writeBrightness(st.led, st.manual);
                    } catch { /* ignore */ }
                }
            }
            this._bindState.clear();
            this._bindState = null;
        }
        this._activity = null;
        this._onManual = null;
        for (const id of this._settingsChangedIds ?? []) {
            try {
                this._settings?.disconnect(id);
            } catch { /* already disconnected */ }
        }
        this._settingsChangedIds = [];
        this._settings = null;
        // 5. Destroy quick-settings items last.
        this._destroyIndicator();
        this._leds = [];
    }
}
