// The top-bar popover's widgets (POPOVER.md sections 2, 4, 5). It renders the
// plain object lib/popover_model.js popoverView() returns: the blocks are
// built once, and each update() sets labels, classes and visibility in place;
// an inline list is rebuilt only when its items change. Widget state (the
// expanded list, the picked ticket, the dragged interval stop, the stop
// confirmation, the hovered bar) lives here and goes back into popoverView()
// through `ui`.
//
// Every control is an St.Button (or the shell's Slider) outside any
// PopupMenuItem, so clicking it never closes the menu; the extension closes
// the menu itself when it opens a link or the preferences.

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {INTERVAL_HOLD_MS} from './popover_model.js';

const STOP_CONFIRM_MS = 4000;     // "Cancel" + "Stop now" go back to "Stop session"
const KEY_COMMIT_MS = 600;        // keyboard/scroll interval changes commit after this pause
const CLEAN_UI = {expanded: null, ticket: '', stopConfirm: false, dragIndex: null, hold: null, hoverBar: null};
const PRESS_SCALE = 0.96;
const PRESS_MS = 150;
const PULSE_MS = 1200;            // half of the 2.4 s cycle (auto-reversed)
const PULSE_OPACITY = 115;        // 0.45
const BARS_PX = 38;               // the Today bars' height
const ICON_PX = 16;

function label(styleClass, params = {}) {
    return new St.Label({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...params});
}

function wrap(lbl) {
    lbl.clutter_text.line_wrap = true;
    lbl.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    lbl.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return lbl;
}

function hbox(styleClass = '', params = {}) {
    return new St.BoxLayout({style_class: styleClass, ...params});
}

function vbox(styleClass = '', params = {}) {
    return new St.BoxLayout({style_class: styleClass, orientation: Clutter.Orientation.VERTICAL, ...params});
}

function setClass(actor, name, on) {
    if (on)
        actor.add_style_class_name(name);
    else
        actor.remove_style_class_name(name);
}

function setSensitive(actor, sensitive) {
    actor.reactive = sensitive;
    actor.can_focus = sensitive;
}

function animationsOn() {
    return St.Settings.get().enable_animations;
}

// What makes a list's widgets differ; everything else is updated in place.
function listKey(items) {
    return JSON.stringify(items.map(i => [i.name, i.label, !!i.checked]));
}

export class Popover {
    // path: the extension directory (for icons/whatdidido.svg)
    // onAction(action): the extension runs an action (popover_model.js header);
    //   'interval' and 'assign' return a promise (assign: true on success)
    // onLink(link): open {view, params} in the app (the extension closes the menu)
    // changed(): widget state changed; the extension renders again
    constructor({path, onAction, onLink, changed}) {
        this._onAction = onAction;
        this._onLink = onLink;
        this._changed = changed;
        this._ui = {...CLEAN_UI};
        this._view = null;
        this._open = false;
        this._destroyed = false;
        this._stopTimer = 0;
        this._commitTimer = 0;
        this._holdTimer = 0;
        this._updating = false;     // inside update(): widget signals must not render again
        this._dirty = false;        // ...but ask for one render after it
        this._dirtyId = 0;
        this._sliderSync = false;
        this._sliderDragging = false;
        this._scrollAcc = 0;
        this._keys = {};
        this._focusNext = null;
        this._appIconId = null;
        this._pulsing = false;

        this._content = vbox('wdi-pop', {name: 'wdi-pop', x_expand: true});
        // Scrolls only when a screen is too short for an expanded list (the
        // panel menu caps its height at the work area).
        this.actor = new St.ScrollView({
            name: 'wdi-pop-scroll',
            style_class: 'wdi-pop-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            child: this._content,
        });
        this._buildHeader(path);
        this._buildStatus();
        this._notices = vbox('wdi-pop-notices');
        this._content.add_child(this._notices);
        this._buildTiles();
        this._buildInput();
        this._buildInterval();
        this._buildNow();
        this._buildToday();
        this._openButton = this._button('wdi-pop-open', 'wdi-pop-open', label('wdi-pop-open-label', {x_expand: true, x_align: Clutter.ActorAlign.CENTER}));
        this._openButton.x_expand = true;
        this._openButton.connect('clicked', () => this._link(this._view?.open.link));
        this._content.add_child(this._openButton);
        this._buildFooter();
    }

    // Widget state for popoverView's `ui` (the extension adds its busy flags).
    get ui() {
        return {...this._ui};
    }

    // Show one inline list ('input' | 'ticket') or none.
    expand(list) {
        this._ui.expanded = list;
        this._changed();
    }

