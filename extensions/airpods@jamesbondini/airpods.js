// Talks to AirPods directly: registers a BlueZ client profile for the AAP
// UUID, asks BlueZ to connect it whenever paired AirPods connect, and reads
// and writes the L2CAP socket BlueZ hands over. No daemon involved.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLibUnix from 'gi://GLibUnix';

import * as AAP from './protocol.js';

const BLUEZ = 'org.bluez';
const PROFILE_PATH = '/org/daylight/AirPods';
const PROFILE_XML = `<node>
  <interface name="org.bluez.Profile1">
    <method name="Release"/>
    <method name="NewConnection">
      <arg type="o" direction="in"/>
      <arg type="h" direction="in"/>
      <arg type="a{sv}" direction="in"/>
    </method>
    <method name="RequestDisconnection">
      <arg type="o" direction="in"/>
    </method>
  </interface>
</node>`;

// Let A2DP settle before opening the control channel, then back off
const CONNECT_DELAYS = [1500, 3000, 6000, 12000];
// Some models never acknowledge the features packet
const NOTIFY_FALLBACK_MS = 2000;
// A listening mode change briefly reports both pods out of the ear
const EAR_SETTLE_MS = 1200;

// One open AAP channel. BlueZ's socket is SOCK_SEQPACKET, so every read
// returns exactly one packet.
class Link {
    constructor(fd, onPacket, onClose) {
        GLibUnix.set_fd_nonblocking(fd, true);
        this._in = GioUnix.InputStream.new(fd, true);
        this._out = GioUnix.OutputStream.new(fd, false);
        this._cancellable = new Gio.Cancellable();
        this._onPacket = onPacket;
        this._onClose = onClose;
        this._read();
    }

    _read() {
        this._reading = true;
        this._in.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, this._cancellable, (stream, res) => {
            this._reading = false;
            let bytes;
            try {
                bytes = stream.read_bytes_finish(res);
            } catch {
                bytes = null;
            }
            if (this._closed) {
                // close() could not close the stream while this read was pending
                this._closeStream();
                return;
            }
            if (!bytes) {
                this.close();
                return;
            }
            if (bytes.get_size() === 0) {
                this.close();
                return;
            }
            try {
                this._onPacket(bytes.toArray());
            } catch (e) {
                logError(e, 'AirPods: handling packet');
            }
            if (!this._closed)
                this._read();
        });
    }

    send(packet) {
        if (this._closed)
            return false;
        try {
            this._out.write_all(packet, null);
            return true;
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.WOULD_BLOCK))
                this.close();
            return false;
        }
    }

    close() {
        if (this._closed)
            return;
        this._closed = true;
        if (this._reading)
            this._cancellable.cancel();
        else
            this._closeStream();
        this._onClose();
    }

    _closeStream() {
        try {
            this._in.close(null);
        } catch (e) {
            logError(e, 'AirPods: closing the control channel');
        }
    }
}

function emptyState() {
    return {
        model: '',
        name: '',
        noiseMode: -1,
        caOn: null,
        oneBudOn: null,
        // Battery per component: {level, charging} or null
        battery: {left: null, right: null, case: null, headset: null},
        // Which earbud the ear detection packet reports first
        primary: 'left',
        ear: {primary: AAP.EAR_UNKNOWN, secondary: AAP.EAR_UNKNOWN},
    };
}

// Name of a D-Bus error, like org.bluez.Error.AlreadyConnected, or null
const errorName = e => Gio.DBusError.get_remote_error(e);

const errorMessage = e => e.message.replace(/^GDBus\.Error:\S+ /, '');

