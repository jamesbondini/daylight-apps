// iPad-style window gestures: swipe four fingers to switch windows (switch.js)
// and pinch five fingers to close one (pinch.js).

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {WindowSwitcher} from './switch.js';
import {PinchToClose} from './pinch.js';

export default class WindowGesturesExtension extends Extension {
    enable() {
        // Each leaves alone a window the other is moving.
        this._switcher = new WindowSwitcher(() => this._pinch?.busy);
        this._pinch = new PinchToClose(() => this._switcher?.busy);
        // Four fingers moving sideways before the fifth lands would start a
        // swipe; wait until the pinch gives up (it does once fewer than five
        // fingers have moved a little).
        this._switcher.gesture.require_failure_of(this._pinch.gesture);
    }

    disable() {
        this._switcher.destroy();
        this._switcher = null;
        this._pinch.destroy();
        this._pinch = null;
    }
}
