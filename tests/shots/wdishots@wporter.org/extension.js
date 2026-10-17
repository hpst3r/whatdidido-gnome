// SPDX-License-Identifier: AGPL-3.0-or-later
//
// TEST-ONLY helper extension for the screenshot harness (scripts/shots.sh).
// It is loaded only into the isolated headless shell that script starts and
// is never packed. It exports org.wporter.WdiShots on that shell's private
// session bus so tests/shots/driver.js can open the whatdidido menu, click
// its actors with real (virtual device) pointer events, change the
// extension's settings and take cropped screenshots.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const TARGET_UUID = 'whatdidido@wporter.org';
const BUS_NAME = 'org.wporter.WdiShots';
const OBJECT_PATH = '/org/wporter/WdiShots';
const HEARTBEAT_MS = 100;
const STALL_LOG_MS = 400;
const SETTLE_QUIET_MS = 400;
const SETTLE_MAX_MS = 5000;
// Implicit transitions are named after the property they animate.
const EASED_PROPS = ['opacity', 'scale-x', 'scale-y', 'translation-x', 'translation-y',
    'x', 'y', 'width', 'height', 'background-color', 'rotation-angle-z'];

const IFACE_XML = `
<node>
  <interface name="org.wporter.WdiShots">
    <method name="Ping"><arg type="s" direction="out"/></method>
    <method name="Status"><arg type="s" direction="out"/></method>
    <method name="SetEnabled">
      <arg name="uuid" type="s" direction="in"/>
      <arg name="enabled" type="b" direction="in"/>
    </method>
    <method name="HideOverview"/>
    <method name="ResetSettings"/>
    <method name="SetSetting">
      <arg name="key" type="s" direction="in"/>
      <arg name="value" type="s" direction="in"/>
    </method>
    <method name="SetInterface">
      <arg name="key" type="s" direction="in"/>
      <arg name="value" type="s" direction="in"/>
    </method>
    <method name="OpenMenu">
      <arg name="uuid" type="s" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="CloseMenu"/>
    <method name="Click">
      <arg name="name" type="s" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="ClickLabel">
      <arg name="text" type="s" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="Hover">
      <arg name="name" type="s" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="Key">
      <arg name="keyval" type="u" direction="in"/>
    </method>
    <method name="PointerMove">
      <arg name="x" type="d" direction="in"/>
      <arg name="y" type="d" direction="in"/>
    </method>
    <method name="MenuBounds"><arg type="s" direction="out"/></method>
    <method name="MenuLabels"><arg type="s" direction="out"/></method>
    <method name="FindActors">
      <arg name="prefix" type="s" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="Settle"><arg type="s" direction="out"/></method>
    <method name="Screenshot">
      <arg name="path" type="s" direction="in"/>
      <arg name="x" type="i" direction="in"/>
      <arg name="y" type="i" direction="in"/>
      <arg name="width" type="i" direction="in"/>
      <arg name="height" type="i" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="BackdatePause">
      <arg name="ms" type="u" direction="in"/>
      <arg type="b" direction="out"/>
    </method>
    <method name="Log">
      <arg name="message" type="s" direction="in"/>
    </method>
  </interface>
</node>`;

function walk(actor, fn) {
    fn(actor);
    for (const child of actor.get_children())
        walk(child, fn);
}

function bounds(actor) {
    const ext = actor.get_transformed_extents();
    return {
        x: Math.round(ext.origin.x), y: Math.round(ext.origin.y),
        width: Math.round(ext.size.width), height: Math.round(ext.size.height),
    };
}

function isAncestor(ancestor, actor) {
    for (let a = actor; a; a = a.get_parent()) {
        if (a === ancestor)
            return true;
    }
    return false;
}

function describe(actor) {
    if (!actor)
        return 'nothing';
    let named = actor;
    while (named && !named.get_name())
        named = named.get_parent();
    const cls = actor.constructor?.name ?? '?';
    return named ? `${cls} in ${named.get_name()}` : cls;
}

function insensitive(actor) {
    return !actor.reactive || actor.has_style_pseudo_class?.('insensitive');
}

