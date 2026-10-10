// AirPods in Quick Settings, driven by the librepods daemon from omarchy-pods
// (https://github.com/MB-JAMBON/omarchy-pods). The daemon writes its whole
// state as one JSON line to $XDG_STATE_HOME/librepods/status.json whenever it
// changes and removes the file when it stops; control goes through librepods-ctl.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const NOISE_OFF = 0, NOISE_ANC = 1, NOISE_TRANSPARENCY = 2, NOISE_ADAPTIVE = 3;
const NOISE_VERBS = ['noise:off', 'noise:anc', 'noise:transparency', 'noise:adaptive'];
const NOISE_NAMES = ['Off', 'Noise Cancellation', 'Transparency', 'Adaptive'];
const EAR_VERBS = ['ear:one', 'ear:both', 'ear:off'];
const EAR_NAMES = ['When One Is Removed', 'When Both Are Removed', 'Never'];
const LOW_BATTERY = 20;
const SUPPORTED_SCHEMA = 1;

const STATUS_PATH = GLib.build_filenamev([GLib.get_user_state_dir(), 'librepods', 'status.json']);
const CTL_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'librepods-ctl']);

// Same rules as omarchy-pods' Model.parseStatus: absent capability keys fall
// back to is_pro_series, and pods the daemon has not heard from read as unknown.
function parseStatus(text) {
    let raw;
    try {
        raw = JSON.parse(text);
    } catch {
        return null;
    }
    if (!raw || typeof raw !== 'object' || raw.schema_version === undefined ||
        raw.schema_version > SUPPORTED_SCHEMA)
        return null;

    const orBool = (v, fallback) => v === undefined ? fallback : v === true;
    const battery = b => b?.available === true && Number.isFinite(b.level) && b.level >= 0
        ? {level: b.level, charging: b.charging === true, inEar: b.in_ear === true}
        : null;
    const pro = raw.is_pro_series === true;
    return {
        connected: raw.connected === true,
        name: raw.device_name || raw.model_name || 'AirPods',
        isHeadset: raw.is_headset === true,
        noiseControl: orBool(raw.supports_noise_control, true),
        noiseOff: raw.supports_noise_off !== false,
        adaptive: orBool(raw.supports_adaptive, pro),
        conversationAwareness: orBool(raw.supports_conversational_awareness, pro),
        oneBudAnc: orBool(raw.supports_one_bud_anc, pro),
        noiseMode: Number.isInteger(raw.noise_mode) ? raw.noise_mode : -1,
        adaptiveLevel: Number.isInteger(raw.adaptive_noise_level) ? raw.adaptive_noise_level : 50,
        caOn: raw.conversational_awareness === true,
        oneBudOn: raw.one_bud_anc_mode === true,
        earBehavior: Number.isInteger(raw.ear_detection_behavior) ? raw.ear_detection_behavior : 0,
        left: battery(raw.left),
        right: battery(raw.right),
        case: battery(raw.case),
        headset: battery(raw.headset),
    };
}

function batteries(s) {
    if (s.isHeadset)
        return [['Battery', s.headset]];
    return [['Left', s.left], ['Right', s.right], ['Case', s.case]];
}

// "L 80% · R 75%" for the toggle subtitle; earbuds that agree share one number.
function summary(s) {
    const pct = b => `${b.level}%${b.charging ? ' ⚡' : ''}`;
    if (s.isHeadset)
        return s.headset ? pct(s.headset) : null;
    const {left: l, right: r} = s;
    if (l && r && l.level === r.level && l.charging === r.charging)
        return pct(l);
    const parts = [];
    if (l)
        parts.push(`L ${pct(l)}`);
    if (r)
        parts.push(`R ${pct(r)}`);
    return parts.length ? parts.join(' · ') : null;
}

