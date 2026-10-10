// An iPad-style key area for GNOME Shell's on-screen keyboard.
//
// TabletKeyboard subclasses the shell's Keyboard so showing/hiding, moving the
// focused window out of the way, emoji and text delivery keep working, and
// replaces only the key layout and touch handling.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as KeyboardUI from 'resource:///org/gnome/shell/ui/keyboard.js';
import * as InputSourceManager from 'resource:///org/gnome/shell/ui/status/keyboard.js';

import {findCorrection} from './autocorrect.js';
import {buildPages, variantFor} from './layouts.js';
import {Dictation} from './voice.js';

const LONG_PRESS_MS = 450;
const TRACKPAD_PRESS_MS = 400;
const DELETE_REPEAT_MS = 450;
const DELETE_CHAR_MS = 90;
const DELETE_WORD_MS = 280;
const DELETE_WORDS_AFTER = 12;
const SHIFT_DOUBLE_TAP_MS = 350;
const DOUBLE_SPACE_MS = 1200;
const TYPING_QUIET_MS = 400;
const FLICK_START_PX = 10;
const RESET_MS = 140;
// Holding the mic key longer than this is push-to-talk, shorter toggles
const VOICE_HOLD_MS = 350;

const TERMINAL_WM_CLASS = /ghostty|terminal|kgx|console|alacritty|kitty|foot|wezterm|konsole|xterm/i;
const {InputContentPurpose: Purpose, InputContentHintFlags: Hint} = Clutter;
// Not every purpose exists in every Clutter version
const purposes = (...names) => new Set(names.map(n => Purpose[n]).filter(p => p !== undefined));
const TEXT_PURPOSES = purposes('NORMAL', 'ALPHA', 'NAME');
const CORRECTION_TRIGGERS = /^[.,!?;:]$/;

// The extension object, for settings and the preferences window
let extension = null;

export function setExtension(ext) {
    extension = ext;
}

function upper(text) {
    const up = text.toLocaleUpperCase();
    return [...up].length === 1 ? up : text;
}

function centerPivot() {
    return new Graphene.Point({x: 0.5, y: 0.5});
}

// Height profile of the voice key's level bars, tallest in the middle
const VOICE_BARS = [0.45, 0.75, 1, 0.75, 0.45];
const VOICE_LEVEL_MS = 60;

// Color schemes besides light, which has no class
const THEME_CLASSES = ['tk-dark', 'tk-mono'];
// Behind the keyboard, matching #keyboard in the stylesheet
const PANEL_COLORS = {light: '#d1d3d9', dark: '#2b2b2d', mono: '#ffffff'};

