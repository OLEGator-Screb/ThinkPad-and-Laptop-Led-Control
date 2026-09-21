/* ThinkPad and Laptop LED Control — preferences.
 * Settings keys: led-list, led-names, led-quick, led-binding, morse-text, morse-led, morse-unit.
 */
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Gio from 'gi://Gio';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';

import {
    SYSFS_LEDS, DEFAULT_MORSE_UNIT_MS, textToMorseEvents, keepLed, readIntFile,
} from './utils.js';

/* One active Morse sender per prefs process: the per-LED test senders and
 * the global Morse sender share this owner slot. Starting any send stops
 * the previous owner first (restoring its LED brightness) before claiming
 * the slot, so two senders can never drive sysfs at the same time. */
let prefsMorseOwner = null;
function claimPrefsMorseOwner(owner) {
    if (prefsMorseOwner && prefsMorseOwner !== owner) {
        try {
            prefsMorseOwner.stop(true);
        } catch { /* ignore */ }
        try {
            prefsMorseOwner.preempted?.();
        } catch { /* ignore */ }
    }
    prefsMorseOwner = owner;
}
function releasePrefsMorseOwner(owner) {
    if (prefsMorseOwner === owner)
        prefsMorseOwner = null;
}

function detectLEDs() {
    const leds = [];
    try {
        const dir = Gio.File.new_for_path(SYSFS_LEDS);
        if (!dir.query_exists(null))
            return leds;
        const enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (!keepLed(name))
                continue;
            leds.push({
                name,
                brightness: readIntFile(`${SYSFS_LEDS}/${name}/brightness`) ?? 0,
                max: Math.max(1, readIntFile(`${SYSFS_LEDS}/${name}/max_brightness`) ?? 1),
            });
        }
        try { enumerator.close(null); } catch { /* ignore */ }
    } catch (e) {
        log(`thinkpad-led prefs: enumerate failed: ${e.message}`);
    }
    return leds;
}

