// What the computer does in response to the AirPods: pause and resume media
// players over MPRIS when earbuds come out and go back in, and turn the volume
// down while Conversation Awareness hears the wearer talk. Both only act while
// the AirPods are the default output.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER = 'org.mpris.MediaPlayer2.Player';
// Share of the volume kept while the wearer talks, as Apple does
const DUCK_FACTOR = 0.2;

function call(name, path, iface, method, params, type = null) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(name, path, iface, method, params,
            type ? new GLib.VariantType(type) : null, Gio.DBusCallFlags.NONE, 1000, null,
            (conn, res) => {
                try {
                    resolve(conn.call_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

export class MediaControl {
    constructor() {
        this._mixer = Volume.getMixerControl();
        this._paused = new Set();
        this._duck = null;
        this._inEar = null;
    }

    // `when` is 'one' (pause when either earbud comes out), 'both' or 'never'
    earChanged(address, inEar, when) {
        const before = this._inEar;
        this._inEar = inEar;
        // Unknown, or the first report after connecting: nothing was taken out
        if (inEar === null || before === null || inEar === before || when === 'never')
            return;
        const out = when === 'one' ? inEar < before : inEar === 0;
        const back = when === 'one' ? inEar > before : before === 0;
        if (out && this._isOutput(address))
            this._pause().catch(e => logError(e, 'AirPods: pausing media'));
        else if (back && this._paused.size)
            this._resume();
    }

    speechChanged(address, talking) {
        if (talking && !this._duck) {
            const sink = this._isOutput(address);
            if (!sink)
                return;
            this._duck = {sink, volume: sink.volume};
            sink.volume = Math.round(sink.volume * DUCK_FACTOR);
            sink.push_volume();
        } else if (!talking) {
            this._unduck();
        }
    }

    // Forget what was paused, e.g. when the AirPods disconnect
    reset() {
        this._paused.clear();
        this._inEar = null;
        this._unduck();
    }

    destroy() {
        this.reset();
    }

    _unduck() {
        if (!this._duck)
            return;
        const {sink, volume} = this._duck;
        this._duck = null;
        // Leave the volume alone if the output changed meanwhile
        if (this._mixer.get_default_sink() === sink) {
            sink.volume = volume;
            sink.push_volume();
        }
    }

    // The default output stream if it is these AirPods, else null
    _isOutput(address) {
        const sink = this._mixer.get_default_sink();
        const id = address.replaceAll(':', '_').toUpperCase();
        return sink?.name?.toUpperCase().includes(id) ? sink : null;
    }

    async _pause() {
        const [names] = (await call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListNames', null, '(as)')).deepUnpack();
        await Promise.all(names.filter(n => n.startsWith(MPRIS_PREFIX)).map(async name => {
            try {
                const [status] = (await call(name, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
                    new GLib.Variant('(ss)', [PLAYER, 'PlaybackStatus']), '(v)')).recursiveUnpack();
                if (status !== 'Playing')
                    return;
                await call(name, MPRIS_PATH, PLAYER, 'Pause', null);
                this._paused.add(name);
            } catch {
                // A player that went away or does not implement MPRIS fully
            }
        }));
    }

    _resume() {
        for (const name of this._paused)
            call(name, MPRIS_PATH, PLAYER, 'Play', null).catch(() => {});
        this._paused.clear();
    }
}
