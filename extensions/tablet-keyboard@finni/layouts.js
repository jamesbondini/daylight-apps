// iPad-style pages built around the letter rows of GNOME's own OSK layout for
// the active input source, so the keyboard follows the system layout.

import Gio from 'gi://Gio';

// Width of the empty middle of a split keyboard, relative to the keys
const SPLIT_GAP = 0.56;

const FALLBACK_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

// Swipe-down characters, by position, like the iPad's flick keys.
const LETTER_ALTS = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['@', '#', '$', '&', '*', '(', ')', "'", '"'],
    ['%', '-', '+', '=', '/', ';', ':'],
];

const DEFAULT_ACCENTS = {
    a: ['à', 'á', 'â', 'ä', 'æ', 'ã', 'å', 'ā'],
    c: ['ç', 'ć', 'č'],
    e: ['è', 'é', 'ê', 'ë', 'ē', 'ė', 'ę'],
    i: ['î', 'ï', 'í', 'ī', 'į', 'ì'],
    l: ['ł'],
    n: ['ñ', 'ń'],
    o: ['ô', 'ö', 'ò', 'ó', 'œ', 'ø', 'ō', 'õ'],
    s: ['ß', 'ś', 'š'],
    u: ['û', 'ü', 'ù', 'ú', 'ū'],
    y: ['ÿ'],
    z: ['ž', 'ź', 'ż'],
};

const SYMBOL_ACCENTS = {
    '.': ['…'],
    '-': ['–', '—', '•'],
    '$': ['¢', '€', '£', '¥', '₩', '₽'],
    '?': ['¿'],
    '!': ['¡'],
    '"': ['“', '”', '„', '«', '»'],
    "'": ['‘', '’', '‚', '‹', '›', '`'],
    '&': ['§'],
    '%': ['‰'],
    '/': ['\\'],
    '0': ['°'],
};

function loadModel(name) {
    const file = Gio.File.new_for_uri(
        `resource:///org/gnome/shell/osk-layouts/${name}.json`);
    const [, contents] = file.load_contents(null);
    return JSON.parse(new TextDecoder().decode(contents));
}

// Returns three rows of {text, accents} for the xkb layout `group`.
function letterRows(group) {
    const isLetter = s => /^\p{L}$/u.test(s);

    for (const name of [group, group.split('+')[0], 'us']) {
        try {
            const level = loadModel(name).levels.find(l => l.level === 'default');
            const rows = level.rows
                .map(row => row
                    .filter(k => k.strings?.length && isLetter(k.strings[0]))
                    .map(k => ({
                        text: k.strings[0],
                        accents: k.strings.slice(1).filter(isLetter),
                    })))
                .filter(row => row.length > 0)
                .slice(0, 3);
            if (rows.length === 3)
                return rows;
        } catch {
            // Layout missing or malformed, try the next candidate
        }
    }

    return FALLBACK_ROWS.map(row => [...row].map(text => ({text, accents: []})));
}

function charKey(text, alt = null, accents = null) {
    return {
        kind: 'char',
        text,
        alt,
        accents: accents?.length ? accents
            : DEFAULT_ACCENTS[text] ?? SYMBOL_ACCENTS[text] ?? [],
    };
}

function bottomRow(units, page, label, {multiSource, voice}) {
    const side = [];
    if (multiSource)
        side.push({kind: 'globe', icon: 'osk-layout-symbolic', width: 1.1});
    side.push({kind: 'emoji', icon: 'osk-emoji-picker-symbolic', width: 1.1});
    if (voice)
        side.push({kind: 'voice', icon: 'audio-input-microphone-symbolic', width: 1.1});
    const pageKey = {kind: 'page', page, label, width: 1.5};
    const hide = {kind: 'hide', icon: 'osk-hide-symbolic', width: 1.1};
    const used = side.reduce((sum, k) => sum + k.width, 0) + 2 * pageKey.width + hide.width;

    return [
        ...side,
        pageKey,
        {kind: 'space', width: units - used},
        {...pageKey},
        hide,
    ];
}

function deleteKey(width) {
    return {kind: 'delete', icon: 'osk-delete-symbolic', width};
}

