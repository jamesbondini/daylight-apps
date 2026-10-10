// Apple Accessory Protocol (AAP), the control channel AirPods speak over
// L2CAP. Packet layouts follow librepods / omarchy-pods
// (https://github.com/MB-JAMBON/omarchy-pods, daemon/airpods_packets.h).
// Pure functions, no GNOME imports, so this file can be tested with plain gjs.

export const AAP_UUID = '74ec2172-0bad-4d01-8f77-997b2be0722a';

export const NOISE_OFF = 0, NOISE_ANC = 1, NOISE_TRANSPARENCY = 2, NOISE_ADAPTIVE = 3;

export const EAR_IN = 0, EAR_OUT = 1, EAR_CASE = 2, EAR_UNKNOWN = 3;

const hex = s => Uint8Array.from(s.match(/../g), b => parseInt(b, 16));

export const HANDSHAKE = hex('00000400010002000000000000000000');
export const SET_FEATURES = hex('040004004d00d700000000000000');
export const REQUEST_NOTIFICATIONS = hex('040004000f00ffffffffff');

const CONTROL = hex('040004000900');
const HANDSHAKE_ACK = hex('01000400');
const FEATURES_ACK = hex('040004002b00');
const EAR_DETECTION = hex('040004000600');
const BATTERY = hex('040004000400');
const METADATA = hex('040004001d');
const SPEECH = hex('040004004b00020001');

const ID_NOISE = 0x0d, ID_ONE_BUD = 0x1b, ID_CA = 0x28, ID_ADAPTIVE_LEVEL = 0x2e;

// Battery components and their status byte
const COMPONENTS = {0x01: 'headset', 0x02: 'right', 0x04: 'left', 0x08: 'case'};
const CHARGING = 0x01, DISCONNECTED = 0x04;

function startsWith(data, prefix) {
    return data.length >= prefix.length && prefix.every((b, i) => data[i] === b);
}

function control(id, value) {
    return Uint8Array.from([...CONTROL, id, value, 0, 0, 0]);
}

export const noiseModePacket = mode => control(ID_NOISE, mode + 1);
export const conversationAwarenessPacket = on => control(ID_CA, on ? 1 : 2);
export const oneBudPacket = on => control(ID_ONE_BUD, on ? 1 : 2);
export const adaptiveLevelPacket = level =>
    control(ID_ADAPTIVE_LEVEL, Math.max(0, Math.min(100, Math.round(level))));

// A switch-type control reply: 1 on, 2 off, anything else unknown
function switchState(data) {
    return data.length > 7 && (data[7] === 1 || data[7] === 2) ? data[7] === 1 : null;
}

function parseMetadata(data) {
    // Six bytes of unknown meaning follow the header, then NUL-terminated strings
    const strings = [];
    let pos = METADATA.length + 6;
    while (pos < data.length && strings.length < 3) {
        let end = data.indexOf(0, pos);
        if (end < 0)
            end = data.length;
        strings.push(new TextDecoder().decode(data.subarray(pos, end)));
        pos = end + 1;
    }
    const [name = '', model = '', manufacturer = ''] = strings;
    return {type: 'metadata', name, model, manufacturer};
}

// Battery: header, count, then per component [type, 0x01, level, status, 0x01].
// The first earbud listed is the primary one, which ear detection reports first.
function parseBattery(data) {
    const count = data[6];
    if (count > 4 || data.length !== 7 + 5 * count)
        return null;
    const components = [];
    for (let i = 0; i < count; i++) {
        const [type, spacer, level, status, end] = data.subarray(7 + 5 * i, 12 + 5 * i);
        if (spacer !== 1 || end !== 1 || !COMPONENTS[type])
            return null;
        components.push({
            component: COMPONENTS[type],
            level: status === DISCONNECTED || level > 100 ? null : level,
            charging: status === CHARGING,
        });
    }
    return {type: 'battery', components};
}

// Turn one received packet into an event object, or null if not understood
export function parsePacket(data) {
    if (startsWith(data, HANDSHAKE_ACK))
        return {type: 'handshake-ack'};
    if (startsWith(data, FEATURES_ACK))
        return {type: 'features-ack'};
    if (data.length === 11 && startsWith(data, [...CONTROL, ID_NOISE])) {
        const mode = data[7] - 1;
        return mode >= NOISE_OFF && mode <= NOISE_ADAPTIVE ? {type: 'noise', mode} : null;
    }
    if (startsWith(data, [...CONTROL, ID_CA])) {
        const on = switchState(data);
        return on === null ? null : {type: 'conversation-awareness', on};
    }
    if (startsWith(data, [...CONTROL, ID_ONE_BUD])) {
        const on = switchState(data);
        return on === null ? null : {type: 'one-bud', on};
    }
    if (data.length === 8 && startsWith(data, EAR_DETECTION)) {
        const ear = b => b <= EAR_CASE ? b : EAR_UNKNOWN;
        return {type: 'ear', primary: ear(data[6]), secondary: ear(data[7])};
    }
    if (data.length >= 7 && startsWith(data, BATTERY))
        return parseBattery(data);
    if (data.length === 10 && startsWith(data, SPEECH))
        return {type: 'speech', level: data[9]};
    if (startsWith(data, METADATA))
        return parseMetadata(data);
    return null;
}

// What each model can do, from the model number in the metadata packet
// (https://support.apple.com/en-us/109525). Same capability rules as omarchy-pods' enums.h.
const MODELS = {
    A1523: 'AirPods', A1722: 'AirPods', A2032: 'AirPods 2', A2031: 'AirPods 2',
    A2565: 'AirPods 3', A2564: 'AirPods 3',
    A3053: 'AirPods 4', A3050: 'AirPods 4', A3054: 'AirPods 4',
    A3056: 'AirPods 4 ANC', A3055: 'AirPods 4 ANC', A3057: 'AirPods 4 ANC',
    A2084: 'AirPods Pro', A2083: 'AirPods Pro',
    A2931: 'AirPods Pro 2', A2699: 'AirPods Pro 2', A2698: 'AirPods Pro 2',
    A3047: 'AirPods Pro 2', A3048: 'AirPods Pro 2', A3049: 'AirPods Pro 2',
    A3063: 'AirPods Pro 3', A3064: 'AirPods Pro 3', A3065: 'AirPods Pro 3',
    A2096: 'AirPods Max', A3184: 'AirPods Max', A3454: 'AirPods Max 2',
};

const H2 = ['AirPods 4 ANC', 'AirPods Pro 2', 'AirPods Pro 3', 'AirPods Max 2'];
const NO_NOISE_CONTROL = ['AirPods', 'AirPods 2', 'AirPods 3', 'AirPods 4'];
const ONE_BUD = ['AirPods 4 ANC', 'AirPods Pro', 'AirPods Pro 2', 'AirPods Pro 3'];

// Unknown models keep listening modes and lose the rest until the AirPods
// report a setting themselves
export function capabilities(modelNumber) {
    const family = MODELS[modelNumber] ?? null;
    return {
        family,
        isHeadset: family?.startsWith('AirPods Max') ?? false,
        noiseControl: !NO_NOISE_CONTROL.includes(family),
        // The Pro 3 accepts the Off packet and ignores it
        noiseOff: family !== 'AirPods Pro 3',
        adaptive: H2.includes(family),
        conversationAwareness: H2.includes(family),
        oneBud: ONE_BUD.includes(family),
    };
}
