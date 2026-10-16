// AirPods in Quick Settings. The extension talks to the AirPods itself
// (airpods.js, over a BlueZ profile) and reacts to them (media.js); this file
// is the menu.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AirPodsManager} from './airpods.js';
import {MediaControl} from './media.js';
import {NOISE_OFF, NOISE_ANC, NOISE_TRANSPARENCY, NOISE_ADAPTIVE} from './protocol.js';

const NOISE_NAMES = ['Off', 'Noise Cancellation', 'Transparency', 'Adaptive'];
const PAUSE_CHOICES = ['one', 'both', 'never'];
const PAUSE_NAMES = ['When One Is Removed', 'When Both Are Removed', 'Never'];
const LOW_BATTERY = 20;

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
    _init(manager, settings) {
        super._init({title: 'AirPods', iconName: 'audio-headphones-symbolic', toggleMode: false});
        this._manager = manager;
        this._settings = settings;

        this.connect('clicked', () => this._manager.toggleConnection());

        this.menu.setHeader('audio-headphones-symbolic', 'AirPods');

        this._battery = new BatteryItem();
        this.menu.addMenuItem(this._battery);

        this._noiseSection = new PopupMenu.PopupMenuSection();
        this._noiseSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Listening Mode'));
        this._noiseItems = NOISE_NAMES.map((name, mode) => {
            const item = new PopupMenu.PopupMenuItem(name);
            item.connect('activate', () => this._manager.setNoiseMode(mode));
            return item;
        });
        // Apple's order: Off, Transparency, Adaptive, Noise Cancellation
        for (const mode of [NOISE_OFF, NOISE_TRANSPARENCY, NOISE_ADAPTIVE, NOISE_ANC])
            this._noiseSection.addMenuItem(this._noiseItems[mode]);
        this._slider = new SliderItem(value => {
            const level = Math.round(value * 100);
            this._settings.set_int('adaptive-level', level);
            this._manager.setAdaptiveLevel(level);
        });
        this._noiseSection.addMenuItem(this._slider);
        this.menu.addMenuItem(this._noiseSection);

        this._featureSection = new PopupMenu.PopupMenuSection();
        this._featureSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._caItem = new PopupMenu.PopupSwitchMenuItem('Conversation Awareness', false);
        this._caItem.connect('toggled', (_i, on) => {
            if (!this._updating)
                this._manager.setConversationAwareness(on);
        });
        this._featureSection.addMenuItem(this._caItem);
        this._oneBudItem = new PopupMenu.PopupSwitchMenuItem('Noise Control With One AirPod', false);
        this._oneBudItem.connect('toggled', (_i, on) => {
            if (!this._updating)
                this._manager.setOneBud(on);
        });
        this._featureSection.addMenuItem(this._oneBudItem);
        this.menu.addMenuItem(this._featureSection);

        this._earSection = new PopupMenu.PopupMenuSection();
        this._earSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Pause Media'));
        this._earItems = PAUSE_NAMES.map((name, i) => {
            const item = new PopupMenu.PopupMenuItem(name);
            item.connect('activate', () => this._settings.set_string('pause-media', PAUSE_CHOICES[i]));
            this._earSection.addMenuItem(item);
            return item;
        });
        this.menu.addMenuItem(this._earSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._connectItem = this.menu.addAction('Connect', () => this._manager.toggleConnection());
        this.menu.addAction('Bluetooth Settings', () => {
            Main.overview.hide();
            Main.panel.closeQuickSettings();
            GLib.spawn_command_line_async('gnome-control-center bluetooth');
        });
    }

    // setToggleState emits 'toggled' too, so ignore switches moved by update()
    update(s) {
        this._updating = true;
        try {
            this._update(s);
        } finally {
            this._updating = false;
        }
    }

    _update(s) {
        this.title = s.name;
        this.checked = s.connected;
        this.subtitle = s.connected ? summary(s) ?? 'Connected' : 'Not Connected';
        this.menu.setHeader('audio-headphones-symbolic', s.name,
            s.connected ? 'Connected' : 'Not Connected');

        this._battery.update(s);
        this._battery.visible = batteries(s).some(([, b]) => b);

        const modes = s.ready && s.noiseControl;
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
            this._slider.slider.value = this._settings.get_int('adaptive-level') / 100;

        this._caItem.visible = s.conversationAwareness;
        this._caItem.setToggleState(s.caOn);
        this._oneBudItem.visible = s.oneBud && !s.isHeadset;
        this._oneBudItem.setToggleState(s.oneBudOn);
        this._featureSection.actor.visible = s.ready &&
            (this._caItem.visible || this._oneBudItem.visible);

        this._earSection.actor.visible = s.ready && !s.isHeadset;
        const pause = this._settings.get_string('pause-media');
        this._earItems.forEach((item, i) => item.setOrnament(PAUSE_CHOICES[i] === pause
            ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE));

        this._connectItem.label.text = s.connected ? 'Disconnect' : 'Connect';
    }
});

const AirPodsIndicator = GObject.registerClass(
class AirPodsIndicator extends SystemIndicator {
    _init(settings) {
        super._init();
        this._settings = settings;
        this._icon = this._addIndicator();
        this._icon.icon_name = 'audio-headphones-symbolic';
        this._icon.visible = false;

        this._media = new MediaControl();
        this._manager = new AirPodsManager({
            onChange: () => this._queueSync(),
            onEar: inEar => {
                const device = this._manager.device;
                if (device)
                    this._media.earChanged(device.address, inEar, this._settings.get_string('pause-media'));
            },
            onSpeech: talking => {
                const device = this._manager.device;
                if (device)
                    this._media.speechChanged(device.address, talking);
            },
            onError: message => Main.notifyError('AirPods', message),
        });

        this._toggle = new AirPodsToggle(this._manager, settings);
        this._toggle.visible = false;
        this.quickSettingsItems.push(this._toggle);
        this._settings.connectObject('changed', () => this._queueSync(), this);
        this._sync();
    }

    // Batch the bursts of BlueZ property changes into one menu update
    _queueSync() {
        if (this._syncId)
            return;
        this._syncId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._syncId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        const status = this._manager.status;
        // Paired AirPods only
        this._toggle.visible = !!status;
        this._icon.visible = !!status?.connected;
        if (status)
            this._toggle.update(status);
        if (!status?.ready)
            this._media.reset();
    }

    destroy() {
        if (this._syncId)
            GLib.source_remove(this._syncId);
        this._settings.disconnectObject(this);
        this._manager.destroy();
        this._media.destroy();
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class AirPodsExtension extends Extension {
    enable() {
        this._indicator = new AirPodsIndicator(this.getSettings());
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