function returnKey(width) {
    return {kind: 'return', icon: 'osk-enter-symbolic', width};
}

function shiftKey(width) {
    return {kind: 'shift', icon: 'osk-shift-symbolic', width};
}

function lettersPage(group, opts) {
    const [r1, r2, r3] = letterRows(group);
    const units = Math.max(r1.length + 1.4, r2.length + 1.9, r3.length + 4.4);
    const indent = Math.max(0, Math.min(0.5, units - r2.length - 1.4));
    const shiftWidth = (units - r3.length - 2) / 2;
    const withAlts = (row, alts) =>
        row.map((k, i) => charKey(k.text, alts[i] ?? null, k.accents));

    return {
        units,
        rows: [
            [...withAlts(r1, LETTER_ALTS[0]), deleteKey(units - r1.length)],
            [
                ...(indent > 0 ? [{kind: 'gap', width: indent}] : []),
                ...withAlts(r2, LETTER_ALTS[1]),
                returnKey(units - indent - r2.length),
            ],
            [
                shiftKey(shiftWidth),
                ...withAlts(r3, LETTER_ALTS[2]),
                charKey(',', '!'),
                charKey('.', '?'),
                shiftKey(shiftWidth),
            ],
            bottomRow(units, 'numbers', '.?123', opts),
        ],
    };
}

function symbolPage(rows, alts, otherPage, otherLabel, opts) {
    const units = 11.4;
    const chars = (row, rowAlts = []) =>
        [...row].map((c, i) => charKey(c, rowAlts[i] ?? null));
    const pageKey = {kind: 'page', page: otherPage, label: otherLabel, width: 1.2};

    return {
        units,
        rows: [
            [...chars(rows[0], alts[0]), deleteKey(units - 10)],
            [{kind: 'gap', width: 0.5}, ...chars(rows[1], alts[1]), returnKey(units - 9.5)],
            [pageKey, ...chars(rows[2], alts[2]), {...pageKey}],
            bottomRow(units, 'letters', 'ABC', opts),
        ],
    };
}

// Splits a page into two halves with an untouchable gap in the middle: each
// row breaks after half of its characters, the space bar in two.
function splitPage(page) {
    const gap = Math.round(page.units * SPLIT_GAP * 10) / 10;
    const rows = page.rows.map(row => {
        const space = row.findIndex(k => k.kind === 'space');
        if (space >= 0) {
            const half = {...row[space], width: row[space].width / 2};
            return [
                ...row.slice(0, space),
                half, {kind: 'split', width: gap}, {...half},
                ...row.slice(space + 1),
            ];
        }

        const chars = row.filter(k => k.kind === 'char');
        const breakAfter = chars[Math.ceil(chars.length / 2) - 1];
        const at = row.indexOf(breakAfter) + 1;
        return [...row.slice(0, at), {kind: 'split', width: gap}, ...row.slice(at)];
    });
    return {units: page.units + gap, rows};
}

function withoutAlts(page) {
    return {
        units: page.units,
        rows: page.rows.map(row => row.map(k => (k.alt ? {...k, alt: null} : k))),
    };
}

export function buildPages(group, multiSource, {split = false, alts = true, voice = false} = {}) {
    const pages = basePages(group, {multiSource, voice});
    for (const name of Object.keys(pages)) {
        if (!alts)
            pages[name] = withoutAlts(pages[name]);
        if (split)
            pages[name] = splitPage(pages[name]);
    }
    return pages;
}

function basePages(group, opts) {
    return {
        letters: lettersPage(group, opts),
        numbers: symbolPage(
            ['1234567890', '@#$&*()\'"', '%-+=/;:,.'],
            [
                [...'[]{}#%^*+='],
                [...'_\\|~<>€£¥'],
                [null, null, null, null, null, null, null, '!', '?'],
            ],
            'symbols', '#+=', opts),
        symbols: symbolPage(
            ['[]{}#%^*+=', '_\\|~<>€£¥', '§•°.,?!\'"'],
            [[], [], []],
            'numbers', '123', opts),
    };
}