    // The menu opened or closed: the pulse runs only while open; closing
    // commits a pending interval stop at once (Amendment 2.2) and forgets the
    // widget state, so the next open starts clean.
    setOpen(open) {
        if (this._destroyed)
            return;
        this._open = open;
        if (!open) {
            this._clearStopTimer();
            if (this._commitTimer || this._sliderDragging) {
                this._sliderDragging = false;
                this._commitInterval();
            }
            this._clearCommitTimer();
            this._clearHoldTimer();
            this._ui = {...CLEAN_UI};
            this._sliderDragging = false;
        }
        this._syncPulse();
    }

    destroy() {
        this._destroyed = true;
        this._clearStopTimer();
        this._clearCommitTimer();
        this._clearHoldTimer();
        if (this._dirtyId)
            GLib.source_remove(this._dirtyId);
        this._dirtyId = 0;
        this._dot.remove_all_transitions();
        this.actor.destroy();
    }

    // --- building -------------------------------------------------------

    // Keyboard focus scrolls the control into view (short screens).
    _keepVisible(actor) {
        actor.connect('key-focus-in', () => ensureActorVisibleInScrollView(this.actor, actor));
    }

    // An St.Button with press feedback and a fixed name.
    _button(name, styleClass, child = null) {
        const b = new St.Button({
            name,
            style_class: `wdi-pop-button ${styleClass}`,
            can_focus: true,
            reactive: true,
            track_hover: true,
            child,
        });
        b.set_pivot_point(0.5, 0.5);
        this._keepVisible(b);
        b.connect('notify::pressed', () => {
            const scale = b.pressed ? PRESS_SCALE : 1;
            if (!animationsOn()) {
                b.set_scale(1, 1);
                return;
            }
            b.ease({scale_x: scale, scale_y: scale, duration: PRESS_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        });
        return b;
    }

    _buildHeader(path) {
        const row = hbox('wdi-pop-header');
        const logo = new St.Icon({
            style_class: 'wdi-pop-logo',
            gicon: Gio.FileIcon.new(Gio.File.new_for_path(`${path}/icons/whatdidido.svg`)),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = label('wdi-pop-title', {x_expand: true});
        this._settings = this._button('wdi-pop-settings', 'wdi-pop-round wdi-pop-settings',
            new St.Icon({icon_name: 'emblem-system-symbolic', icon_size: ICON_PX}));
        this._settings.y_align = Clutter.ActorAlign.CENTER;
        this._settings.connect('clicked', () => this._act(this._view?.header.settings.action));
        row.add_child(logo);
        row.add_child(this._title);
        row.add_child(this._settings);
        this._content.add_child(row);
    }

    _buildStatus() {
        this._status = hbox('wdi-pop-card wdi-pop-status', {name: 'wdi-pop-status'});
        this._dot = new St.Widget({style_class: 'wdi-pop-dot', y_align: Clutter.ActorAlign.CENTER});
        this._statusIcon = new St.Icon({style_class: 'wdi-pop-status-icon', icon_size: 22, y_align: Clutter.ActorAlign.START});
        const text = vbox('wdi-pop-status-text', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._statusTitle = label('wdi-pop-status-title');
        this._statusSub = wrap(label('wdi-pop-status-sub wdi-pop-muted'));
        text.add_child(this._statusTitle);
        text.add_child(this._statusSub);
        this._primaryIcon = new St.Icon({icon_size: ICON_PX});
        this._primary = this._button('wdi-pop-primary', 'wdi-pop-primary', this._primaryIcon);
        this._primary.y_align = Clutter.ActorAlign.CENTER;
        this._primary.connect('clicked', () => this._act(this._view?.status.primary?.action));
        this._status.add_child(this._dot);
        this._status.add_child(this._statusIcon);
        this._status.add_child(text);
        this._status.add_child(this._primary);
        this._content.add_child(this._status);
    }

    _tile(name, styleClass) {
        const icon = new St.Icon({icon_size: ICON_PX, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        const circle = new St.Bin({style_class: 'wdi-pop-tile-icon', child: icon, y_align: Clutter.ActorAlign.CENTER});
        const title = label('wdi-pop-tile-title');
        const sub = label('wdi-pop-tile-sub');
        const text = vbox('wdi-pop-tile-text', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        text.add_child(title);
        text.add_child(sub);
        const box = hbox('wdi-pop-tile-box');
        box.add_child(circle);
        box.add_child(text);
        const button = this._button(name, `wdi-pop-tile ${styleClass}`, box);
        button.x_align = Clutter.ActorAlign.START;
        return {button, icon, title, sub};
    }

    _buildTiles() {
        this._tiles = vbox('wdi-pop-tiles');
        this._tileRows = [hbox('wdi-pop-tile-row'), hbox('wdi-pop-tile-row')];
        for (const r of this._tileRows)
            this._tiles.add_child(r);
        this._mic = this._tile('wdi-pop-mic', 'wdi-pop-switch');
        this._mic.button.accessible_role = Atk.Role.TOGGLE_BUTTON;
        this._mic.button.connect('clicked', () => this._act(this._view?.tiles.mic.action));
        this._phi = this._tile('wdi-pop-phi', 'wdi-pop-phi');
        this._phi.button.connect('clicked', () => this._link(this._view?.tiles.phi.link));
        this._window = this._tile('wdi-pop-window', 'wdi-pop-switch');
        this._window.button.accessible_role = Atk.Role.TOGGLE_BUTTON;
        this._window.button.connect('clicked', () => this._act(this._view?.tiles.window.action));
        this._tileLayout = '';
        this._content.add_child(this._tiles);
    }

    _buildInput() {
        this._input = vbox('wdi-pop-card wdi-pop-picker');
        const row = hbox('wdi-pop-picker-row', {x_expand: true});
        this._inputTitle = label('wdi-pop-picker-title', {x_expand: true});
        const select = hbox('wdi-pop-select');
        this._inputValue = label('wdi-pop-select-label');
        this._inputArrow = new St.Icon({icon_name: 'pan-down-symbolic', icon_size: ICON_PX, style_class: 'wdi-pop-select-arrow'});
        select.add_child(this._inputValue);
        select.add_child(this._inputArrow);
        row.add_child(this._inputTitle);
        row.add_child(select);
        this._inputButton = this._button('wdi-pop-input', 'wdi-pop-picker-button', row);
        this._inputButton.x_expand = true;
        this._inputButton.connect('clicked', () => this._act(this._view?.input.action));
        this._inputList = vbox('wdi-pop-list');
        this._inputEmpty = label('wdi-pop-list-empty wdi-pop-muted');
        this._input.add_child(this._inputButton);
        this._input.add_child(this._inputList);
        this._content.add_child(this._input);
    }

    _buildInterval() {
        this._interval = vbox('wdi-pop-card wdi-pop-block wdi-pop-interval-block');
        const row = hbox('wdi-pop-block-head');
        this._intervalTitle = label('wdi-pop-block-title', {x_expand: true});
        this._intervalValue = label('wdi-pop-block-value wdi-pop-muted');
        row.add_child(this._intervalTitle);
        row.add_child(this._intervalValue);
        this._slider = new Slider(0);
        this._slider.name = 'wdi-pop-interval';
        this._slider.add_style_class_name('wdi-pop-slider');
        this._keepVisible(this._slider);
        // The slider (an St.DrawingArea) paints no background or shadow of
        // its own: its focus ring is drawn by this bin (Amendment 2.4).
        this._slider.x_expand = true;
        this._sliderBin = new St.Bin({style_class: 'wdi-pop-slider-bin', child: this._slider, x_expand: true});
        this._slider.connect('key-focus-in', () => this._sliderBin.add_style_pseudo_class('focus'));
        this._slider.connect('key-focus-out', () => this._sliderBin.remove_style_pseudo_class('focus'));
        this._slider.connect('notify::value', () => this._sliderMoved());
        this._slider.connect('drag-begin', () => {
            this._sliderDragging = true;
            this._clearCommitTimer();
        });
        this._slider.connect('drag-end', () => {
            this._sliderDragging = false;
            this._commitInterval();
        });
        // Whole stops for the keyboard and the wheel (the slider's own step
        // is 2 %, well below one stop).
        this._slider.connect('key-press-event', (_a, event) => {
            const key = event.get_key_symbol();
            if (key !== Clutter.KEY_Left && key !== Clutter.KEY_Right)
                return Clutter.EVENT_PROPAGATE;
            const rtl = this._slider.get_text_direction() === Clutter.TextDirection.RTL;
            this._stepInterval((key === Clutter.KEY_Right) !== rtl ? 1 : -1);
            return Clutter.EVENT_STOP;
        });
        this._slider.connect('scroll-event', (_a, event) => {
            const dir = event.get_scroll_direction();
            if (dir === Clutter.ScrollDirection.SMOOTH) {
                const [dx, dy] = event.get_scroll_delta();
                this._scrollAcc += Math.abs(dx) > Math.abs(dy) ? dx : -dy;
                while (Math.abs(this._scrollAcc) >= 1) {
                    const step = Math.sign(this._scrollAcc);
                    this._scrollAcc -= step;
                    this._stepInterval(step);
                }
            } else if (dir === Clutter.ScrollDirection.UP || dir === Clutter.ScrollDirection.RIGHT) {
                this._stepInterval(1);
            } else if (dir === Clutter.ScrollDirection.DOWN || dir === Clutter.ScrollDirection.LEFT) {
                this._stepInterval(-1);
            }
            return Clutter.EVENT_STOP;
        });
        this._interval.add_child(row);
        this._interval.add_child(this._sliderBin);
        this._content.add_child(this._interval);
    }

    _buildNow() {
        this._now = vbox('wdi-pop-card wdi-pop-block wdi-pop-now', {name: 'wdi-pop-now'});
        this._nowOver = label('wdi-pop-overline');
        this._now.add_child(this._nowOver);

        // x_expand: a short title stays left, not centered in the button.
        const row = hbox('wdi-pop-now-row', {x_expand: true});
        this._appIconBin = new St.Bin({style_class: 'wdi-pop-app-icon', y_align: Clutter.ActorAlign.CENTER});
        this._appInitials = label('wdi-pop-app-initials', {x_align: Clutter.ActorAlign.CENTER});
        const text = vbox('wdi-pop-now-text', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._appName = label('wdi-pop-app-name');
        this._appTitle = label('wdi-pop-app-title wdi-pop-muted');
        text.add_child(this._appName);
        text.add_child(this._appTitle);
        row.add_child(this._appIconBin);
        row.add_child(text);
        this._focusRow = this._button('wdi-pop-now-app', 'wdi-pop-now-app', row);
        this._focusRow.x_expand = true;
        this._focusRow.connect('clicked', () => this._link(this._view?.now.focus?.link));
        this._now.add_child(this._focusRow);

        this._nowRule = new St.Widget({style_class: 'wdi-pop-rule'});
        this._now.add_child(this._nowRule);

        this._stretch = vbox('wdi-pop-stretch');
        this._stretchText = label('wdi-pop-stretch-text wdi-pop-faint');
        const pick = hbox('wdi-pop-stretch-row');
        const select = hbox('wdi-pop-ticket-box', {x_expand: true});
        this._ticketLabel = label('wdi-pop-select-label', {x_expand: true});
        select.add_child(this._ticketLabel);
        select.add_child(new St.Icon({icon_name: 'pan-down-symbolic', icon_size: ICON_PX, style_class: 'wdi-pop-select-arrow'}));
        this._ticket = this._button('wdi-pop-ticket', 'wdi-pop-ticket', select);
        this._ticket.x_expand = true;
        this._ticket.connect('clicked', () => this._act(this._view?.now.stretch?.ticket.action));
        this._assign = this._button('wdi-pop-assign', 'wdi-pop-assign', label('wdi-pop-assign-label', {x_align: Clutter.ActorAlign.CENTER}));
        this._assign.connect('clicked', () => this._assignClicked());
        pick.add_child(this._ticket);
        pick.add_child(this._assign);
        this._ticketList = vbox('wdi-pop-list wdi-pop-ticket-list');
        this._stretch.add_child(this._stretchText);
        this._stretch.add_child(pick);
        this._stretch.add_child(this._ticketList);
        this._now.add_child(this._stretch);

        this._last = hbox('wdi-pop-last');
        this._lastDot = new St.Widget({style_class: 'wdi-pop-last-dot', y_align: Clutter.ActorAlign.CENTER});
        this._lastText = label('wdi-pop-last-text', {x_expand: true});
        this._last.add_child(this._lastDot);
        this._last.add_child(this._lastText);
        this._now.add_child(this._last);

        this._nowError = wrap(label('wdi-pop-now-error'));
        this._now.add_child(this._nowError);
        this._content.add_child(this._now);
    }

    _buildToday() {
        this._today = vbox('wdi-pop-card wdi-pop-today', {name: 'wdi-pop-today'});
        const head = hbox('wdi-pop-block-head');
        this._todayTitle = label('wdi-pop-block-title', {x_expand: true});
        this._todayLabel = label('wdi-pop-block-value wdi-pop-muted');
        head.add_child(this._todayTitle);
        head.add_child(this._todayLabel);
        this._bars = hbox('wdi-pop-bars', {x_expand: true});
        this._today.add_child(head);
        this._today.add_child(this._bars);
        this._content.add_child(this._today);
    }

    _buildFooter() {
        this._footer = hbox('wdi-pop-footer');
        this._footerText = label('wdi-pop-footer-text', {x_expand: true});
        this._stop = this._button('wdi-pop-stop', 'wdi-pop-link wdi-pop-stop', label(''));
        this._stop.connect('clicked', () => this._act(this._view?.footer.stop.action));
        this._cancel = this._button('wdi-pop-stop-cancel', 'wdi-pop-link', label(''));
        this._cancel.connect('clicked', () => this._act(this._view?.footer.cancel?.action));
        this._confirm = this._button('wdi-pop-stop-confirm', 'wdi-pop-link wdi-pop-stop', label(''));
        this._confirm.connect('clicked', () => this._act(this._view?.footer.confirmStop?.action));
        this._footer.add_child(this._footerText);
        this._footer.add_child(this._cancel);
        this._footer.add_child(this._confirm);
        this._footer.add_child(this._stop);
        this._content.add_child(this._footer);
    }

    // --- actions --------------------------------------------------------

    _act(action) {
        if (!action || this._destroyed)
            return;
        switch (action.action) {
        case 'expand':
            this._ui.expanded = action.list;
            this._changed();
            return;
        case 'pick-ticket':
            this._ui.ticket = action.ticket;
            this._ui.expanded = null;
            this._focusNext = this._assign;
            this._changed();
            return;
        case 'ask-stop':
            this._ui.stopConfirm = true;
            this._focusNext = this._cancel;
            this._clearStopTimer();
            this._stopTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, STOP_CONFIRM_MS, () => {
                this._stopTimer = 0;
                this._endStopConfirm(false);
                return GLib.SOURCE_REMOVE;
            });
            this._changed();
            return;
        case 'cancel-stop':
            this._endStopConfirm(true);
            return;
        case 'command':
            if (action.command === 'stop')
                this._endStopConfirm(false, false);
            this._onAction(action);
            return;
        default:
            this._onAction(action);
        }
    }

    _endStopConfirm(refocus, render = true) {
        this._clearStopTimer();
        if (!this._ui.stopConfirm)
            return;
        const focused = [this._cancel, this._confirm].some(b => b.has_key_focus());
        this._ui.stopConfirm = false;
        if (refocus || focused)
            this._focusNext = this._stop;
        if (render)
            this._changed();
    }

    _link(link) {
        if (link && !this._destroyed)
            this._onLink(link);
    }

    async _assignClicked() {
        const action = this._view?.now.stretch?.assign.action;
        if (!action)
            return;
        this._ui.expanded = null;
        const ok = await this._onAction(action);
        if (ok && !this._destroyed) {
            this._ui.ticket = '';
            this._changed();
        }
    }

    _clearStopTimer() {
        if (this._stopTimer)
            GLib.source_remove(this._stopTimer);
        this._stopTimer = 0;
    }

    _clearCommitTimer() {
        if (this._commitTimer)
            GLib.source_remove(this._commitTimer);
        this._commitTimer = 0;
    }

    _clearHoldTimer() {
        if (this._holdTimer)
            GLib.source_remove(this._holdTimer);
        this._holdTimer = 0;
    }

    // Widget state changed. Inside update() (a focus move, a list rebuilt)
    // the render waits for the next idle, so update() never re-enters.
    _uiChanged() {
        if (!this._updating) {
            this._changed();
            return;
        }
        this._dirty = true;
    }

    _sliderIndex() {
        const max = this._view?.interval.max ?? 1;
        return Math.max(0, Math.min(max, Math.round(this._slider.value * max)));
    }

    // A pointer drag: show the stop under the thumb, commit on release.
    _sliderMoved() {
        if (this._sliderSync || !this._sliderDragging)
            return;
        const index = this._sliderIndex();
        if (index !== this._ui.dragIndex) {
            this._ui.dragIndex = index;
            this._changed();
        }
    }

    _stepInterval(step) {
        const iv = this._view?.interval;
        if (!iv?.sensitive)
            return;
        const index = Math.max(0, Math.min(iv.max, iv.index + step));
        if (index === iv.index)
            return;
        this._ui.dragIndex = index;
        this._changed();
        this._clearCommitTimer();
        this._commitTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, KEY_COMMIT_MS, () => {
            this._commitTimer = 0;
            this._commitInterval();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Sends the shown stop once; the dragged label stays until the request
    // settles. A saved stop is then held until a status reports it or
    // INTERVAL_HOLD_MS pass (Amendment 2.3), so it never snaps back for one poll.
    async _commitInterval() {
        this._clearCommitTimer();
        const index = this._ui.dragIndex;
        const iv = this._view?.interval;
        if (index === null || !iv)
            return;
        const seconds = iv.steps[index];
        let saved = false;
        if (iv.sensitive && seconds !== iv.sessionSeconds) {
            try {
                saved = await this._onAction({action: 'interval', seconds}) !== false;
            } catch {}
        }
        if (this._destroyed || this._ui.dragIndex !== index || this._sliderDragging)
            return;
        this._ui.dragIndex = null;
        this._clearHoldTimer();
        this._ui.hold = null;
        if (saved) {
            this._ui.hold = {index, seconds, until: Date.now() + INTERVAL_HOLD_MS};
            // One render after the deadline drops the hold if no status came.
            this._holdTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, INTERVAL_HOLD_MS + 50, () => {
                this._holdTimer = 0;
                this._changed();
                return GLib.SOURCE_REMOVE;
            });
        }
        this._changed();
    }

    // --- rendering ------------------------------------------------------

    update(view) {
        if (this._destroyed)
            return;
        // A render asked for from inside this one (Amendment 2.5) runs after it.
        if (this._updating) {
            this._dirty = true;
            return;
        }
        this._updating = true;
        try {
            this._update(view);
        } finally {
            this._updating = false;
        }
        if (this._dirty && !this._dirtyId) {
            this._dirtyId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._dirtyId = 0;
                this._changed();
                return GLib.SOURCE_REMOVE;
            });
        }
        this._dirty = false;
    }

    _update(view) {
        this._view = view;
        for (const c of ['wdi-light', 'wdi-dark'])
            setClass(this._content, c, c === view.styleClass);

        this._title.text = view.header.title;
        this._settings.accessible_name = view.header.settings.accessibleName;

        this._updateStatus(view.status);
        this._updateNotices(view.notices);
        this._updateTiles(view.tiles);
        this._updateInput(view.input);
        this._updateInterval(view.interval);
        this._updateNow(view.now);
        this._updateToday(view.today);

        const open = view.open;
        this._openButton.visible = open.visible;
        this._openButton.child.text = open.label;
        this._openButton.accessible_name = open.accessibleName;
        setSensitive(this._openButton, open.sensitive);

        this._updateFooter(view.footer);
        this._syncPulse();

        const next = this._focusNext;
        this._focusNext = null;
        if (next?.mapped && next.reactive && this._open)
            next.grab_key_focus();
    }

    _updateStatus(s) {
        setClass(this._status, 'wdi-pop-status-paused', s.paused);
        setClass(this._status, 'wdi-pop-status-calm', s.kind !== 'session');
        this._dot.visible = !s.icon;
        for (const m of ['recording', 'paused', 'idle'])
            setClass(this._dot, `wdi-pop-dot-${m}`, s.mark === m);
        this._statusIcon.visible = !!s.icon;
        if (s.icon)
            this._statusIcon.icon_name = s.icon;
        this._statusTitle.text = s.title;
        this._statusSub.text = s.subtitle ?? '';
        this._statusSub.visible = !!s.subtitle;
        const p = s.primary;
        this._primary.visible = !!p;
        if (p) {
            this._primaryIcon.icon_name = p.icon;
            this._primary.accessible_name = p.accessibleName;
            setClass(this._primary, 'wdi-pop-accent', p.accent);
            setSensitive(this._primary, p.sensitive);
        }
    }

    _updateNotices(notices) {
        const labels = this._notices.get_children();
        for (const n of notices) {
            let l = labels[n.index];
            if (!l) {
                l = wrap(label('wdi-pop-notice'));
                this._notices.add_child(l);
            }
            l.name = n.name;
            l.text = n.text;
            l.show();
        }
        for (const l of labels.slice(notices.length))
            l.hide();
        this._notices.visible = notices.length > 0;
    }

    _updateTile(tile, t) {
        tile.button.visible = t.visible;
        tile.title.text = t.title;
        tile.sub.text = t.subtitle;
        tile.icon.icon_name = t.icon;
        tile.button.accessible_name = t.accessibleName;
        if ('on' in t)
            tile.button.checked = t.on;
        setClass(tile.button, 'wdi-pop-on', !!t.accent);
        setSensitive(tile.button, t.sensitive);
    }

    _updateTiles(tiles) {
        this._tiles.visible = tiles.visible;
        this._updateTile(this._mic, tiles.mic);
        this._updateTile(this._phi, tiles.phi);
        this._updateTile(this._window, tiles.window);
        // Two per row, in order; re-laid only when the visible set changes.
        const shown = [this._mic, this._phi, this._window].filter(t => t.button.visible);
        const key = shown.map(t => t.button.name).join();
        if (key === this._tileLayout)
            return;
        this._tileLayout = key;
        for (const t of [this._mic, this._phi, this._window])
            t.button.get_parent()?.remove_child(t.button);
        shown.forEach((t, i) => this._tileRows[Math.floor(i / 2)].add_child(t.button));
        this._tileRows[1].visible = shown.length > 2;
    }

    _syncList(box, key, items, build) {
        if (this._keys[key] === listKey(items))
            return;
        const refocus = box.get_children().some(c => c.has_key_focus());
        this._keys[key] = listKey(items);
        box.destroy_all_children();
        for (const item of items)
            box.add_child(build(item));
        if (refocus && this._open)
            box.get_first_child()?.grab_key_focus();
    }

    _listItem(item, onClick) {
        const row = hbox('wdi-pop-list-row', {x_expand: true});
        const check = new St.Icon({
            icon_name: 'object-select-symbolic',
            icon_size: ICON_PX,
            style_class: 'wdi-pop-check',
            opacity: item.checked ? 255 : 0,
        });
        row.add_child(check);
        row.add_child(label('wdi-pop-list-label', {text: item.label, x_expand: true}));
        const b = this._button(item.name, 'wdi-pop-list-item', row);
        b.x_expand = true;
        b.accessible_name = item.accessibleName;
        b.accessible_role = Atk.Role.RADIO_MENU_ITEM;
        b.checked = item.checked;
        b.connect('clicked', onClick);
        return b;
    }

    _updateInput(input) {
        this._input.visible = input.visible;
        this._inputTitle.text = input.title;
        this._inputValue.text = input.value;
        this._inputButton.accessible_name = input.accessibleName;
        setSensitive(this._inputButton, input.sensitive);
        setClass(this._input, 'wdi-pop-expanded', input.expanded);
        this._inputArrow.icon_name = input.expanded ? 'pan-up-symbolic' : 'pan-down-symbolic';
        this._inputList.visible = input.expanded;
        const items = input.emptyText ? [{name: 'wdi-pop-input-empty', label: input.emptyText}] : input.items;
        this._syncList(this._inputList, 'input', items, item => {
            if (input.emptyText)
                return wrap(label('wdi-pop-list-empty wdi-pop-muted', {text: item.label}));
            return this._listItem(item, () => {
                const current = this._view?.input.items.find(i => i.name === item.name);
                this._ui.expanded = null;
                this._focusNext = this._inputButton;
                this._changed();
                this._act(current?.action ?? item.action);
            });
        });
    }

    _updateInterval(iv) {
        this._interval.visible = iv.visible;
        this._intervalTitle.text = iv.title;
        this._intervalValue.text = iv.value;
        // The hold is over (a status reported it, or its time ran out).
        if (this._ui.hold && !iv.holding) {
            this._ui.hold = null;
            this._clearHoldTimer();
        }
        this._slider.accessible_name = `${iv.accessibleName}: ${iv.value}`;
        setSensitive(this._slider, iv.sensitive);
        // The shell's slider has no insensitive style of its own.
        this._slider.opacity = iv.sensitive ? 255 : 115;
        if (!this._sliderDragging) {
            this._sliderSync = true;
            this._slider.value = iv.fraction;
            this._sliderSync = false;
        }
    }

    _updateAppIcon(focus) {
        if (this._appIconId === focus.appId && this._appIconBin.child)
            return;
        this._appIconId = focus.appId;
        const app = focus.appId ? Shell.AppSystem.get_default().lookup_app(focus.appId) : null;
        setClass(this._appIconBin, 'wdi-pop-app-initials-bin', !app);
        if (app) {
            this._appIconBin.set_child(app.create_icon_texture(30));
        } else {
            this._appIconBin.set_child(this._appInitials);
        }
    }

    _updateNow(now) {
        this._now.visible = now.visible;
        if (!now.visible)
            return;
        this._now.opacity = now.dimmed ? 166 : 255;
        this._nowOver.text = now.overline;

        const f = now.focus;
        this._focusRow.visible = !!f;
        if (f) {
            this._appInitials.text = f.initials;
            this._updateAppIcon(f);
            this._appName.text = f.appName;
            this._appTitle.text = f.title;
            this._focusRow.accessible_name = f.accessibleName;
            setSensitive(this._focusRow, f.sensitive);
        }

        const st = now.stretch;
        this._stretch.visible = !!st;
        if (st) {
            this._stretchText.text = st.text;
            this._ticketLabel.text = st.ticket.label;
            setClass(this._ticket, 'wdi-pop-placeholder', !st.ticket.items.some(i => i.checked));
            this._ticket.accessible_name = st.ticket.accessibleName;
            setSensitive(this._ticket, st.ticket.sensitive);
            this._ticketList.visible = st.ticket.expanded;
            this._syncList(this._ticketList, 'ticket', st.ticket.items, item =>
                this._listItem(item, () => {
                    this._act(this._view?.now.stretch?.ticket.items.find(i => i.name === item.name)?.action ?? item.action);
                }));
            this._assign.child.text = st.assign.busy ? 'Assigning…' : st.assign.label;
            this._assign.accessible_name = st.assign.accessibleName;
            setSensitive(this._assign, st.assign.sensitive);
        }

        const last = now.last;
        this._last.visible = !!last;
        if (last) {
            this._lastText.text = last.text;
            this._lastDot.visible = !!last.color;
            if (last.color)
                this._lastDot.set_style(`background-color: ${last.color};`);
        }
        this._nowRule.visible = !!f && (!!st || !!last);
        this._nowError.visible = !!now.error;
        this._nowError.text = now.error ?? '';
    }

    _bar(bar) {
        const b = new St.Button({
            name: bar.name,
            style_class: 'wdi-pop-bar',
            can_focus: true,
            reactive: true,
            track_hover: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.END,
        });
        const index = bar.index;
        this._keepVisible(b);
        const hover = on => {
            if (on)
                this._ui.hoverBar = index;
            else if (this._ui.hoverBar === index)
                this._ui.hoverBar = null;
            else
                return;
            this._uiChanged();
        };
        b.connect('notify::hover', () => hover(b.hover));
        b.connect('key-focus-in', () => hover(true));
        b.connect('key-focus-out', () => hover(false));
        b.connect('clicked', () => {
            const current = this._view?.today.bars[index];
            if (current?.sensitive)
                this._link(current.link);
        });
        return b;
    }

    _updateToday(today) {
        this._today.visible = today.visible;
        this._todayTitle.text = today.title;
        this._todayLabel.text = today.label;
        // The bucket count changes every 15 minutes; colors and heights in
        // place. A focused bar hands focus to the bar at its index (or the
        // last bar), else to the Today block (Amendment 2.5).
        const children = this._bars.get_children();
        if (children.length !== today.bars.length) {
            const focused = children.findIndex(c => c.has_key_focus());
            this._bars.destroy_all_children();
            for (const bar of today.bars)
                this._bars.add_child(this._bar(bar));
            if (focused >= 0 && this._open) {
                const next = this._bars.get_child_at_index(Math.min(focused, today.bars.length - 1));
                if (next?.mapped)
                    next.grab_key_focus();
                else if (this._today.mapped)
                    this._today.grab_key_focus();
                else
                    this._openButton.grab_key_focus();
            }
        }
        // Like the app: while one bar is hovered or focused, the others fade.
        const hovered = Number.isInteger(this._ui.hoverBar) && this._ui.hoverBar < today.bars.length;
        this._bars.get_children().forEach((b, i) => {
            const bar = today.bars[i];
            b.opacity = hovered && i !== this._ui.hoverBar ? 128 : 255;
            const px = Math.max(2, Math.round(bar.height * BARS_PX));
            b.set_style(`height: ${px}px;${bar.color ? ` background-color: ${bar.color};` : ''}`);
            setClass(b, 'wdi-pop-bar-accent', bar.kind === 'accent');
            b.accessible_name = bar.accessibleName;
            // Always reactive: hovering shows the label even without an app
            // server; a click then does nothing.
            setClass(b, 'wdi-pop-bar-off', !bar.sensitive);
        });
    }

    _updateFooter(f) {
        this._footer.visible = f.visible;
        this._footerText.text = f.text;
        const set = (button, part) => {
            button.visible = !!part && part.visible !== false;
            if (!part)
                return;
            button.child.text = part.label;
            button.accessible_name = part.accessibleName;
            setSensitive(button, part.sensitive);
        };
        set(this._stop, f.stop);
        set(this._cancel, f.cancel);
        set(this._confirm, f.confirmStop);
        // The state no longer allows stop: forget the confirmation, so it
        // doesn't come back without its timeout.
        if (!f.confirm && this._ui.stopConfirm) {
            this._ui.stopConfirm = false;
            this._clearStopTimer();
        }
    }

    // The recording dot's slow pulse, only while the menu is open.
    _syncPulse() {
        const on = this._open && !!this._view?.status.pulse && animationsOn();
        if (on === this._pulsing)
            return;
        this._pulsing = on;
        this._dot.remove_all_transitions();
        this._dot.opacity = 255;
        if (on) {
            this._dot.ease({
                opacity: PULSE_OPACITY,
                duration: PULSE_MS,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                autoReverse: true,
                repeatCount: -1,
            });
        }
    }
}