// Tracks paired AirPods and the control channel to the connected pair.
// Callbacks: onChange() whenever anything shown may differ; onEar(inEar) with
// how many earbuds are in an ear, null when unknown; onSpeech(talking) for
// Conversation Awareness; onError(message) when a user action failed.
export class AirPodsManager {
    constructor({onChange, onEar, onSpeech, onError}) {
        this._onChange = onChange;
        this._onEar = onEar;
        this._onSpeech = onSpeech;
        this._onError = onError;
        this._connecting = new Set();
        this._cancellable = new Gio.Cancellable();
        this._timers = new Map();
        this._attempts = new Map();
        this._link = null;
        this._linkPath = null;
        this._state = emptyState();
        this._registered = false;

        this._profile = Gio.DBusExportedObject.wrapJSObject(PROFILE_XML, {
            Release: () => {
                this._registered = false;
            },
            NewConnectionAsync: (params, invocation) => this._newConnection(params, invocation),
            RequestDisconnection: path => {
                if (path === this._linkPath)
                    this._link?.close();
            },
        });
        this._profile.export(Gio.DBus.system, PROFILE_PATH);

        Gio.DBusObjectManagerClient.new_for_bus(Gio.BusType.SYSTEM,
            Gio.DBusObjectManagerClientFlags.NONE, BLUEZ, '/', null, this._cancellable,
            (_o, res) => {
                try {
                    this._objects = Gio.DBusObjectManagerClient.new_for_bus_finish(res);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        logError(e, 'AirPods: BlueZ');
                    return;
                }
                this._objects.connectObject(
                    'notify::name-owner', () => this._bluezChanged(),
                    'object-added', () => this._devicesChanged(),
                    'object-removed', () => this._devicesChanged(),
                    'interface-proxy-properties-changed', () => this._devicesChanged(),
                    this);
                this._bluezChanged();
            });
    }

    // The AirPods to show: a connected pair first, otherwise any paired one
    get device() {
        const all = this._devices();
        return all.find(d => d.connected) ?? all[0] ?? null;
    }

    // Everything the menu needs, merged from BlueZ and the control channel
    get status() {
        const device = this.device;
        if (!device)
            return null;
        const live = device.path === this._linkPath;
        const s = live ? this._state : emptyState();
        const caps = AAP.capabilities(s.model);
        const ear = {[s.primary]: s.ear.primary,
            [s.primary === 'left' ? 'right' : 'left']: s.ear.secondary};
        const battery = which => s.battery[which]
            ? {...s.battery[which], inEar: ear[which] === AAP.EAR_IN} : null;
        return {
            connected: device.connected,
            ready: live,
            address: device.address,
            name: s.name || device.name,
            isHeadset: caps.isHeadset || (!!s.battery.headset && !s.battery.left),
            noiseControl: caps.noiseControl,
            noiseOff: caps.noiseOff,
            adaptive: caps.adaptive,
            // Unknown models gain a switch once the AirPods report its state
            conversationAwareness: caps.conversationAwareness || (!caps.family && s.caOn !== null),
            oneBud: caps.oneBud || (!caps.family && s.oneBudOn !== null),
            noiseMode: s.noiseMode,
            caOn: s.caOn === true,
            oneBudOn: s.oneBudOn === true,
            left: battery('left'),
            right: battery('right'),
            case: battery('case'),
            headset: battery('headset'),
        };
    }

    setNoiseMode(mode) {
        if (this._send(AAP.noiseModePacket(mode)))
            this._update(s => (s.noiseMode = mode));
    }

    setAdaptiveLevel(level) {
        this._send(AAP.adaptiveLevelPacket(level));
    }

    setConversationAwareness(on) {
        if (this._send(AAP.conversationAwarenessPacket(on)))
            this._update(s => (s.caOn = on));
    }

    setOneBud(on) {
        if (this._send(AAP.oneBudPacket(on)))
            this._update(s => (s.oneBudOn = on));
    }

