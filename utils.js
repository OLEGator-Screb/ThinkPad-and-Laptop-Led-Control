/* ThinkPad LED — shared pure helpers for extension.js and prefs.js.
 * GNOME 45+ loads both files as ESM, so a relative './utils.js' import
 * works in either context. No behavior change: byte-identical logic moved here.
 */
import Gio from 'gi://Gio';

export const SYSFS_LEDS = '/sys/class/leds';
export const DEFAULT_MORSE_UNIT_MS = 120;
export const MORSE_UNIT_MIN = 20;
export const MORSE_UNIT_MAX = 1000;
export const MORSE_UNIT_STEP = 10;

/** ITU Morse for letters A-Z and digits 0-9. */
export const MORSE_TABLE = {
    A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.',
    G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..',
    M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.',
    S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-',
    Y: '-.--', Z: '--..',
    '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-',
    '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.',
};

/**
 * Convert text to a list of {on, units} blink events.
 * Dot = 1 unit on, dash = 3 units on, intra-character gap = 1 unit off,
 * letter gap = 3 units off, word gap = 7 units off. Unknown chars skipped.
 */
export function textToMorseEvents(text) {
    const events = [];
    const up = `${text ?? ''}`.toUpperCase();
    const isSpace = c => c === ' ' || c === '\t' || c === '\n' || c === '\r';
    for (let i = 0; i < up.length; i++) {
        const c = up[i];
        if (isSpace(c)) {
            if (events.length > 0) {
                const last = events[events.length - 1];
                if (last.on)
                    events.push({ on: false, units: 7 });
                else
                    last.units = Math.max(last.units, 7);
            }
            continue;
        }
        const code = MORSE_TABLE[c];
        if (!code)
            continue;
        for (let j = 0; j < code.length; j++) {
            events.push({ on: true, units: code[j] === '.' ? 1 : 3 });
            if (j < code.length - 1)
                events.push({ on: false, units: 1 });
        }
        // Letter gap, unless the next meaningful char is a space (it emits the word gap).
        let k = i + 1;
        while (k < up.length && !isSpace(up[k]) && !MORSE_TABLE[up[k]])
            k++;
        if (k < up.length && !isSpace(up[k]))
            events.push({ on: false, units: 3 });
    }
    return events;
}

/**
 * LED name filter. Mirrors 90-thinkpad-led.rules:
 * tpacpi::*, platform::*, input*::* (all live input LEDs are input<N>::<name>,
 * e.g. input3::capslock, so the '::' requirement matches every one of them).
 */
export function keepLed(name) {
    return name.startsWith('tpacpi::') || name.startsWith('platform::') ||
        (name.startsWith('input') && name.includes('::'));
}

export function clampMorseUnit(unit) {
    const u = Math.round(Number(unit));
    if (!Number.isFinite(u))
        return DEFAULT_MORSE_UNIT_MS;
    return Math.max(MORSE_UNIT_MIN, Math.min(MORSE_UNIT_MAX, u));
}

export function readTextFile(path) {
    try {
        const file = Gio.File.new_for_path(path);
        const [ok, contents] = file.load_contents(null);
        if (!ok)
            return null;
        return new TextDecoder().decode(contents);
    } catch {
        return null;
    }
}

export function readIntFile(path) {
    try {
        const file = Gio.File.new_for_path(path);
        const [ok, contents] = file.load_contents(null);
        if (!ok)
            return null;
        const v = parseInt(new TextDecoder().decode(contents).trim(), 10);
        return Number.isNaN(v) ? null : v;
    } catch {
        return null;
    }
}

export function writeIntFile(path, value) {
    try {
        const file = Gio.File.new_for_path(path);
        const data = new TextEncoder().encode(`${value}`);
        file.replace_contents(data, null, false, Gio.FileCreateFlags.NONE, null);
        return true;
    } catch (e) {
        log(`thinkpad-led: write ${path} failed: ${e.message}`);
        return false;
    }
}