export default class ThinkpadLedPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({ title: 'ThinkPad LEDs', iconName: 'input-keyboard-symbolic' });
        const group = new Adw.PreferencesGroup({
            title: 'Detected LEDs',
            description: 'Toggle which LEDs are managed. Empty list means autodetect all. Sliders set live brightness (0..max).',
        });
        page.add(group);
        window.add(page);

        const leds = detectLEDs();
        if (leds.length === 0) {
            group.add(new Adw.ActionRow({
                title: 'No LEDs found',
                subtitle: `Nothing matching tpacpi::*, platform::*, input*::* under ${SYSFS_LEDS}`,
            }));
            return;
        }

        const syncEnabled = () => {
            try { return new Set(settings.get_strv('led-list')); } catch { return new Set(); }
        };
        // Empty led-list = autodetect unless led-list-custom.
        const listCustomized = () => {
            try { return settings.get_boolean('led-list-custom'); } catch { return false; }
        };
        const getNames = () => {
            try { return settings.get_value('led-names').deep_unpack() ?? {}; } catch { return {}; }
        };
        const setNames = dict => settings.set_value('led-names', new GLib.Variant('a{ss}', dict));
        const displayName = name => getNames()[name] || name;
        const syncQuick = () => {
            try { return new Set(settings.get_strv('led-quick')); } catch { return new Set(); }
        };
        // Empty led-quick = show all unless led-quick-custom.
        const quickCustomized = () => {
            try { return settings.get_boolean('led-quick-custom'); } catch { return false; }
        };
        const getBindings = () => {
            try { return settings.get_value('led-binding').deep_unpack() ?? {}; } catch { return {}; }
        };
        const setBindings = dict => settings.set_value('led-binding', new GLib.Variant('a{ss}', dict));
        const parseBinding = value => {
            if (typeof value !== 'string')
                return { source: 0, mode: 0 };
            const [source, mode] = value.split(':');
            return {
                source: source === 'disk' ? 1 : source === 'net' ? 2 : 0,
                mode: mode === 'pulse' ? 1 : 0,
            };
        };

        for (const led of leds) {
            const expander = new Adw.ExpanderRow({ title: displayName(led.name), subtitle: led.name });
            group.add(expander);

            const enabledSet = syncEnabled();
            const active = listCustomized() ? enabledSet.has(led.name) : true;

            const enableRow = new Adw.SwitchRow({ title: 'Enabled', subtitle: `brightness ${led.brightness}/${led.max}`, active });
            enableRow.connect('notify::active', () => {
                const set = syncEnabled();
                // First toggle: seed the set so "empty = all" converts cleanly.
                if (!listCustomized() && set.size === 0 && enableRow.active === false) {
                    for (const l of leds)
                        set.add(l.name);
                }
                if (enableRow.active)
                    set.add(led.name);
                else
                    set.delete(led.name);
                // All on again: restore the default empty state.
                const allEnabled = leds.every(l => set.has(l.name));
                settings.set_boolean('led-list-custom', !allEnabled);
                settings.set_strv('led-list', allEnabled ? [] : [...set]);
            });
            expander.add_row(enableRow);

            const nameRow = new Adw.EntryRow({ title: 'Display name', text: getNames()[led.name] ?? '' });
            nameRow.connect('changed', () => {
                const dict = getNames();
                const t = nameRow.get_text().trim();
                if (t)
                    dict[led.name] = t;
                else
                    delete dict[led.name];
                setNames(dict);
                expander.title = displayName(led.name);
            });
            expander.add_row(nameRow);

            const quickSet = syncQuick();
            const quickActive = quickCustomized() ? quickSet.has(led.name) : true;
            const quickRow = new Adw.SwitchRow({ title: 'Show in quick settings', active: quickActive });
            quickRow.connect('notify::active', () => {
                const set = syncQuick();
                // First toggle: seed the set so "empty = all" converts cleanly.
                if (!quickCustomized() && set.size === 0 && quickRow.active === false) {
                    for (const l of leds)
                        set.add(l.name);
                }
                if (quickRow.active)
                    set.add(led.name);
                else
                    set.delete(led.name);
                // All shown again: restore the default empty state.
                const allShown = leds.every(l => set.has(l.name));
                settings.set_boolean('led-quick-custom', !allShown);
                settings.set_strv('led-quick', allShown ? [] : [...set]);
            });
            expander.add_row(quickRow);

            const parsed = parseBinding(getBindings()[led.name]);
            const sourceRow = new Adw.ComboRow({
                title: 'Activity source',
                model: Gtk.StringList.new(['None', 'Disk', 'Network']),
                selected: parsed.source,
            });
            expander.add_row(sourceRow);

            const modeRow = new Adw.ComboRow({
                title: 'Activity mode',
                model: Gtk.StringList.new(['Blink on-off', 'Pulse brightness']),
                selected: parsed.mode,
                sensitive: parsed.source !== 0,
            });
            expander.add_row(modeRow);

            const persistBinding = () => {
                const dict = getBindings();
                const src = sourceRow.selected;
                if (src === 0) {
                    delete dict[led.name];
                } else {
                    const source = src === 1 ? 'disk' : 'net';
                    const mode = modeRow.selected === 1 ? 'pulse' : 'blink';
                    dict[led.name] = `${source}:${mode}`;
                }
                setBindings(dict);
            };
            sourceRow.connect('notify::selected', () => {
                modeRow.sensitive = sourceRow.selected !== 0;
                persistBinding();
            });
            modeRow.connect('notify::selected', () => {
                if (sourceRow.selected !== 0)
                    persistBinding();
            });

            const adj = new Gtk.Adjustment({ lower: 0, upper: led.max, step_increment: 1, value: led.brightness });
            const scale = new Gtk.Scale({ adjustment: adj, digits: 0, hexpand: true, draw_value: true });
            scale.connect('value-changed', () => {
                const v = Math.round(scale.get_value());
                try {
                    Gio.File.new_for_path(`${SYSFS_LEDS}/${led.name}/brightness`)
                        .replace_contents(new TextEncoder().encode(`${v}`), null, false, Gio.FileCreateFlags.NONE, null);
                    enableRow.subtitle = `brightness ${v}/${led.max}`;
                } catch (e) {
                    enableRow.subtitle = `write failed (need udev rule?): ${e.message}`;
                }
            });
            const sliderRow = new Adw.ActionRow({ title: 'Brightness' });
            sliderRow.add_suffix(scale);
            expander.add_row(sliderRow);

            // Per-LED Morse test sender (one-shot chain with generation guard).
            const testRow = new Adw.ActionRow({ title: 'Morse test send', subtitle: 'Idle — sends saved message, or SOS' });
            const testBtn = new Gtk.Button({ label: 'Send' });
            const tState = { timerId: 0, gen: 0, restore: 0 };
            const tStop = restore => {
                tState.gen += 1;
                if (tState.timerId) {
                    try { GLib.source_remove(tState.timerId); } catch { /* already gone */ }
                    tState.timerId = 0;
                }
                if (restore) {
                    try {
                        Gio.File.new_for_path(`${SYSFS_LEDS}/${led.name}/brightness`)
                            .replace_contents(new TextEncoder().encode(`${tState.restore}`),
                                null, false, Gio.FileCreateFlags.NONE, null);
                    } catch { /* ignore */ }
                }
                testBtn.label = 'Send';
                releasePrefsMorseOwner(tOwner);
            };
            // Shared owner slot: starting this test send preempts the global
            // Morse sender (or another LED's test) and vice versa.
            const tOwner = {
                stop: r => tStop(r),
                preempted: () => { testRow.subtitle = 'Stopped'; },
            };
            const tStep = (events, index, gen, unit) => {
                if (gen !== tState.gen)
                    return;
                if (index >= events.length) {
                    tStop(true);
                    testRow.subtitle = 'Done';
                    return;
                }
                const ev = events[index];
                try {
                    Gio.File.new_for_path(`${SYSFS_LEDS}/${led.name}/brightness`)
                        .replace_contents(new TextEncoder().encode(ev.on ? `${led.max}` : '0'),
                            null, false, Gio.FileCreateFlags.NONE, null);
                } catch (e) {
                    testRow.subtitle = `Write failed (need udev rule?): ${e.message}`;
                    tStop(true);
                    return;
                }
                testRow.subtitle = `Sending… ${index + 1}/${events.length}`;
                tState.timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                    Math.max(1, ev.units * unit), () => {
                        if (gen !== tState.gen)
                            return GLib.SOURCE_REMOVE;
                        tState.timerId = 0;
                        tStep(events, index + 1, gen, unit);
                        return GLib.SOURCE_REMOVE;
                    });
            };
            testBtn.connect('clicked', () => {
                if (tState.timerId) {
                    tStop(true);
                    testRow.subtitle = 'Stopped';
                    return;
                }
                tStop(false);
                let text = '';
                try { text = settings.get_string('morse-text') ?? ''; } catch { /* default below */ }
                if (!text.trim())
                    text = 'SOS';
                const events = textToMorseEvents(text);
                if (events.length === 0) {
                    testRow.subtitle = 'Nothing to send — use A–Z, 0–9 and spaces.';
                    return;
                }
                let unit = DEFAULT_MORSE_UNIT_MS;
                try { unit = Math.max(20, Math.min(1000, settings.get_int('morse-unit'))); } catch { /* default */ }
                tState.restore = readIntFile(`${SYSFS_LEDS}/${led.name}/brightness`) ?? 0;
                claimPrefsMorseOwner(tOwner);
                const gen = tState.gen;
                testBtn.label = 'Stop';
                tStep(events, 0, gen, unit);
            });
            testRow.add_suffix(testBtn);
            expander.add_row(testRow);
        }

        settings.connect('changed::led-list', () => {
            // Live UI left as-is.
        });
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => false);

        this._fillMorseGroup(page, window, settings, leds);
    }

    _fillMorseGroup(page, window, settings, leds) {
        const group = new Adw.PreferencesGroup({
            title: 'Morse sender',
            description: 'Blink a message in ITU Morse (A–Z, 0–9). Timing: dot = 1 unit, dash = 3, intra-character gap = 1, letter gap = 3, word gap = 7 units. Message, target and unit are shared with the Quick Settings Morse button.',
        });
        page.add(group);

        if (leds.length === 0) {
            group.add(new Adw.ActionRow({ title: 'No LEDs available for Morse' }));
            return;
        }

        const clampUnit = u => Math.max(20, Math.min(1000, Number.isFinite(u) ? u : DEFAULT_MORSE_UNIT_MS));
        let savedUnit = DEFAULT_MORSE_UNIT_MS;
        try {
            savedUnit = clampUnit(settings.get_int('morse-unit'));
        } catch { /* use default */ }
        let savedText = '';
        try {
            savedText = settings.get_string('morse-text') ?? '';
        } catch { /* use default */ }
        let savedLed = '';
        try {
            savedLed = settings.get_string('morse-led') ?? '';
        } catch { /* use default */ }

        const names = leds.map(l => l.name);
        const targetRow = new Adw.ComboRow({
            title: 'Target LED',
            model: Gtk.StringList.new(names),
            selected: Math.max(0, names.indexOf(savedLed)),
        });
        targetRow.connect('notify::selected', () => {
            settings.set_string('morse-led', names[targetRow.selected] ?? '');
        });
        // Persist the default selection so quick settings has a target.
        if (!savedLed || !names.includes(savedLed))
            settings.set_string('morse-led', names[targetRow.selected] ?? '');
        group.add(targetRow);

        const textRow = new Adw.EntryRow({ title: 'Message (A–Z, 0–9)', text: savedText });
        textRow.connect('changed', () => {
            settings.set_string('morse-text', textRow.get_text());
            sendBtn.sensitive = textRow.get_text().trim().length > 0;
        });
        group.add(textRow);

        const unitAdj = new Gtk.Adjustment({
            lower: 20, upper: 1000, step_increment: 5, page_increment: 10, value: savedUnit,
        });
        const unitSpin = new Gtk.SpinButton({ adjustment: unitAdj, digits: 0, numeric: true });
        unitSpin.connect('value-changed', () => {
            settings.set_int('morse-unit', Math.round(unitSpin.get_value()));
        });
        const unitRow = new Adw.ActionRow({ title: 'Dot unit (ms)' });
        unitRow.add_suffix(unitSpin);
        group.add(unitRow);

        const statusRow = new Adw.ActionRow({ title: 'Status', subtitle: 'Idle' });
        group.add(statusRow);

        // Prefs runs in its own process: local one-shot chain with generation guard.
        const morse = { timerId: 0, gen: 0, led: null, restore: 0 };
        const setStatus = s => { statusRow.subtitle = s; };
        const stopMorse = restore => {
            morse.gen += 1;
            if (morse.timerId) {
                GLib.source_remove(morse.timerId);
                morse.timerId = 0;
            }
            if (restore && morse.led) {
                try {
                    Gio.File.new_for_path(`${SYSFS_LEDS}/${morse.led.name}/brightness`)
                        .replace_contents(new TextEncoder().encode(`${morse.restore}`),
                            null, false, Gio.FileCreateFlags.NONE, null);
                } catch { /* ignore */ }
            }
            morse.led = null;
            sendBtn.sensitive = textRow.get_text().trim().length > 0;
            stopBtn.sensitive = false;
            releasePrefsMorseOwner(gOwner);
        };
        // Shared owner slot: starting the global send preempts any per-LED
        // test send and vice versa (brightness is restored by stop()).
        const gOwner = {
            stop: r => stopMorse(r),
            preempted: () => setStatus('Stopped'),
        };
        const applyStep = (led, restore, unit, events, index, gen) => {
            if (gen !== morse.gen)
                return;
            if (index >= events.length) {
                stopMorse(true);
                setStatus('Done');
                return;
            }
            const ev = events[index];
            try {
                Gio.File.new_for_path(`${SYSFS_LEDS}/${led.name}/brightness`)
                    .replace_contents(new TextEncoder().encode(ev.on ? `${led.max}` : '0'),
                        null, false, Gio.FileCreateFlags.NONE, null);
            } catch (e) {
                setStatus(`Write failed (need udev rule?): ${e.message}`);
                stopMorse(true);
                return;
            }
            setStatus(`Sending… symbol ${index + 1}/${events.length}`);
            morse.timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                Math.max(1, ev.units * unit), () => {
                    if (gen !== morse.gen)
                        return GLib.SOURCE_REMOVE;
                    morse.timerId = 0;
                    applyStep(led, restore, unit, events, index + 1, gen);
                    return GLib.SOURCE_REMOVE;
                });
        };

        const sendBtn = new Gtk.Button({ label: 'Send', css_classes: ['suggested-action'] });
        const stopBtn = new Gtk.Button({ label: 'Stop', sensitive: false });
        sendBtn.sensitive = textRow.get_text().trim().length > 0;
        sendBtn.connect('clicked', () => {
            stopMorse(true);
            const text = textRow.get_text();
            const ledName = names[targetRow.selected] ?? '';
            const unit = Math.round(unitSpin.get_value());
            settings.set_string('morse-text', text);
            settings.set_string('morse-led', ledName);
            settings.set_int('morse-unit', unit);
            const events = textToMorseEvents(text);
            const led = leds.find(l => l.name === ledName) ?? leds[0];
            if (events.length === 0 || !led) {
                setStatus('Nothing to send — use A–Z, 0–9 and spaces.');
                return;
            }
            morse.led = led;
            morse.restore = readIntFile(`${SYSFS_LEDS}/${led.name}/brightness`) ?? 0;
            claimPrefsMorseOwner(gOwner);
            const gen = morse.gen;
            sendBtn.sensitive = false;
            stopBtn.sensitive = true;
            applyStep(led, morse.restore, clampUnit(unit), events, 0, gen);
        });
        stopBtn.connect('clicked', () => {
            stopMorse(true);
            setStatus('Stopped');
        });
        const sendRow = new Adw.ActionRow({ title: 'Transmit' });
        sendRow.add_suffix(sendBtn);
        sendRow.add_suffix(stopBtn);
        group.add(sendRow);
    }
}