// Bars inside the mic key: they follow the microphone while recording and
// run a wave while transcribing
const VoiceMeter = GObject.registerClass(
class TabletVoiceMeter extends St.BoxLayout {
    _init() {
        super._init({style_class: 'tk-voice-bars', visible: false});
        this._level = 0;
        this._bars = VOICE_BARS.map(() => {
            const bar = new St.Widget({
                style_class: 'tk-voice-bar',
                y_align: Clutter.ActorAlign.CENTER,
                pivot_point: centerPivot(),
                scale_y: 0.2,
            });
            this.add_child(bar);
            return bar;
        });
    }

    setSize(height) {
        const width = Math.max(2, Math.round(height / 7));
        this.style = `spacing: ${Math.round(width * 0.8)}px;`;
        for (const bar of this._bars)
            bar.style = `width: ${width}px; height: ${height}px; border-radius: ${width / 2}px;`;
    }

    // level from 0 to 1, or null when unknown
    setLevel(level) {
        // Rise at once, fall gently
        this._level = Math.max(level ?? 0, this._level * 0.75);
        this._bars.forEach((bar, i) => {
            const jitter = 0.7 + Math.random() * 0.3;
            bar.ease({
                scale_y: Math.max(0.2, this._level * VOICE_BARS[i] * jitter),
                duration: VOICE_LEVEL_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        });
    }

    startWave() {
        this.reset();
        this._bars.forEach((bar, i) => {
            bar.ease({
                scale_y: 0.8,
                delay: i * 110,
                duration: 440,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                repeatCount: -1,
                autoReverse: true,
            });
        });
    }

    reset() {
        this._level = 0;
        for (const bar of this._bars) {
            bar.remove_all_transitions();
            bar.scale_y = 0.2;
        }
    }
});

const KeyActor = GObject.registerClass(
class TabletKeyActor extends St.Widget {
    _init(spec) {
        super._init({style_class: 'tk-key'});
        this.spec = spec;
        this._upper = false;
        this._altScale = 2;

        const looksLikeChar = spec.kind === 'char' || spec.kind === 'space';
        this.add_style_class_name(looksLikeChar ? 'tk-char' : 'tk-fn');
        this.add_style_class_name(`tk-${spec.kind}`);

        if (spec.icon) {
            this._icon = new St.Icon({
                style_class: 'tk-icon',
                icon_name: spec.icon,
            });
            this.add_child(this._icon);
            if (spec.kind === 'voice') {
                this._meter = new VoiceMeter();
                this.add_child(this._meter);
            }
        } else if (spec.kind !== 'space') {
            this._label = new St.Label({
                style_class: spec.kind === 'char' ? 'tk-label' : 'tk-fn-label',
                text: spec.text ?? spec.label,
                pivot_point: centerPivot(),
            });
            this.add_child(this._label);
        }

        if (spec.alt) {
            this._alt = new St.Label({
                style_class: 'tk-alt',
                text: spec.alt,
                pivot_point: centerPivot(),
            });
            this.add_child(this._alt);
        }
    }

    get text() {
        return this._upper ? upper(this.spec.text) : this.spec.text;
    }

    get accents() {
        const accents = this.spec.accents ?? [];
        return this._upper ? accents.map(upper) : accents;
    }

    setUpper(isUpper) {
        this._upper = isUpper;
        if (this.spec.kind === 'char')
            this._label.text = this.text;
    }

    setIcon(iconName) {
        if (this._icon)
            this._icon.icon_name = iconName;
    }

    // The mic key shows the microphone level while recording, a wave while
    // transcribing and a breathing download icon while fetching a model
    setVoiceState(state) {
        if (state === this._voiceState)
            return;
        this._voiceState = state;

        for (const s of ['downloading', 'recording', 'transcribing']) {
            if (state === s)
                this.add_style_class_name(`tk-${s}`);
            else
                this.remove_style_class_name(`tk-${s}`);
        }
        this.setIcon(state === 'downloading'
            ? 'folder-download-symbolic' : 'audio-input-microphone-symbolic');

        const busy = state === 'recording' || state === 'transcribing';
        this._icon.visible = !busy;
        this._meter.visible = busy;
        if (state === 'transcribing')
            this._meter.startWave();
        else
            this._meter.reset();

        this._icon.remove_all_transitions();
        this._icon.opacity = 255;
        if (state === 'downloading') {
            this._icon.ease({
                opacity: 90,
                duration: 650,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                repeatCount: -1,
                autoReverse: true,
            });
        }
    }

    setVoiceLevel(level) {
        this._meter?.setLevel(level);
    }

    applyMetrics(m) {
        if (this._label) {
            // Longer keys like .com get the smaller function key size
            const size = this.spec.kind === 'char' && [...this.spec.text].length === 1
                ? m.char : m.fn;
            this._label.style = `font-size: ${size}px;`;
        }
        if (this._alt) {
            this._alt.style = `font-size: ${m.alt}px;`;
            this._altScale = m.char / m.alt;
        }
        if (this._icon)
            this._icon.icon_size = m.icon;
        this._meter?.setSize(m.icon);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const width = box.get_width();
        const height = box.get_height();

        // Center a child horizontally with its middle at centerY
        const place = (child, centerY) => {
            const [, , natW, natH] = child.get_preferred_size();
            const childBox = new Clutter.ActorBox();
            childBox.set_origin(
                Math.round((width - natW) / 2), Math.round(centerY - natH / 2));
            childBox.set_size(natW, natH);
            child.allocate(childBox);
        };

        if (this._icon)
            place(this._icon, height / 2);
        if (this._meter)
            place(this._meter, height / 2);
        if (this._alt) {
            // Small swipe-down character on top, main one a bit lower
            const [, , , altH] = this._alt.get_preferred_size();
            place(this._alt, height * 0.08 + altH / 2);
            place(this._label, height * 0.6);
        } else if (this._label) {
            place(this._label, height / 2);
        }
    }

    // Swipe-down animation: the small top character slides into the middle
    // and grows while the main character drops away.
    setFlick(progress) {
        if (!this._alt)
            return;

        const altBox = this._alt.get_allocation_box();
        const labelBox = this._label.get_allocation_box();
        const altCenter = (altBox.y1 + altBox.y2) / 2;
        const labelCenter = (labelBox.y1 + labelBox.y2) / 2;
        const scale = 1 + (this._altScale - 1) * progress;

        this._alt.remove_all_transitions();
        this._label.remove_all_transitions();
        this._alt.translation_y = (labelCenter - altCenter) * progress;
        this._alt.set_scale(scale, scale);
        this._alt.opacity = 140 + 115 * progress;
        this._label.translation_y = this.height * 0.35 * progress;
        this._label.opacity = 255 * (1 - progress);
        this._label.set_scale(1 - 0.4 * progress, 1 - 0.4 * progress);

        if (progress >= 0.5)
            this._alt.add_style_class_name('tk-alt-active');
        else
            this._alt.remove_style_class_name('tk-alt-active');
    }

    resetFlick() {
        if (!this._alt)
            return;

        this._alt.remove_style_class_name('tk-alt-active');
        const params = {duration: RESET_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD};
        this._alt.ease({...params, translation_y: 0, scale_x: 1, scale_y: 1, opacity: 255});
        this._label.ease({...params, translation_y: 0, scale_x: 1, scale_y: 1, opacity: 255});
    }
});

// Lays the keys out on a grid of `units` per row and finds the key under a
// point, treating gaps and indents as part of the nearest key.
const KeyGrid = GObject.registerClass(
class TabletKeyGrid extends St.Widget {
    _init() {
        super._init({
            style_class: 'tk-grid',
            reactive: true,
            x_expand: true,
            y_expand: true,
        });
        this._rows = [];
        this._voids = [];
        this._units = 1;
        this._metricsSize = 0;
        this._metricsId = 0;
        this.keys = [];
        this.rowHeight = 1;
        this.unitWidth = 1;
        this.connect('destroy', () => {
            if (this._metricsId)
                GLib.source_remove(this._metricsId);
        });
    }

    setPage(page) {
        this.destroy_all_children();
        this.keys = [];
        this._voids = [];
        this._units = page.units;
        this._rows = page.rows.map((row, rowIndex) => {
            let start = 0;
            const keys = [];
            for (const spec of row) {
                const width = spec.width ?? 1;
                if (spec.kind === 'split')
                    this._voids.push({rowIndex, start, units: width});
                else if (spec.kind !== 'gap') {
                    const key = new KeyActor(spec);
                    key.rowIndex = rowIndex;
                    key.start = start;
                    key.units = width;
                    this.add_child(key);
                    keys.push(key);
                    this.keys.push(key);
                }
                start += width;
            }
            return keys;
        });
        this._metricsSize = 0;
        this._updateCells();
        this.queue_relayout();
    }

    // Hit areas, also needed right after setPage() before the next allocation
    _updateCells() {
        if (!this._contentWidth)
            return;

        const [originX] = this._origin;
        const unitWidth = this._contentWidth / this._units;
        for (const key of this.keys) {
            const x1 = originX + key.start * unitWidth;
            key.cell = {x1, x2: x1 + key.units * unitWidth};
        }
    }

    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(_forWidth) {
        return [0, 0];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        if (this._rows.length === 0)
            return;

        // Children are positioned relative to our own origin
        const ownBox = new Clutter.ActorBox();
        ownBox.set_size(box.get_width(), box.get_height());
        const content = this.get_theme_node().get_content_box(ownBox);
        const originX = content.x1;
        const originY = content.y1;
        const rowHeight = content.get_height() / this._rows.length;
        const unitWidth = content.get_width() / this._units;
        const gapY = Math.round(rowHeight * 0.17);
        const gapX = Math.min(Math.round(unitWidth * 0.14), gapY);

        this.rowHeight = rowHeight;
        this.unitWidth = unitWidth;
        this._origin = [originX, originY];
        this._contentWidth = content.get_width();
        this._updateCells();

        const childBox = new Clutter.ActorBox();
        for (const key of this.keys) {
            const x1 = originX + key.start * unitWidth;
            const x2 = x1 + key.units * unitWidth;
            const y1 = originY + key.rowIndex * rowHeight;
            childBox.set_origin(Math.round(x1 + gapX / 2), Math.round(y1 + gapY / 2));
            childBox.set_size(
                Math.round(x2 - x1 - gapX), Math.round(rowHeight - gapY));
            key.allocate(childBox);
        }

        const keyHeight = Math.round(rowHeight - gapY);
        if (keyHeight !== this._metricsSize && !this._metricsId) {
            // Restyling during allocation would queue another relayout
            this._metricsId = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
                this._metricsId = 0;
                this._applyMetrics(keyHeight);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _applyMetrics(keyHeight) {
        this._metricsSize = keyHeight;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // CSS px are scaled by St
        const px = v => Math.max(1, Math.round(v / scale));
        this.metrics = {
            char: px(keyHeight * 0.4),
            fn: px(keyHeight * 0.26),
            alt: px(keyHeight * 0.2),
            icon: px(keyHeight * 0.36),
        };
        for (const key of this.keys)
            key.applyMetrics(this.metrics);
    }

    keyAt(x, y) {
        if (this._rows.length === 0)
            return null;

        const [originX, originY] = this._origin ?? [0, 0];
        const rowIndex = Math.clamp(
            Math.floor((y - originY) / this.rowHeight), 0, this._rows.length - 1);

        // The middle of a split keyboard types nothing
        const unit = (x - originX) / this.unitWidth;
        if (this._voids.some(v => v.rowIndex === rowIndex && unit > v.start && unit < v.start + v.units))
            return null;

        let best = null, bestDistance = Infinity;
        for (const key of this._rows[rowIndex]) {
            if (!key.cell)
                continue;
            const distance = x < key.cell.x1 ? key.cell.x1 - x
                : x > key.cell.x2 ? x - key.cell.x2 : 0;
            if (distance < bestDistance) {
                best = key;
                bestDistance = distance;
            }
        }
        return best;
    }
});

// Floating popups live in uiGroup so they can extend above the keyboard.
const KeyPreview = GObject.registerClass(
class TabletKeyPreview extends St.Bin {
    _init() {
        super._init({style_class: 'tk-preview', visible: false});
        this._label = new St.Label({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.child = this._label;
        Main.layoutManager.uiGroup.add_child(this);
    }

    showFor(key, text, theme) {
        const [kx, ky] = key.get_transformed_position();
        const [kw, kh] = key.get_transformed_size();
        const width = Math.round(kw * 1.3);
        const height = Math.round(kh * 1.2);
        const monitor = Main.layoutManager.keyboardMonitor;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;

        this._label.text = text;
        this._label.style = `font-size: ${Math.round(kh * 0.55 / scale)}px;`;
        this.set_size(width, height);
        this.set_position(
            Math.clamp(Math.round(kx + kw / 2 - width / 2), monitor.x, monitor.x + monitor.width - width),
            Math.round(ky - height - kh * 0.1));
        this._setTheme(theme);
        Main.layoutManager.uiGroup.set_child_above_sibling(this, null);
        this.show();
    }

    _setTheme(theme) {
        for (const name of THEME_CLASSES)
            this.remove_style_class_name(name);
        if (theme)
            this.add_style_class_name(theme);
    }
});

const AccentPopup = GObject.registerClass(
class TabletAccentPopup extends St.BoxLayout {
    _init(key, items, theme, {widthScale = 1, fontScale = 0.42} = {}) {
        super._init({style_class: 'tk-accents'});
        if (theme)
            this.add_style_class_name(theme);

        const [kx, ky] = key.get_transformed_position();
        const [kw, kh] = key.get_transformed_size();
        const monitor = Main.layoutManager.keyboardMonitor;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const cellWidth = Math.round(kw * widthScale);
        const width = cellWidth * items.length;

        // Grow to the right of the key, or to the left near the right edge
        const growLeft = kx + width > monitor.x + monitor.width;
        const ordered = growLeft ? [...items].reverse() : items;

        this._items = ordered;
        this._labels = ordered.map(text => {
            const cell = new St.Bin({
                style_class: 'tk-accent',
                child: new St.Label({
                    text,
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                    style: `font-size: ${Math.round(kh * fontScale / scale)}px;`,
                }),
            });
            cell.set_size(cellWidth, Math.round(kh));
            this.add_child(cell);
            return cell;
        });

        let x = growLeft ? kx + kw - width : kx;
        x = Math.clamp(Math.round(x), monitor.x, monitor.x + monitor.width - width);
        this._x = x;
        this._cellWidth = cellWidth;
        this.set_position(x, Math.round(ky - kh * 1.15));
        Main.layoutManager.uiGroup.add_child(this);

        this.selected = growLeft ? ordered.length - 1 : 0;
        this._sync();
    }

    selectAt(stageX) {
        const index = Math.clamp(
            Math.floor((stageX - this._x) / this._cellWidth), 0, this._items.length - 1);
        if (index !== this.selected) {
            this.selected = index;
            this._sync();
        }
    }

    get selectedText() {
        return this._items[this.selected];
    }

    _sync() {
        this._labels.forEach((label, i) => {
            if (i === this.selected)
                label.add_style_pseudo_class('selected');
            else
                label.remove_style_pseudo_class('selected');
        });
    }
});

export const TabletKeyboard = GObject.registerClass(
class TabletKeyboard extends KeyboardUI.Keyboard {
    _init() {
        super._init();
        this.add_style_class_name('tk-keyboard');

        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._interfaceSettings.connectObject('changed::color-scheme',
            () => this._syncColorScheme(), this);
        this._settings.connectObject(
            'changed::color-scheme', () => this._syncColorScheme(),
            'changed::portrait-height', () => this._relayout(),
            'changed::landscape-height', () => this._relayout(),
            'changed::split-keyboard', () => this._relayout(),
            'changed::swipe-symbols', () => this._rebuildPages(),
            'changed::shortcut-bar', () => this._syncToolbar(),
            'changed::auto-capitalize', () => this._updateAutoShift(),
            'changed::voice-engine', () =>
                this._dictation?.setEngine(this._settings.get_string('voice-engine')),
            this);
        this._syncColorScheme();
    }

    // Called from the parent constructor via _setupKeyboard()
    _ensureUi() {
        if (this._tkLayout)
            return;

        this._settings = extension.getSettings();
        this._touches = new Map();
        this._mods = new Set();
        this._modsLocked = false;
        this._shiftMode = 'off';
        this._shiftHeld = 0;
        this._lastShiftTap = 0;
        this._lastTapUnlocked = false;
        this._history = '';
        this._lastTypeTime = 0;
        this._lastSpaceTime = 0;
        this._queue = Promise.resolve();
        this._pageName = 'letters';
        this._splitActive = false;
        this._selection = null;
        this._lastCorrection = null;
        this._keepWord = null;

        this._tkLayout = new St.BoxLayout({
            style_class: 'tk-layout',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });

        this._toolbar = this._buildToolbar();
        this._tkLayout.add_child(this._toolbar);
        this._shortcutBar = this._buildShortcutBar();
        this._tkLayout.add_child(this._shortcutBar);

        this._grid = new KeyGrid();
        this._grid.connect('touch-event', this._onTouchEvent.bind(this));
        this._grid.connect('button-press-event', this._onButtonEvent.bind(this));
        this._grid.connect('motion-event', this._onButtonEvent.bind(this));
        this._grid.connect('button-release-event', this._onButtonEvent.bind(this));
        this._tkLayout.add_child(this._grid);

        this._aspectContainer.add_child(this._tkLayout);
        this._currentLayout = this._tkLayout;

        this._preview = new KeyPreview();

        this._dictation = new Dictation({
            engine: this._settings.get_string('voice-engine'),
            onChanged: () => this._syncVoice(),
            onText: text => this._typeDictation(text),
        });

        Main.inputMethod.connectObject('surrounding-text-set',
            this._onSurroundingText.bind(this), this);
    }

    _onDestroy() {
        this._destroyed = true;
        super._onDestroy();

        // The stock keyboard never removes this
        if (Main.uiGroup.get_actions().includes(this._panGesture))
            Main.uiGroup.remove_action(this._panGesture);
        this._cancelAllTouches();
        this._preview?.destroy();
        this._preview = null;
        this._stopVoiceLevels();
        this._dictation?.destroy();
        this._dictation = null;
        if (this._surroundingRetryId) {
            GLib.source_remove(this._surroundingRetryId);
            this._surroundingRetryId = 0;
        }
        if (this._imFlushId) {
            GLib.source_remove(this._imFlushId);
            this._imFlushId = 0;
        }
    }

    _syncColorScheme() {
        let scheme = this._settings.get_string('color-scheme');
        if (scheme === 'system')
            scheme = this._interfaceSettings.get_string('color-scheme') === 'prefer-dark' ? 'dark' : 'light';
        // Style class for the keyboard and its popups, null for light
        this._theme = scheme === 'light' ? null : `tk-${scheme}`;
        for (const name of THEME_CLASSES)
            this.remove_style_class_name(name);
        if (this._theme)
            this.add_style_class_name(this._theme);
        if (scheme === 'dark')
            this._bottomPanelBox?.add_style_class_name('dark-mode-enabled');
        else
            this._bottomPanelBox?.remove_style_class_name('dark-mode-enabled');
        if (this._bottomPanelBox)
            this._bottomPanelBox.style = `background-color: ${PANEL_COLORS[scheme]};`;
    }

    // --- Parent overrides ------------------------------------------------

    _updateKeys() {
        this._ensureUi();

        this._splitActive = this._wantSplit();
        this._buildPages();
        this._pageName = null;
        this._syncToolbar();
        this._setActiveLevel('default');
    }

    _buildPages() {
        const group = this._keyboardController.getCurrentGroup();
        const sources = InputSourceManager.getInputSourceManager().inputSources;
        this._pages = buildPages(group, Object.keys(sources).length > 1, {
            split: this._splitActive,
            alts: this._settings.get_boolean('swipe-symbols'),
            voice: this._dictation.available,
            variant: variantFor(Object.keys(Purpose).find(name => Purpose[name] === this._purpose)),
        });
        this._voiceShown = this._dictation.available;
    }

    // Rebuilds the keys after a settings change, staying on the same page
    _rebuildPages() {
        if (!this._pages)
            return;

        const name = this._pageName ?? 'letters';
        this._buildPages();
        this._pageName = null;
        this._setPage(name);
    }

    _isLandscape() {
        const monitor = Main.layoutManager.keyboardMonitor;
        return !!monitor && monitor.width > monitor.height;
    }

    _wantSplit() {
        return this._isLandscape() && this._settings.get_boolean('split-keyboard');
    }

    _onPurposeChanged(controller, purpose) {
        // Apps may resend an unchanged purpose while typing
        if (purpose === this._purpose)
            return;
        super._onPurposeChanged(controller, purpose);
    }

    _setActiveLevel(_level) {
        if (!this._pages)
            return;

        this._cancelAllTouches();
        this._setPage(this._pages.keypad ? 'keypad' : 'letters');
        if (this._shiftMode !== 'lock')
            this._setShift('off');
        this._updateAutoShift();
        this._relayout();
    }

    _setLatched(_latched) {
    }

    _updateLevelFromHints(userInputHappened) {
        if (!this._tkLayout)
            return;

        const hints = this._contentHint ?? 0;
        if (userInputHappened || hints !== this._lastHints) {
            this._lastHints = hints;
            this._resetContext();
        }
    }

    _onFocusChanged(focusTracker) {
        super._onFocusChanged(focusTracker);
        // Text reported before the focus moved belongs to someone else
        this._surroundingFocus = null;
        this._syncToolbar();
    }

    _relayout() {
        const monitor = Main.layoutManager.keyboardMonitor;
        if (!monitor || !this._tkLayout)
            return;

        const split = this._wantSplit();
        if (split !== this._splitActive) {
            this._splitActive = split;
            this._rebuildPages();
        }

        const {width, height} = monitor;
        const gridHeight = this._isLandscape()
            ? Math.min(height * 0.42, width * 0.3) * this._settings.get_int('landscape-height') / 100
            : width * 0.36 * this._settings.get_int('portrait-height') / 100;
        const barVisible = this._toolbar.visible || this._shortcutBar.visible;
        const barHeight = barVisible ? Math.round(gridHeight * 0.16) : 0;

        this._toolbar.height = barHeight;
        this._shortcutBar.height = barHeight;
        this._aspectContainer.setRatio(width, gridHeight + barHeight);
    }

    vfunc_get_preferred_height(forWidth) {
        const [minH, natH] = St.BoxLayout.prototype.vfunc_get_preferred_height.call(this, forWidth);
        const monitor = Main.layoutManager.keyboardMonitor;
        const maxHeight = monitor ? monitor.height * 0.5 : natH;
        return [Math.min(minH, maxHeight), Math.min(natH, maxHeight)];
    }

    _panMayRecognize(gesture) {
        // Downward swipes on the keys are ours (swipe-down characters)
        const begin = gesture.get_begin_centroid_abs();
        if (this._grid?.get_transformed_extents().contains_point(begin))
            return false;
        return super._panMayRecognize(gesture);
    }

    // The stock keyboard never disconnects its overview 'showing' handler,
    // which calls this on keyboards destroyed by a rebuild
    close(...args) {
        if (!this._destroyed)
            super.close(...args);
    }

    _animateHide() {
        this._cancelAllTouches();
        // Text must not land wherever the focus goes next
        this._dictation?.cancel();
        super._animateHide();
    }

    // --- Pages and shift -------------------------------------------------

    _setPage(name) {
        if (this._pageName === name)
            return;

        // The old keys are about to go away
        for (const touch of this._touches.values()) {
            this._abandonTouch(touch);
            touch.mode = 'done';
            touch.key = null;
        }

        this._pageName = name;
        this._grid.setPage(this._pages[name]);
        if (this._grid.metrics) {
            for (const key of this._grid.keys)
                key.applyMetrics(this._grid.metrics);
        }
        this._syncShiftKeys();
        this._syncVoiceKeys();
        this._updateAutoShift();
    }

    _setShift(mode) {
        this._shiftMode = mode;
        this._syncShiftKeys();
    }

    _syncShiftKeys() {
        const isUpper = this._shiftMode !== 'off';
        for (const key of this._grid.keys) {
            if (key.spec.kind === 'char' && this._pageName === 'letters')
                key.setUpper(isUpper);
            if (key.spec.kind === 'shift') {
                key.setIcon(this._shiftMode === 'lock'
                    ? 'osk-caps-lock-symbolic' : 'osk-shift-symbolic');
                if (isUpper)
                    key.add_style_class_name('tk-latched');
                else
                    key.remove_style_class_name('tk-latched');
            }
        }
    }

    _shiftDown(touch) {
        const now = GLib.get_monotonic_time() / 1000;
        const quick = now - this._lastShiftTap < SHIFT_DOUBLE_TAP_MS;

        if (this._shiftMode === 'lock') {
            this._setShift('off');
            this._lastTapUnlocked = true;
        } else if (quick && !this._lastTapUnlocked) {
            this._setShift('lock');
            this._lastTapUnlocked = false;
        } else {
            this._setShift(this._shiftMode === 'off' ? 'once' : 'off');
            this._lastTapUnlocked = false;
        }

        this._lastShiftTap = now;
        this._shiftHeld++;
        touch.typedWhileHeld = false;
    }

    _shiftUp(touch) {
        this._shiftHeld = Math.max(0, this._shiftHeld - 1);
        // Holding shift while typing capitalises only those letters
        if (touch.typedWhileHeld && this._shiftMode !== 'lock')
            this._setShift('off');
    }

    _textAssist() {
        if (this._isTerminal())
            return false;
        if ((this._contentHint ?? 0) & (Hint.LOWERCASE | Hint.HIDDEN_TEXT))
            return false;
        return TEXT_PURPOSES.has(this._purpose ?? Purpose.NORMAL);
    }

    _autoCapWanted() {
        const hints = this._contentHint ?? 0;
        if (hints & Hint.UPPERCASE)
            return true;
        if (!this._textAssist() || !this._settings.get_boolean('auto-capitalize'))
            return false;

        const text = this._history;
        if (hints & Hint.TITLECASE)
            return text.length === 0 || /\s$/.test(text);
        return text.length === 0 || /[.!?]\s+$/.test(text) || /\n$/.test(text);
    }

    _updateAutoShift() {
        if (this._shiftMode === 'lock' || this._shiftHeld > 0 || this._pageName !== 'letters')
            return;

        if (this._autoCapWanted()) {
            if (this._shiftMode === 'off')
                this._setShift('auto');
        } else if (this._shiftMode === 'auto') {
            this._setShift('off');
        }
    }

    // --- Text context ----------------------------------------------------

    _resetContext() {
        this._history = '';
        this._lastSpaceTime = 0;
        this._updateAutoShift();
        Main.inputMethod.request_surrounding();
    }

    _onSurroundingText() {
        const [text, cursor, anchor] = Main.inputMethod.getSurroundingText();
        this._surroundingFocus = typeof text === 'string' ? Main.inputMethod.currentFocus : null;
        if (text === null || text === undefined || cursor === null)
            return;

        // Updates racing our own typing may be stale; look again once it pauses
        const now = GLib.get_monotonic_time() / 1000;
        const quietIn = TYPING_QUIET_MS - (now - this._lastTypeTime);
        if (quietIn > 0) {
            if (!this._surroundingRetryId) {
                this._surroundingRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, quietIn, () => {
                    this._surroundingRetryId = 0;
                    this._onSurroundingText();
                    return GLib.SOURCE_REMOVE;
                });
            }
            return;
        }

        // Selected text, as a range for delete_surrounding()
        if (anchor !== null && anchor !== undefined && anchor !== cursor)
            this._setSelection(anchor < cursor ? [anchor - cursor, cursor - anchor] : [0, anchor - cursor]);
        else
            this._setSelection(null);

        const history = [...text].slice(0, cursor).join('').slice(-64);
        if (history === this._history)
            return;

        this._history = history;
        this._updateAutoShift();
    }

    _noteTyped(text) {
        this._lastTypeTime = GLib.get_monotonic_time() / 1000;
        this._history = (this._history + text).slice(-64);
        this._setSelection(null);
    }

    _noteDeleted(count = 1) {
        this._lastTypeTime = GLib.get_monotonic_time() / 1000;
        if (count > 0)
            this._history = [...this._history].slice(0, -count).join('');
        this._lastSpaceTime = 0;
        this._setSelection(null);
    }

    // After undo, paste and the like we no longer know the text
    _forgetContext() {
        this._history = '';
        this._lastSpaceTime = 0;
        this._lastCorrection = null;
        Main.inputMethod.request_surrounding();
    }

    _setSelection(range) {
        this._selection = range;
        for (const button of this._selectionButtons ?? [])
            button.visible = !!range;
    }

    _isTerminal() {
        if (this._purpose === Purpose.TERMINAL)
            return true;
        const wmClass = this._focusWindow?.get_wm_class() ?? '';
        return TERMINAL_WM_CLASS.test(wmClass);
    }

    // --- Text output -----------------------------------------------------

    _enqueue(fn) {
        this._queue = this._queue.then(fn).catch(logError);
    }

    _usesInputMethod(withMods) {
        // IBus input sources (e.g. CJK) need key events routed through the IM
        const source = InputSourceManager.getInputSourceManager().currentSource;
        return !withMods && !!Main.inputMethod.currentFocus &&
            source?.type !== InputSourceManager.INPUT_SOURCE_TYPE_IBUS;
    }

    _takeMods() {
        const mods = new Set(this._mods);
        if (!this._modsLocked)
            this._setMods(new Set());
        return mods;
    }

    _commit(text) {
        const mods = this._takeMods();
        const controller = this._keyboardController;

        if (this._usesInputMethod(mods.size > 0)) {
            this._imBatch().text += text;
        } else {
            this._enqueue(() => {
                this._flushIm();
                controller.commit(text, mods);
            });
        }

        this._noteTyped(text);
    }

    // Text-input clients apply one delete and one commit per 'done' event,
    // and mutter sends 'done' once per main loop cycle: a second commit in the
    // same cycle replaces the first. So collect them and send one batch.
    _imBatch() {
        if (!this._imPending) {
            this._imPending = {before: 0, text: ''};
            // After mutter's 'done' idle at CLUTTER_PRIORITY_EVENTS + 1
            this._imFlushId = GLib.idle_add(GLib.PRIORITY_DEFAULT + 2, () => {
                this._imFlushId = 0;
                this._flushIm();
                return GLib.SOURCE_REMOVE;
            });
        }
        return this._imPending;
    }

    _flushIm() {
        if (this._imFlushId) {
            GLib.source_remove(this._imFlushId);
            this._imFlushId = 0;
        }
        const pending = this._imPending;
        this._imPending = null;
        if (!pending)
            return;

        // Checked again when sent, as the focus may have moved since
        const {before, text} = pending;
        if (before > 0 && this._surroundingHolds(-before, before))
            Main.inputMethod.delete_surrounding(-before, before);
        if (text)
            Main.inputMethod.commit(text);
    }

    _sendKeyval(keyval) {
        const mods = this._takeMods();
        const controller = this._keyboardController;
        this._enqueue(() => {
            this._flushIm();
            for (const mod of mods)
                controller.keyvalPress(mod);
            controller.keyvalPress(keyval);
            controller.keyvalRelease(keyval);
            for (const mod of mods)
                controller.keyvalRelease(mod);
        });
    }

    _sendCombo(mods, keyval) {
        const controller = this._keyboardController;
        this._enqueue(() => {
            this._flushIm();
            for (const mod of mods)
                controller.keyvalPress(mod);
            controller.keyvalPress(keyval);
            controller.keyvalRelease(keyval);
            for (const mod of [...mods].reverse())
                controller.keyvalRelease(mod);
        });
    }

    // Whether delete_surrounding(offset, length) stays inside the text the app
    // last reported. Mutter crashes on anything else: after a focus change, or
    // in apps that never report their text (terminals), it has no text at all,
    // while the shell may still hold text from an earlier focus.
    _surroundingHolds(offset, length) {
        if (!this._usesInputMethod(false) || !this._surroundingFocus ||
            this._surroundingFocus !== Main.inputMethod.currentFocus)
            return false;
        const [text, cursor] = Main.inputMethod.getSurroundingText();
        if (typeof text !== 'string' || typeof cursor !== 'number')
            return false;
        return offset <= 0 && -offset <= cursor &&
            offset + length <= [...text].length - cursor;
    }

    // How a backspace of `count` characters splits into text still waiting
    // in the batch and characters the app already has
    _splitDelete(count) {
        const pending = this._imPending;
        const trimmed = Math.min(count, pending ? [...pending.text].length : 0);
        const before = (pending?.before ?? 0) + count - trimmed;
        return {trimmed, before, ok: trimmed === count || this._surroundingHolds(-before, before)};
    }

    // Whether `count` characters before the cursor can be deleted in order
    // with a following commit
    _canReplaceBack(count) {
        return !this._usesInputMethod(false) || this._splitDelete(count).ok;
    }

    // Deletes `count` characters before the cursor, or the selection
    _deleteBack(count = 1) {
        const controller = this._keyboardController;
        const backspaces = presses => this._enqueue(() => {
            this._flushIm();
            for (let i = 0; i < presses; i++) {
                controller.keyvalPress(Clutter.KEY_BackSpace);
                controller.keyvalRelease(Clutter.KEY_BackSpace);
            }
        });

        if (this._selection) {
            const [offset, length] = this._selection;
            this._enqueue(() => {
                this._flushIm();
                if (this._surroundingHolds(offset, length))
                    Main.inputMethod.delete_surrounding(offset, length);
                else
                    backspaces(1);
            });
            return;
        }

        const split = this._usesInputMethod(false) ? this._splitDelete(count) : null;
        if (!split?.ok) {
            backspaces(count);
            return;
        }
        const batch = this._imBatch();
        if (split.trimmed > 0)
            batch.text = [...batch.text].slice(0, -split.trimmed).join('');
        batch.before = split.before;
    }

    // Replaces the word just typed if it is a known mistake. Returns the fix.
    _autocorrect() {
        const keep = this._keepWord;
        this._keepWord = null;
        // With a selection _deleteBack() would delete it instead of the word
        if (!this._settings.get_boolean('autocorrect') || !this._textAssist() ||
            this._mods.size > 0 || this._selection)
            return null;

        const fix = findCorrection(this._history);
        if (!fix || fix.original === keep)
            return null;

        const length = [...fix.original].length;
        if (!this._canReplaceBack(length))
            return null;
        this._deleteBack(length);
        this._noteDeleted(length);
        this._commit(fix.replacement);
        return fix;
    }

    // Backspace right after a correction brings back what was typed
    _revertCorrection() {
        const fix = this._lastCorrection;
        this._lastCorrection = null;
        if (!fix || !this._history.endsWith(fix.replacement + fix.trigger))
            return false;

        const length = [...fix.replacement].length + [...fix.trigger].length;
        if (!this._canReplaceBack(length))
            return false;
        this._deleteBack(length);
        this._noteDeleted(length);
        this._commit(fix.original);
        this._keepWord = fix.original;
        return true;
    }

    _typeChar(text) {
        this._lastCorrection = null;
        const fix = CORRECTION_TRIGGERS.test(text) ? this._autocorrect() : null;
        this._commit(text);
        if (fix)
            this._lastCorrection = {...fix, trigger: text};

        for (const touch of this._touches.values()) {
            if (touch.key?.spec.kind === 'shift')
                touch.typedWhileHeld = true;
        }
        if ((this._shiftMode === 'once' || this._shiftMode === 'auto') && this._shiftHeld === 0)
            this._setShift('off');
        this._lastSpaceTime = 0;
        this._updateAutoShift();
    }

    _typeSpace() {
        const now = GLib.get_monotonic_time() / 1000;
        const text = this._history;

        this._lastCorrection = null;

        // Double-tap space: replace the first space with ". "
        if (this._textAssist() && this._mods.size === 0 && !this._selection &&
            this._settings.get_boolean('double-space-period') &&
            now - this._lastSpaceTime < DOUBLE_SPACE_MS &&
            text.endsWith(' ') && /[\p{L}\p{N}]$/u.test(text.slice(0, -1)) &&
            this._canReplaceBack(1)) {
            this._deleteBack();
            this._noteDeleted();
            this._commit('. ');
            this._lastSpaceTime = 0;
        } else {
            const fix = this._autocorrect();
            this._commit(' ');
            this._lastSpaceTime = now;
            if (fix)
                this._lastCorrection = {...fix, trigger: ' '};
        }

        if (this._shiftMode === 'once' && this._shiftHeld === 0)
            this._setShift('off');
        this._updateAutoShift();
    }

    _typeReturn() {
        this._lastCorrection = null;
        const fix = this._autocorrect();
        this._sendKeyval(Clutter.KEY_Return);
        this._noteTyped('\n');
        this._lastSpaceTime = 0;
        if (fix)
            this._lastCorrection = {...fix, trigger: '\n'};
        this._updateAutoShift();
    }

    _alienFocus() {
        return !!this._focusWindow?.is_alien();
    }

    _deleteDown(touch) {
        if (this._revertCorrection()) {
            touch.reverted = true;
            return;
        }

        touch.alien = this._alienFocus();
        this._deleteChar(touch.alien);
        touch.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DELETE_REPEAT_MS, () => {
            touch.repeating = true;
            touch.deleted = 0;
            this._repeatDelete(touch);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Holding backspace deletes letters, then speeds up to whole words
    _repeatDelete(touch) {
        const words = touch.deleted >= DELETE_WORDS_AFTER && !touch.alien && !this._isTerminal();
        if (words) {
            this._deleteWord();
        } else {
            this._deleteChar(touch.alien);
            touch.deleted++;
        }

        touch.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            words ? DELETE_WORD_MS : DELETE_CHAR_MS, () => {
                this._repeatDelete(touch);
                return GLib.SOURCE_REMOVE;
            });
    }

    _deleteChar(alien) {
        if (alien) {
            // X11 clients: delete via the IM
            const controller = this._keyboardController;
            this._enqueue(() => {
                this._flushIm();
                controller.toggleDelete(true, true);
                controller.toggleDelete(false, true);
            });
        } else {
            this._deleteBack();
        }
        this._noteDeleted();
    }

    // The previous word and the spaces after it, like Ctrl+Backspace
    _deleteWord() {
        const word = this._history.match(/\S*\s*$/u)[0];
        const length = [...word].length;
        if (length > 0 && !this._selection && this._usesInputMethod(false) &&
            this._splitDelete(length).ok)
            this._deleteBack(length);
        else
            this._sendCombo([Clutter.KEY_Control_L], Clutter.KEY_BackSpace);
        this._noteDeleted(length);
    }

    _deleteUp(touch) {
        if (touch.repeating) {
            // Unknown how much the app deleted; wait for its surrounding text
            this._forgetContext();
        }
        this._updateAutoShift();
    }

    _switchInputSource() {
        const manager = InputSourceManager.getInputSourceManager();
        const sources = Object.values(manager.inputSources).sort((a, b) => a.index - b.index);
        const current = sources.indexOf(manager.currentSource);
        sources[(current + 1) % sources.length]?.activate(true);
    }

    // --- Terminal toolbar ------------------------------------------------

    _buildToolbar() {
        const toolbar = new St.BoxLayout({
            style_class: 'tk-toolbar',
            x_expand: true,
            visible: false,
        });
        this._modButtons = new Map();

        const add = (label, onClick, modKeyval = null) => {
            const button = new St.Button({
                style_class: 'tk-tool',
                label,
                x_expand: true,
                can_focus: false,
            });
            button.connect('clicked', onClick);
            toolbar.add_child(button);
            if (modKeyval)
                this._modButtons.set(modKeyval, button);
        };
        const key = keyval => () => this._sendKeyval(keyval);
        const text = str => () => this._commit(str);

        add('esc', key(Clutter.KEY_Escape));
        add('tab', key(Clutter.KEY_Tab));
        add('ctrl', () => this._toggleMod(Clutter.KEY_Control_L), Clutter.KEY_Control_L);
        add('alt', () => this._toggleMod(Clutter.KEY_Alt_L), Clutter.KEY_Alt_L);
        add('~', text('~'));
        add('|', text('|'));
        add('/', text('/'));
        add('-', text('-'));
        add('←', key(Clutter.KEY_Left));
        add('↑', key(Clutter.KEY_Up));
        add('↓', key(Clutter.KEY_Down));
        add('→', key(Clutter.KEY_Right));

        return toolbar;
    }

    _syncToolbar() {
        if (!this._toolbar)
            return;

        const terminal = this._isTerminal();
        const shortcuts = !terminal && this._settings.get_boolean('shortcut-bar');
        if (this._toolbar.visible === terminal && this._shortcutBar.visible === shortcuts)
            return;

        this._toolbar.visible = terminal;
        this._shortcutBar.visible = shortcuts;
        if (!terminal)
            this._setMods(new Set());
        this._relayout();
    }

    // --- Shortcut bar and menu -------------------------------------------

    _buildShortcutBar() {
        const bar = new St.BoxLayout({
            style_class: 'tk-toolbar tk-shortcuts',
            x_expand: true,
            visible: false,
        });

        const add = (iconName, onClick) => {
            const button = new St.Button({
                style_class: 'tk-tool tk-shortcut',
                child: new St.Icon({style_class: 'tk-shortcut-icon', icon_name: iconName}),
                can_focus: false,
            });
            button.connect('clicked', onClick);
            bar.add_child(button);
            return button;
        };
        const ctrl = Clutter.KEY_Control_L;
        const edit = (mods, keyval) => () => {
            this._sendCombo(mods, keyval);
            this._forgetContext();
        };

        add('edit-undo-symbolic', edit([ctrl], Clutter.KEY_z));
        add('edit-redo-symbolic', edit([ctrl, Clutter.KEY_Shift_L], Clutter.KEY_z));
        add('edit-paste-symbolic', edit([ctrl], Clutter.KEY_v));
        this._selectionButtons = [
            add('edit-cut-symbolic', edit([ctrl], Clutter.KEY_x)),
            add('edit-copy-symbolic', () => this._sendCombo([ctrl], Clutter.KEY_c)),
        ];
        this._setSelection(this._selection);

        bar.add_child(new St.Widget({x_expand: true}));
        // Previous and next field, like Shift+Tab and Tab
        add('go-previous-symbolic', () =>
            this._sendCombo([Clutter.KEY_Shift_L], Clutter.KEY_Tab));
        add('go-next-symbolic', () => this._sendKeyval(Clutter.KEY_Tab));
        add('emblem-system-symbolic', () => this._openSettings());
        return bar;
    }

    // Holding the hide key offers split/merge and the settings
    _openMenu(touch) {
        const split = this._settings.get_boolean('split-keyboard');
        touch.menu = this._isLandscape()
            ? [split ? 'Merge' : 'Split', 'Settings'] : ['Settings'];
        touch.mode = 'menu';
        touch.accents = new AccentPopup(touch.key, touch.menu, this._theme,
            {widthScale: 2.4, fontScale: 0.26});
    }

    _menuChoice(choice) {
        if (choice === 'Split' || choice === 'Merge')
            this._settings.set_boolean('split-keyboard', choice === 'Split');
        else if (choice === 'Settings')
            this._openSettings();
    }

    _openSettings() {
        this.close(true);
        // A window opened from the overview's search would stay behind it
        Main.overview.hide();

        // The prefs service refuses a second dialog, so raise the open one
        const open = global.display.list_all_windows().find(w =>
            w.get_wm_class() === 'org.gnome.Shell.Extensions' &&
            w.get_title() === extension?.metadata.name);
        if (open)
            Main.activateWindow(open);
        else
            extension?.openPreferences();
    }

    _toggleMod(keyval) {
        const now = GLib.get_monotonic_time() / 1000;
        const mods = new Set(this._mods);

        if (mods.has(keyval) && now - (this._lastModTap ?? 0) < SHIFT_DOUBLE_TAP_MS && !this._modsLocked) {
            // Double-tap locks the modifier on
            this._modsLocked = true;
        } else if (mods.has(keyval)) {
            mods.delete(keyval);
            this._modsLocked = false;
        } else {
            mods.add(keyval);
        }
        this._lastModTap = now;
        this._setMods(mods);
    }

    _setMods(mods) {
        this._mods = mods;
        if (mods.size === 0)
            this._modsLocked = false;
        for (const [keyval, button] of this._modButtons ?? []) {
            if (mods.has(keyval))
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
            if (mods.has(keyval) && this._modsLocked)
                button.add_style_class_name('tk-locked');
            else
                button.remove_style_class_name('tk-locked');
        }
    }

    // --- Touch handling --------------------------------------------------

    _onTouchEvent(actor, event) {
        const type = event.type();
        const id = event.get_event_sequence()?.get_slot() ?? 0;
        const [x, y, stageX] = this._localCoords(event);

        if (type === Clutter.EventType.TOUCH_BEGIN)
            this._onBegin(`t${id}`, x, y);
        else if (type === Clutter.EventType.TOUCH_UPDATE)
            this._onMove(`t${id}`, x, y, stageX);
        else if (type === Clutter.EventType.TOUCH_END)
            this._onEnd(`t${id}`);
        else if (type === Clutter.EventType.TOUCH_CANCEL)
            this._onCancel(`t${id}`);
        return Clutter.EVENT_STOP;
    }

    _onButtonEvent(actor, event) {
        const type = event.type();
        const [x, y, stageX] = this._localCoords(event);

        if (type === Clutter.EventType.BUTTON_PRESS && event.get_button() === 1)
            this._onBegin('pointer', x, y);
        else if (type === Clutter.EventType.MOTION)
            this._onMove('pointer', x, y, stageX);
        else if (type === Clutter.EventType.BUTTON_RELEASE && event.get_button() === 1)
            this._onEnd('pointer');
        return Clutter.EVENT_STOP;
    }

    _localCoords(event) {
        const [stageX, stageY] = event.get_coords();
        const [, x, y] = this._grid.transform_stage_point(stageX, stageY);
        return [x, y, stageX];
    }

    _onBegin(id, x, y) {
        if (this._touches.has(id))
            this._onCancel(id);

        const key = this._grid.keyAt(x, y);
        if (!key)
            return;

        // Rolling typing: a new key press commits pending taps first
        if (key.spec.kind === 'char' || key.spec.kind === 'space') {
            for (const other of this._touches.values()) {
                if (other.mode === 'press' && other.key?.spec.kind === 'char') {
                    this._clearTimer(other);
                    // Stay on this page: the new key is on it, and switching
                    // would destroy it
                    if (other.slide)
                        other.slide.returnToLetters = false;
                    this._releaseKey(other);
                    other.mode = 'done';
                }
            }
        }

        const touch = {id, key, x0: x, y0: y, x, y, mode: 'press', timer: 0};
        this._touches.set(id, touch);
        this._pressKey(touch);
    }

    _pressKey(touch) {
        const {key} = touch;
        key.add_style_pseudo_class('active');

        switch (key.spec.kind) {
        case 'char':
            this._preview.showFor(key, key.text, this._theme);
            if (key.accents.length > 0) {
                touch.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LONG_PRESS_MS, () => {
                    touch.timer = 0;
                    this._openAccents(touch);
                    return GLib.SOURCE_REMOVE;
                });
            }
            break;
        case 'space':
            touch.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TRACKPAD_PRESS_MS, () => {
                touch.timer = 0;
                this._startTrackpad(touch);
                return GLib.SOURCE_REMOVE;
            });
            break;
        case 'delete':
            this._deleteDown(touch);
            break;
        case 'shift':
            this._shiftDown(touch);
            break;
        case 'hide':
            touch.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LONG_PRESS_MS, () => {
                touch.timer = 0;
                this._openMenu(touch);
                return GLib.SOURCE_REMOVE;
            });
            break;
        case 'voice':
            this._voiceDown(touch);
            break;
        case 'page': {
            // Switch on press so a finger can slide onto a symbol and release
            const fromLetters = this._pageName === 'letters';
            const fromKeypad = this._pageName === 'keypad';
            this._setPage(key.spec.page);
            // The keypad's keys line up with nothing on the letters page
            if (fromKeypad) {
                touch.mode = 'done';
                touch.key = null;
                break;
            }
            touch.mode = 'press';
            touch.key = this._grid.keyAt(touch.x, touch.y);
            touch.key?.add_style_pseudo_class('active');
            touch.slide = {returnToLetters: fromLetters, startKey: touch.key};
            break;
        }
        }
    }

    _clearTimer(touch) {
        if (touch.timer) {
            GLib.source_remove(touch.timer);
            touch.timer = 0;
        }
    }

    _onMove(id, x, y, stageX) {
        const touch = this._touches.get(id);
        if (!touch)
            return;

        touch.x = x;
        touch.y = y;

        switch (touch.mode) {
        case 'press':
            this._movePress(touch);
            break;
        case 'flick': {
            const distance = touch.key.height * 0.45;
            touch.flick = Math.clamp((y - touch.y0 - FLICK_START_PX) / distance, 0, 1);
            touch.key.setFlick(touch.flick);
            break;
        }
        case 'accents':
        case 'menu':
            touch.accents.selectAt(stageX);
            break;
        case 'trackpad':
            this._moveTrackpad(touch);
            break;
        }
    }

    _movePress(touch) {
        const {key} = touch;
        const dx = touch.x - touch.x0;
        const dy = touch.y - touch.y0;

        if (key?.spec.kind === 'char' && key.spec.alt && !touch.slide &&
            dy > FLICK_START_PX && dy > Math.abs(dx)) {
            this._clearTimer(touch);
            this._preview.hide();
            touch.mode = 'flick';
            touch.flick = 0;
            return;
        }

        // Sliding onto a different key moves the press there
        const under = this._grid.keyAt(touch.x, touch.y);
        if (!under || under === key)
            return;

        // After a page switch the finger starts on the new page's key there
        if (touch.slide && !touch.slide.startKey) {
            touch.key = under;
            touch.slide.startKey = under;
            under.add_style_pseudo_class('active');
            return;
        }

        const slidable = k => ['char', 'space', 'return', 'page', 'emoji', 'globe', 'hide'].includes(k.spec.kind);
        if (key && !slidable(key) || !slidable(under))
            return;

        this._clearTimer(touch);
        key?.remove_style_pseudo_class('active');
        touch.key = under;
        touch.x0 = touch.x;
        touch.y0 = touch.y;
        under.add_style_pseudo_class('active');
        if (under.spec.kind === 'char') {
            this._preview.showFor(under, under.text, this._theme);
            if (under.accents.length > 0 && !touch.slide) {
                touch.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LONG_PRESS_MS, () => {
                    touch.timer = 0;
                    this._openAccents(touch);
                    return GLib.SOURCE_REMOVE;
                });
            }
        } else {
            this._preview.hide();
        }
    }

    _openAccents(touch) {
        this._preview.hide();
        touch.mode = 'accents';
        touch.accents = new AccentPopup(touch.key, touch.key.accents, this._theme);
    }

    _startTrackpad(touch) {
        touch.mode = 'trackpad';
        touch.tx = touch.x;
        touch.ty = touch.y;
        this._grid.add_style_class_name('tk-trackpad');
    }

    _moveTrackpad(touch) {
        const stepX = this._grid.unitWidth * 0.45;
        const stepY = this._grid.rowHeight * 0.9;

        while (touch.x - touch.tx >= stepX) {
            this._sendKeyval(Clutter.KEY_Right);
            touch.tx += stepX;
        }
        while (touch.tx - touch.x >= stepX) {
            this._sendKeyval(Clutter.KEY_Left);
            touch.tx -= stepX;
        }
        while (touch.y - touch.ty >= stepY) {
            this._sendKeyval(Clutter.KEY_Down);
            touch.ty += stepY;
        }
        while (touch.ty - touch.y >= stepY) {
            this._sendKeyval(Clutter.KEY_Up);
            touch.ty -= stepY;
        }
        touch.moved = true;
    }

    _onEnd(id) {
        const touch = this._touches.get(id);
        if (!touch)
            return;

        this._touches.delete(id);
        this._clearTimer(touch);

        switch (touch.mode) {
        case 'press':
            this._releaseKey(touch);
            break;
        case 'flick': {
            const {key} = touch;
            if (touch.flick >= 0.5)
                this._typeChar(key.spec.alt);
            else
                this._typeChar(key.text);
            key.resetFlick();
            key.remove_style_pseudo_class('active');
            break;
        }
        case 'accents':
            this._typeChar(touch.accents.selectedText);
            touch.accents.destroy();
            touch.key.remove_style_pseudo_class('active');
            break;
        case 'menu': {
            const choice = touch.accents.selectedText;
            touch.accents.destroy();
            touch.key.remove_style_pseudo_class('active');
            this._menuChoice(choice);
            break;
        }
        case 'trackpad':
            this._endTrackpad(touch);
            break;
        }
    }

    _releaseKey(touch) {
        const {key} = touch;
        if (!key)
            return;

        key.remove_style_pseudo_class('active');
        if (key.spec.kind === 'char')
            this._preview.hide();

        switch (key.spec.kind) {
        case 'char':
            this._typeChar(key.text);
            // A symbol picked by sliding from "123" returns to the letters
            if (touch.slide?.returnToLetters && key !== touch.slide.startKey)
                this._setPage('letters');
            break;
        case 'space':
            this._typeSpace();
            break;
        case 'return':
            this._typeReturn();
            break;
        case 'delete':
            this._deleteUp(touch);
            break;
        case 'shift':
            this._shiftUp(touch);
            break;
        case 'page':
            if (touch.slide && key !== touch.slide.startKey)
                this._setPage(key.spec.page);
            break;
        case 'emoji':
            this._toggleEmoji();
            break;
        case 'voice':
            this._voiceUp(touch);
            break;
        case 'globe':
            this._switchInputSource();
            break;
        case 'hide':
            this.close(true);
            break;
        }
    }

    // --- Voice typing ----------------------------------------------------

    // Press starts recording; releasing after a hold stops it (push-to-talk),
    // after a tap leaves it running until the next tap.
    _voiceDown(touch) {
        const dictation = this._dictation;
        if (dictation.state === 'idle') {
            dictation.start();
            touch.voiceStarted = GLib.get_monotonic_time() / 1000;
        } else if (dictation.state === 'recording') {
            dictation.stop();
        }
    }

    _voiceUp(touch) {
        const held = GLib.get_monotonic_time() / 1000 - (touch.voiceStarted ?? Infinity);
        if (held >= VOICE_HOLD_MS)
            this._dictation.stop();
    }

    _typeDictation(text) {
        // Separate from the word before the cursor
        const before = this._history;
        if (before && !/\s$/.test(before))
            text = ` ${text}`;
        this._lastCorrection = null;
        this._commit(text);
        this._lastSpaceTime = 0;
        this._updateAutoShift();
    }

    _syncVoice() {
        if (!this._dictation)
            return;
        // Installing or removing the helper adds or removes the key
        if (this._pages && this._voiceShown !== this._dictation.available)
            this._rebuildPages();
        this._syncVoiceKeys();
    }

    _syncVoiceKeys() {
        const state = this._dictation?.state ?? 'idle';
        const keys = this._grid.keys.filter(k => k.spec.kind === 'voice');
        for (const key of keys)
            key.setVoiceState(state);

        if (state !== 'recording') {
            this._stopVoiceLevels();
        } else if (!this._voiceLevelId) {
            this._voiceLevelId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, VOICE_LEVEL_MS, () => {
                const level = this._dictation?.level() ?? null;
                for (const key of this._grid.keys) {
                    if (key.spec.kind === 'voice')
                        key.setVoiceLevel(level);
                }
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    _stopVoiceLevels() {
        if (this._voiceLevelId) {
            GLib.source_remove(this._voiceLevelId);
            this._voiceLevelId = 0;
        }
    }

    _endTrackpad(touch) {
        this._grid.remove_style_class_name('tk-trackpad');
        touch.key.remove_style_pseudo_class('active');
        if (touch.moved)
            this._forgetContext();
    }

    _onCancel(id) {
        const touch = this._touches.get(id);
        if (!touch)
            return;

        this._touches.delete(id);
        this._abandonTouch(touch);
    }

    // Undo a touch's side effects without typing anything
    _abandonTouch(touch) {
        this._clearTimer(touch);
        this._preview?.hide();
        touch.accents?.destroy();
        touch.accents = null;

        const {key} = touch;
        if (!key || touch.mode === 'done')
            return;

        if (touch.mode === 'flick')
            key.resetFlick();
        if (touch.mode === 'trackpad')
            this._grid.remove_style_class_name('tk-trackpad');
        if (key.spec.kind === 'shift')
            this._shiftHeld = Math.max(0, this._shiftHeld - 1);
        // A held mic key that never sees its release must not keep recording
        if (key.spec.kind === 'voice' && this._dictation)
            this._voiceUp(touch);
        key.remove_style_pseudo_class('active');
    }

    _cancelAllTouches() {
        for (const id of [...(this._touches?.keys() ?? [])])
            this._onCancel(id);
    }
});