const BatteryItem = GObject.registerClass(
class BatteryItem extends PopupMenu.PopupBaseMenuItem {
    _init() {
        super._init({reactive: false, can_focus: false, style_class: 'airpods-battery-item'});
        this._box = new St.BoxLayout({x_expand: true, style_class: 'airpods-battery-box'});
        this.add_child(this._box);
    }

    update(s) {
        this._box.destroy_all_children();
        for (const [caption, b] of batteries(s)) {
            const column = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                style_class: 'airpods-battery-column',
            });
            const level = new St.Label({
                text: b ? `${b.level}%${b.charging ? ' ⚡' : ''}` : '–',
                style_class: 'airpods-battery-level',
                x_align: Clutter.ActorAlign.CENTER,
            });
            if (b && b.level <= LOW_BATTERY && !b.charging)
                level.add_style_class_name('airpods-battery-low');
            column.add_child(level);
            column.add_child(new St.Label({
                text: caption + (b?.inEar ? ' · in ear' : ''),
                style_class: 'airpods-battery-caption',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            this._box.add_child(column);
        }
    }
});

const SliderItem = GObject.registerClass(
class SliderItem extends PopupMenu.PopupBaseMenuItem {
    _init(onRelease) {
        super._init({activate: false, style_class: 'airpods-slider-item'});
        this.add_child(new St.Label({text: 'Less', y_align: Clutter.ActorAlign.CENTER}));
        this.slider = new Slider(0.5);
        this.slider.x_expand = true;
        this.slider.connect('drag-end', () => onRelease(this.slider.value));
        // Handlers run before the slider's own scroll handler moves it, so
        // read the value once that has happened
        this.slider.connect('scroll-event', () => {
            if (!this._scrollId) {
                this._scrollId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._scrollId = 0;
                    onRelease(this.slider.value);
                    return GLib.SOURCE_REMOVE;
                });
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this.connect('destroy', () => {
            if (this._scrollId)
                GLib.source_remove(this._scrollId);
            this._scrollId = 0;
        });
        this.add_child(this.slider);
        this.add_child(new St.Label({text: 'More', y_align: Clutter.ActorAlign.CENTER}));
    }
});

const AirPodsToggle = GObject.registerClass(
class AirPodsToggle extends QuickMenuToggle {
    _init(run) {
        super._init({title: 'AirPods', iconName: 'audio-headphones-symbolic', toggleMode: false});
        this._run = run;
        this._status = null;

        this.connect('clicked', () => {
            if (this._status)
                this._run(this._status.connected ? 'disconnect' : 'connect');
        });

        this.menu.setHeader('audio-headphones-symbolic', 'AirPods');

        this._battery = new BatteryItem();
        this.menu.addMenuItem(this._battery);

        this._noiseSection = new PopupMenu.PopupMenuSection();
        this._noiseSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Listening Mode'));
        this._noiseItems = NOISE_NAMES.map((name, mode) => {
            const item = new PopupMenu.PopupMenuItem(name);
            item.connect('activate', () => this._run(NOISE_VERBS[mode]));
            return item;
        });
        // Apple's order: Off, Transparency, Adaptive, Noise Cancellation
        for (const mode of [NOISE_OFF, NOISE_TRANSPARENCY, NOISE_ADAPTIVE, NOISE_ANC])
            this._noiseSection.addMenuItem(this._noiseItems[mode]);
        this._slider = new SliderItem(value => this._run(`adaptive:${Math.round(value * 100)}`));
        this._noiseSection.addMenuItem(this._slider);
        this.menu.addMenuItem(this._noiseSection);

        this._featureSection = new PopupMenu.PopupMenuSection();
        this._featureSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._caItem = new PopupMenu.PopupSwitchMenuItem('Conversation Awareness', false);
        this._caItem.connect('toggled', (_i, on) => this._send(on ? 'ca:on' : 'ca:off'));
        this._featureSection.addMenuItem(this._caItem);
        this._oneBudItem = new PopupMenu.PopupSwitchMenuItem('Noise Control With One AirPod', false);
        this._oneBudItem.connect('toggled', (_i, on) => this._send(on ? 'onebud:on' : 'onebud:off'));
        this._featureSection.addMenuItem(this._oneBudItem);
        this.menu.addMenuItem(this._featureSection);

        this._earSection = new PopupMenu.PopupMenuSection();
        this._earSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Pause Media'));
        this._earItems = EAR_NAMES.map((name, behavior) => {
            const item = new PopupMenu.PopupMenuItem(name);
            item.connect('activate', () => this._run(EAR_VERBS[behavior]));
            this._earSection.addMenuItem(item);
            return item;
        });
        this.menu.addMenuItem(this._earSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._connectItem = this.menu.addAction('Connect', () => {
            if (this._status)
                this._run(this._status.connected ? 'disconnect' : 'connect');
        });
        this.menu.addAction('Bluetooth Settings', () => {
            Main.overview.hide();
            Main.panel.closeQuickSettings();
            GLib.spawn_command_line_async('gnome-control-center bluetooth');
        });
    }

    // setToggleState emits 'toggled' too, so ignore switches moved by update()
    _send(verb) {
        if (!this._updating)
            this._run(verb);
    }

    update(s) {
        this._updating = true;
        try {
            this._update(s);
        } finally {
            this._updating = false;
        }
    }

    _update(s) {
        this._status = s;
        this.title = s.name;
        this.checked = s.connected;
        this.subtitle = s.connected ? summary(s) ?? 'Connected' : 'Not Connected';
        this.menu.setHeader('audio-headphones-symbolic', s.name,
            s.connected ? 'Connected' : 'Not Connected');

        this._battery.update(s);
        this._battery.visible = batteries(s).some(([, b]) => b);

        const modes = s.connected && s.noiseControl;
        this._noiseSection.actor.visible = modes;
        this._noiseItems.forEach((item, mode) => {
            item.visible = mode !== NOISE_OFF || s.noiseOff;
            if (mode === NOISE_ADAPTIVE)
                item.visible = s.adaptive;
            item.setOrnament(mode === s.noiseMode
                ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        });
        this._slider.visible = s.noiseMode === NOISE_ADAPTIVE;
        if (!this._slider.slider._dragging)
            this._slider.slider.value = s.adaptiveLevel / 100;

        this._caItem.visible = s.conversationAwareness;
        this._caItem.setToggleState(s.caOn);
        this._oneBudItem.visible = s.oneBudAnc && !s.isHeadset;
        this._oneBudItem.setToggleState(s.oneBudOn);
        this._featureSection.actor.visible = s.connected &&
            (this._caItem.visible || this._oneBudItem.visible);

        this._earSection.actor.visible = s.connected && !s.isHeadset;
        this._earItems.forEach((item, behavior) => item.setOrnament(behavior === s.earBehavior
            ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE));

        this._connectItem.label.text = s.connected ? 'Disconnect' : 'Connect';
    }
});

const AirPodsIndicator = GObject.registerClass(
class AirPodsIndicator extends SystemIndicator {
    _init() {
        super._init();
        this._icon = this._addIndicator();
        this._icon.icon_name = 'audio-headphones-symbolic';
        this._icon.visible = false;

        this._toggle = new AirPodsToggle(verb => this._run(verb));
        this._toggle.visible = false;
        this.quickSettingsItems.push(this._toggle);

        this._file = Gio.File.new_for_path(STATUS_PATH);
        this._monitor = this._file.monitor_file(Gio.FileMonitorFlags.WATCH_MOVES, null);
        this._monitor.connect('changed', () => this._queueReload());
        this._reload();
    }

    _queueReload() {
        if (this._reloadId)
            return;
        this._reloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._reloadId = 0;
            this._reload();
            return GLib.SOURCE_REMOVE;
        });
    }

    _reload() {
        let status = null;
        try {
            const [, bytes] = this._file.load_contents(null);
            status = parseStatus(new TextDecoder().decode(bytes));
        } catch {
            // No file: the daemon is not running
        }
        // Only show up once the daemon has seen a pair of AirPods
        const known = status && (status.connected || batteries(status).some(([, b]) => b) ||
            status.name !== 'AirPods');
        this._toggle.visible = !!known;
        this._icon.visible = !!status?.connected;
        if (status)
            this._toggle.update(status);
    }

    _run(verb) {
        try {
            const proc = Gio.Subprocess.new([CTL_PATH, verb],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, , stderr] = p.communicate_utf8_finish(res);
                    if (!p.get_successful())
                        Main.notifyError('AirPods', stderr?.trim() || `librepods-ctl ${verb} failed`);
                } catch (e) {
                    logError(e);
                }
            });
        } catch (e) {
            Main.notifyError('AirPods', e.message);
        }
    }

    destroy() {
        if (this._reloadId)
            GLib.source_remove(this._reloadId);
        this._monitor.cancel();
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class AirPodsExtension extends Extension {
    enable() {
        this._indicator = new AirPodsIndicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