    // Connect or disconnect the whole device, audio included
    toggleConnection() {
        const device = this.device;
        if (!device)
            return;
        this._call(device.path, 'org.bluez.Device1', device.connected ? 'Disconnect' : 'Connect', null)
            .catch(e => {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) &&
                    errorName(e) !== 'org.bluez.Error.InProgress')
                    this._onError(errorMessage(e));
            });
    }

    destroy() {
        this._cancellable.cancel();
        for (const id of this._timers.values())
            GLib.source_remove(id);
        this._timers.clear();
        this._objects?.disconnectObject(this);
        this._link?.close();
        if (this._registered) {
            this._registered = false;
            this._callManager('UnregisterProfile', new GLib.Variant('(o)', [PROFILE_PATH]))
                .catch(() => {});
        }
        this._profile.unexport();
    }

    _devices() {
        if (!this._objects?.name_owner)
            return [];
        const devices = [];
        for (const object of this._objects.get_objects()) {
            const proxy = object.get_interface('org.bluez.Device1');
            const prop = name => proxy?.get_cached_property(name)?.deepUnpack();
            if (!proxy || !prop('Paired') || !(prop('UUIDs') ?? []).includes(AAP.AAP_UUID))
                continue;
            devices.push({
                path: proxy.g_object_path,
                address: prop('Address') ?? '',
                name: prop('Alias') || prop('Name') || 'AirPods',
                connected: prop('Connected') === true,
            });
        }
        return devices.sort((a, b) => a.path.localeCompare(b.path));
    }

    // bluetoothd started, restarted or stopped
    _bluezChanged() {
        this._registered = false;
        this._attempts.clear();
        if (!this._objects.name_owner) {
            this._link?.close();
            this._onChange();
            return;
        }
        this._callManager('RegisterProfile', new GLib.Variant('(osa{sv})', [PROFILE_PATH, AAP.AAP_UUID, {
            Name: new GLib.Variant('s', 'AirPods Control'),
            Role: new GLib.Variant('s', 'client'),
            AutoConnect: new GLib.Variant('b', false),
        }])).then(() => {
            this._registered = true;
            this._devicesChanged();
        }).catch(e => {
            if (errorName(e) === 'org.bluez.Error.AlreadyExists') {
                this._registered = true;
                this._devicesChanged();
            } else if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                logError(e, 'AirPods: registering the BlueZ profile');
            }
        });
    }

    _devicesChanged() {
        for (const device of this._devices()) {
            if (!device.connected) {
                this._attempts.delete(device.path);
                this._clearTimer(device.path);
            } else if (device.path !== this._linkPath && !this._timers.has(device.path) &&
                       !this._connecting.has(device.path)) {
                this._scheduleConnect(device.path);
            }
        }
        this._onChange();
    }

    _scheduleConnect(path) {
        const attempt = this._attempts.get(path) ?? 0;
        if (!this._registered || attempt >= CONNECT_DELAYS.length)
            return;
        this._attempts.set(path, attempt + 1);
        this._setTimer(path, CONNECT_DELAYS[attempt], () => {
            const device = this._devices().find(d => d.path === path);
            if (!device?.connected || path === this._linkPath)
                return;
            this._connecting.add(path);
            this._call(path, 'org.bluez.Device1', 'ConnectProfile', new GLib.Variant('(s)', [AAP.AAP_UUID]))
                .catch(e => {
                    if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ||
                        errorName(e) === 'org.bluez.Error.AlreadyConnected')
                        return;
                    console.warn(`AirPods: control channel to ${device.address} failed: ${errorMessage(e)}`);
                    if (path !== this._linkPath)
                        this._scheduleConnect(path);
                })
                .finally(() => this._connecting.delete(path));
        });
    }

    _newConnection([path, fdIndex], invocation) {
        let fd;
        try {
            fd = invocation.get_message().get_unix_fd_list().get(fdIndex);
        } catch (e) {
            invocation.return_dbus_error('org.bluez.Error.Rejected', e.message);
            return;
        }
        invocation.return_value(null);

        this._link?.close();
        this._state = emptyState();
        this._linkPath = path;
        this._attempts.delete(path);
        this._clearTimer(path);
        const link = new Link(fd, data => this._packet(data), () => {
            if (this._link !== link)
                return;
            this._link = null;
            this._linkPath = null;
            this._state = emptyState();
            this._clearTimer('notify');
            this._clearTimer('ear');
            this._onEar(null);
            // Reconnect if the AirPods dropped only the control channel
            if (!this._cancellable.is_cancelled())
                this._devicesChanged();
        });
        this._link = link;
        link.send(AAP.HANDSHAKE);
        this._onChange();
    }

    _send(packet) {
        return this._link?.send(packet) ?? false;
    }

    _update(change) {
        change(this._state);
        this._onChange();
    }

    _packet(data) {
        const event = AAP.parsePacket(data);
        switch (event?.type) {
        case 'handshake-ack':
            this._send(AAP.SET_FEATURES);
            this._setTimer('notify', NOTIFY_FALLBACK_MS, () => this._requestNotifications());
            break;
        case 'features-ack':
            this._requestNotifications();
            break;
        case 'metadata':
            this._update(s => {
                s.name = event.name;
                s.model = event.model;
            });
            break;
        case 'battery':
            this._update(s => {
                const pods = event.components.filter(c => c.component !== 'case');
                if (pods.length && pods[0].component !== 'headset')
                    s.primary = pods[0].component;
                for (const {component, level, charging} of event.components) {
                    if (level !== null)
                        s.battery[component] = {level, charging};
                    // A pod that left the connection no longer has a level to show
                    else if (component !== 'case')
                        s.battery[component] = null;
                }
            });
            break;
        case 'noise':
            this._update(s => (s.noiseMode = event.mode));
            break;
        case 'conversation-awareness':
            this._update(s => (s.caOn = event.on));
            break;
        case 'one-bud':
            this._update(s => (s.oneBudOn = event.on));
            break;
        case 'ear':
            this._update(s => (s.ear = {primary: event.primary, secondary: event.secondary}));
            this._earChanged();
            break;
        case 'speech':
            // 1 to 3: the wearer is talking; 8 and 9: the feature was
            // switched off or on; anything else: they stopped
            if (event.level >= 1 && event.level <= 3)
                this._onSpeech(true);
            else if (event.level !== 8 && event.level !== 9)
                this._onSpeech(false);
            break;
        }
    }

    // Asked again a few times until the first battery report arrives
    _requestNotifications(tries = 3) {
        this._send(AAP.REQUEST_NOTIFICATIONS);
        this._setTimer('notify', NOTIFY_FALLBACK_MS, () => {
            if (tries > 1 && !Object.values(this._state.battery).some(b => b))
                this._requestNotifications(tries - 1);
        });
    }

    _earChanged() {
        const {primary, secondary} = this._state.ear;
        const inEar = [primary, secondary].filter(e => e === AAP.EAR_IN).length;
        this._clearTimer('ear');
        if (inEar > 0)
            this._onEar(inEar);
        else
            this._setTimer('ear', EAR_SETTLE_MS, () => this._onEar(0));
    }

    _setTimer(key, ms, callback) {
        this._clearTimer(key);
        this._timers.set(key, GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timers.delete(key);
            callback();
            return GLib.SOURCE_REMOVE;
        }));
    }

    _clearTimer(key) {
        const id = this._timers.get(key);
        if (id)
            GLib.source_remove(id);
        this._timers.delete(key);
    }

    _callManager(method, params) {
        return this._call('/org/bluez', 'org.bluez.ProfileManager1', method, params);
    }

    _call(path, iface, method, params) {
        return new Promise((resolve, reject) => {
            Gio.DBus.system.call(BLUEZ, path, iface, method, params, null,
                Gio.DBusCallFlags.NONE, -1, this._cancellable, (conn, res) => {
                    try {
                        resolve(conn.call_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }
}
