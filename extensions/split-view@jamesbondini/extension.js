// iPad-style Split View: drag a window's title bar to the left or right edge
// (drag.js) to put it beside another window, with a divider to resize the
// two (split.js).

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {SplitView} from './split.js';
import {TitleBarDrag} from './drag.js';

export default class SplitViewExtension extends Extension {
    enable() {
        this._split = new SplitView();
        this._drag = new TitleBarDrag(this._split);
    }

    disable() {
        this._drag.destroy();
        this._drag = null;
        this._split.destroy();
        this._split = null;
    }
}