function delay(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

// Async D-Bus methods: run fn, reply with its (JSON) result or its error.
function reply(invocation, signature, fn) {
    fn().then(value => {
        invocation.return_value(signature ? new GLib.Variant(signature, [value]) : null);
    }).catch(e => {
        invocation.return_dbus_error('org.wporter.WdiShots.Error', e.message);
    });
}

class ShotsService {
    constructor() {
        const seat = Clutter.get_default_backend().get_default_seat();
        this._pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        this._uuid = TARGET_UUID;
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, this);
        this._dbus.export(Gio.DBus.session, OBJECT_PATH);
        this._nameId = Gio.bus_own_name_on_connection(Gio.DBus.session,
            BUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null);
        // Main loop heartbeat: logged stalls tell a slow shell from a hung one.
        this._beat = GLib.get_monotonic_time();
        this._beatId = GLib.timeout_add(GLib.PRIORITY_HIGH, HEARTBEAT_MS, () => {
            const now = GLib.get_monotonic_time();
            const late = (now - this._beat) / 1000 - HEARTBEAT_MS;
            if (late > STALL_LOG_MS)
                console.log(`[wdishots] main loop stall ${Math.round(late)} ms`);
            this._beat = now;
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        if (this._beatId)
            GLib.source_remove(this._beatId);
        this._beatId = 0;
        if (this._nameId)
            Gio.bus_unown_name(this._nameId);
        this._nameId = 0;
        this._dbus?.unexport();
        this._dbus = null;
        this._pointer = null;
        this._keyboard = null;
    }

    _extension(uuid = this._uuid) {
        return Main.extensionManager.lookup(uuid) ?? null;
    }

    _settings() {
        const settings = this._extension()?.stateObj?.getSettings?.();
        if (!settings)
            throw new Error(`${this._uuid} has no settings`);
        return settings;
    }

    _indicator(uuid = this._uuid) {
        return Main.panel.statusArea[uuid] ?? null;
    }

    _menu() {
        const menu = this._indicator()?.menu;
        if (!menu)
            throw new Error(`${this._uuid} has no panel menu`);
        return menu;
    }

    _openMenuActor() {
        const menu = this._menu();
        if (!menu.isOpen)
            throw new Error('the menu is not open');
        return menu.actor;
    }

    Ping() {
        return 'pong';
    }

    Status() {
        const extensions = {};
        for (const uuid of Main.extensionManager.getUuids()) {
            const ext = Main.extensionManager.lookup(uuid);
            extensions[uuid] = {state: ext.state, error: ext.error ? String(ext.error) : ''};
        }
        return JSON.stringify({
            startingUp: Boolean(Main.layoutManager._startingUp),
            overviewVisible: Main.overview.visible,
            colorScheme: St.Settings.get().color_scheme,
            styleVariant: Main.getStyleVariant(),
            enableAnimations: St.Settings.get().enable_animations,
            indicator: Boolean(this._indicator()),
            extensions,
        });
    }

    // The public path (enabled-extensions in the private dconf); the target
    // is enabled after this helper, so it is the only one restarted.
    SetEnabled(uuid, enabled) {
        if (enabled)
            Main.extensionManager.enableExtension(uuid);
        else
            Main.extensionManager.disableExtension(uuid);
    }

    HideOverview() {
        Main.overview.hide();
    }

    // Banners the shell shows shortly after startup would sit behind the
    // menu: drop every notification source before a menu opens (Do Not
    // Disturb would add a panel icon and move the indicator instead).
    _quiet() {
        for (const source of Main.messageTray.getSources())
            source.destroy();
    }

    ResetSettings() {
        const settings = this._settings();
        for (const key of settings.settings_schema.list_keys())
            settings.reset(key);
        Gio.Settings.sync();
    }

    _set(settings, key, text) {
        const schema = settings.settings_schema;
        if (!schema.has_key(key))
            throw new Error(`no key ${key} in ${schema.get_id()}`);
        const type = schema.get_key(key).get_value_type();
        settings.set_value(key, GLib.Variant.parse(type, text, null, null));
        Gio.Settings.sync();
    }

    SetSetting(key, text) {
        this._set(this._settings(), key, text);
    }

    SetInterface(key, text) {
        this._interface ??= new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._set(this._interface, key, text);
    }

    // Opens the menu the way a user does: a real click on the panel button.
    OpenMenuAsync([uuid], invocation) {
        reply(invocation, '(s)', async () => {
            this._uuid = uuid || TARGET_UUID;
            const indicator = this._indicator();
            if (!indicator)
                throw new Error(`no panel button for ${this._uuid}`);
            if (indicator.menu.isOpen) {
                indicator.menu.close(false);
                await delay(50);
            }
            this._quiet();
            // A freshly enabled button is still being laid out (its icons
            // change with the first status): click once it stays put.
            let r = null;
            for (let i = 0, last = '', same = 0; i < 100 && same < 3; i++) {
                await delay(20);
                r = bounds(indicator);
                const key = JSON.stringify(r);
                same = indicator.is_mapped() && r.width > 0 && key === last ? same + 1 : 0;
                last = key;
            }
            for (let attempt = 0; attempt < 2 && !indicator.menu.isOpen; attempt++) {
                if (attempt)
                    console.log('[wdishots] OpenMenu: no menu after the first click, clicking again');
                await this._click(r.x + r.width / 2, r.y + r.height / 2);
                for (let i = 0; i < 50 && !indicator.menu.isOpen; i++)
                    await delay(20);
            }
            if (!indicator.menu.isOpen) {
                const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, r.x + r.width / 2, r.y + r.height / 2);
                throw new Error(`the menu did not open on two clicks on its panel button at ${JSON.stringify(r)} (picked: ${describe(picked)})`);
            }
            return JSON.stringify(r);
        });
    }

    CloseMenu() {
        const menu = this._indicator()?.menu;
        if (menu?.isOpen)
            menu.close(false);
    }

    _named(name) {
        const root = this._openMenuActor();
        let found = null;
        walk(root, a => {
            if (!found && a.get_name() === name)
                found = a;
        });
        if (!found)
            throw new Error(`no actor named ${name} in the menu`);
        return found;
    }

    _labeled(text) {
        const root = this._openMenuActor();
        const hits = [];
        walk(root, a => {
            if (a instanceof St.Label && a.get_text() === text && a.is_mapped())
                hits.push(a);
        });
        if (!hits.length)
            throw new Error(`no visible label "${text}" in the menu`);
        // The nearest reactive ancestor takes the click (menu items).
        for (const label of hits) {
            for (let a = label; a && a !== root; a = a.get_parent()) {
                if (a.reactive)
                    return a;
            }
        }
        throw new Error(`label "${text}" is not inside a reactive (sensitive) actor`);
    }

    // Center of a clickable actor, after the checks a user would notice.
    _target(actor, label) {
        if (!actor.is_mapped())
            throw new Error(`${label} is not visible`);
        if (insensitive(actor))
            throw new Error(`${label} is insensitive`);
        const r = bounds(actor);
        if (r.width <= 0 || r.height <= 0)
            throw new Error(`${label} has no size`);
        const x = r.x + r.width / 2, y = r.y + r.height / 2;
        const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        if (!isAncestor(actor, picked))
            throw new Error(`${label} is covered at its center by ${describe(picked)}`);
        return {x, y, bounds: r};
    }

    async _click(x, y) {
        this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
        await delay(40);
        this._pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        await delay(40);
        this._pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        await delay(40);
    }

    ClickAsync([name], invocation) {
        reply(invocation, '(s)', async () => {
            const t = this._target(this._named(name), name);
            await this._click(t.x, t.y);
            return JSON.stringify(t.bounds);
        });
    }

    ClickLabelAsync([text], invocation) {
        reply(invocation, '(s)', async () => {
            const t = this._target(this._labeled(text), `label "${text}"`);
            await this._click(t.x, t.y);
            return JSON.stringify(t.bounds);
        });
    }

    HoverAsync([name], invocation) {
        reply(invocation, '(s)', async () => {
            const actor = this._named(name);
            if (!actor.is_mapped())
                throw new Error(`${name} is not visible`);
            const r = bounds(actor);
            this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), r.x + r.width / 2, r.y + r.height / 2);
            await delay(100);
            return JSON.stringify(r);
        });
    }

    Key(keyval) {
        this._keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.PRESSED);
        this._keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.RELEASED);
    }

    PointerMove(x, y) {
        this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
    }

    MenuBounds() {
        const indicator = this._indicator();
        const monitor = Main.layoutManager.primaryMonitor;
        return JSON.stringify({
            open: Boolean(indicator?.menu.isOpen),
            menu: indicator?.menu.isOpen ? bounds(indicator.menu.actor) : null,
            button: indicator ? bounds(indicator) : null,
            monitor: {x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height},
        });
    }

    // Visible label texts in the open menu, top to bottom (assertions).
    MenuLabels() {
        const labels = [];
        walk(this._openMenuActor(), a => {
            if (a instanceof St.Label && a.is_mapped() && a.get_text())
                labels.push(a.get_text());
        });
        return JSON.stringify(labels);
    }

    FindActors(prefix) {
        const found = [];
        walk(global.stage, actor => {
            const name = actor.get_name();
            if (!name || !name.startsWith(prefix))
                return;
            found.push({
                name,
                ...bounds(actor),
                visible: actor.is_mapped(),
                reactive: actor.reactive,
                insensitive: Boolean(actor.has_style_pseudo_class?.('insensitive')),
            });
        });
        return JSON.stringify(found);
    }

    // No transition on the menu's actors and unchanged bounds for
    // SETTLE_QUIET_MS (BoxPointer open, hover fades, relayouts).
    async _settle() {
        const root = this._openMenuActor();
        const start = GLib.get_monotonic_time() / 1000;
        let quietSince = start;
        let last = '';
        for (;;) {
            // Closed, or gone (extension disabled, shell shutting down).
            const menu = this._dbus ? this._indicator()?.menu : null;
            if (!menu?.isOpen || menu.actor !== root)
                throw new Error('the menu closed while settling');
            const now = GLib.get_monotonic_time() / 1000;
            let busy = false;
            walk(root, a => {
                busy ||= EASED_PROPS.some(p => a.get_transition(p));
            });
            const key = JSON.stringify(bounds(root));
            if (busy || key !== last)
                quietSince = now;
            last = key;
            if (now - quietSince >= SETTLE_QUIET_MS)
                return {settled: true, ms: Math.round(now - start)};
            if (now - start > SETTLE_MAX_MS)
                return {settled: false, ms: Math.round(now - start)};
            await delay(50);
        }
    }

    SettleAsync(_args, invocation) {
        reply(invocation, '(s)', async () => JSON.stringify(await this._settle()));
    }

    ScreenshotAsync([path, x, y, width, height], invocation) {
        reply(invocation, '(s)', async () => {
            const settle = this._menu().isOpen ? await this._settle() : {settled: true, ms: 0};
            const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
            try {
                await new Promise((resolve, reject) => {
                    new Shell.Screenshot().screenshot_area(x, y, width, height, stream, (obj, res) => {
                        try {
                            obj.screenshot_area_finish(res);
                            resolve();
                        } catch (e) {
                            reject(e);
                        }
                    });
                });
            } finally {
                stream.close(null);
            }
            return JSON.stringify(settle);
        });
    }

    // Test-only poke: the extension counts a pause from the first poll that
    // saw it (README "Counting caveat"), so a "paused for 12 min" shot moves
    // that start back. False when the extension has no such state (anymore).
    BackdatePause(ms) {
        const indicator = this._extension()?.stateObj?._indicator;
        const reminder = indicator?._reminder;
        if (!reminder || typeof reminder._pausedSince !== 'number')
            return false;
        reminder._pausedSince -= ms;
        indicator._render?.();
        return true;
    }

    Log(message) {
        console.log(`[wdishots] ${message}`);
    }
}

export default class WdiShotsExtension extends Extension {
    enable() {
        this._service = new ShotsService();
    }

    disable() {
        this._service?.destroy();
        this._service = null;
    }
}
