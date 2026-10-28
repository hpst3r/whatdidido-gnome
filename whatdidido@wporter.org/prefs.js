import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    TITLE_RULES_MAX, formatExcludedApps, formatTitleRules, parseExcludedApps, parseTitleRules,
} from './lib/window_model.js';

export default class WhatdididoPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();

        const polling = new Adw.PreferencesGroup({
            title: 'Polling',
            description: 'The status is also refreshed whenever the menu opens.',
        });
        page.add(polling);
        const active = new Adw.SpinRow({
            title: 'While active (seconds)',
            subtitle: 'Menu open, or starting, recording, reconnecting or stopping',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 60, step_increment: 1}),
        });
        settings.bind('poll-active', active, 'value', Gio.SettingsBindFlags.DEFAULT);
        polling.add(active);
        const idle = new Adw.SpinRow({
            title: 'While idle (seconds)',
            subtitle: 'Stopped, paused, failed or not running',
            adjustment: new Gtk.Adjustment({lower: 2, upper: 3600, step_increment: 5}),
        });
        settings.bind('poll-idle', idle, 'value', Gio.SettingsBindFlags.DEFAULT);
        polling.add(idle);

        const mic = new Adw.PreferencesGroup({
            title: 'Microphone',
            description: 'Choose the microphone from the top-bar menu → Microphone source. ' +
                'Only that microphone is ever turned on; if it is not connected the microphone stays off.',
        });
        page.add(mic);
        // Forget writes one key at a time: the stable id last, so the extension's
        // migration never re-adopts it from a legacy id not yet cleared.
        const MIC_KEYS = ['microphone-id', 'microphone-label', 'microphone-stable-id'];
        const preferred = new Adw.ActionRow({title: 'Chosen microphone'});
        const forget = new Gtk.Button({label: 'Forget microphone', valign: Gtk.Align.CENTER});
        forget.connect('clicked', () => {
            for (const key of MIC_KEYS)
                settings.set_string(key, '');
        });
        preferred.add_suffix(forget);
        mic.add(preferred);
        const sync = () => {
            const chosen = !!(settings.get_string('microphone-stable-id') || settings.get_string('microphone-id'));
            const label = settings.get_string('microphone-label');
            preferred.subtitle = chosen ? label || 'Unnamed microphone' : 'None chosen';
            forget.sensitive = MIC_KEYS.some(key => settings.get_string(key));
        };
        const ids = MIC_KEYS.map(key => settings.connect(`changed::${key}`, sync));
        sync();

        const activity = new Adw.PreferencesGroup({
            title: 'Active window',
            description: 'Only sent to the local work session, only while it is recording ' +
                '(never while paused), and only if the server offers it (--window-activity).',
        });
        page.add(activity);
        const report = new Adw.SwitchRow({
            title: 'Record active window',
            subtitle: 'App, WM class and window title of the focused window, for time accounting',
        });
        settings.bind('report-active-window', report, 'active', Gio.SettingsBindFlags.DEFAULT);
        activity.add(report);
        const excluded = new Adw.EntryRow({
            title: 'Apps whose titles are never sent (comma-separated app ids)',
            show_apply_button: true,
        });
        excluded.connect('apply', () =>
            settings.set_strv('window-title-excluded-apps', parseExcludedApps(excluded.text)));
        activity.add(excluded);
        const syncExcluded = () => {
            excluded.text = formatExcludedApps(settings.get_strv('window-title-excluded-apps'));
        };
        ids.push(settings.connect('changed::window-title-excluded-apps', syncExcluded));
        syncExcluded();
        const digits = new Adw.SwitchRow({
            title: 'Ignore digit-only title changes',
            subtitle: 'A title that only changes a number of up to 3 digits (an FPS counter) is not sent again; ' +
                'longer numbers such as ticket numbers always are',
        });
        settings.bind('window-title-ignore-digit-changes', digits, 'active', Gio.SettingsBindFlags.DEFAULT);
        activity.add(digits);

        page.add(this._titleRules(settings, ids));

        const reminders = new Adw.PreferencesGroup({
            title: 'Reminders',
            description: 'Counted from when the extension first saw the pause, or the microphone on without speech.',
        });
        page.add(reminders);
        const pauseReminder = new Adw.SpinRow({
            title: 'Remind while paused (minutes)',
            subtitle: 'A notification after this long paused, then again every this many minutes; 0 = off',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 240, step_increment: 1, page_increment: 10}),
        });
        settings.bind('pause-reminder-minutes', pauseReminder, 'value', Gio.SettingsBindFlags.DEFAULT);
        reminders.add(pauseReminder);
        const micReminder = new Adw.SpinRow({
            title: 'Remind to check the microphone after (minutes)',
            subtitle: 'A notification when the microphone is on but no speech was transcribed for this long, ' +
                'then again every this many minutes; 0 = never',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 240, step_increment: 1, page_increment: 10}),
        });
        settings.bind('mic-reminder-minutes', micReminder, 'value', Gio.SettingsBindFlags.DEFAULT);
        reminders.add(micReminder);

        window.connect('close-request', () => {
            for (const id of ids)
                settings.disconnect(id);
            return false;
        });

        // Adw.EntryRow has no subtitle, so the group's description carries it.
        const appGroup = new Adw.PreferencesGroup({
            title: 'App server',
            description: 'Leave empty to find it automatically from the work session. ' +
                'Otherwise only a local address works: http://127.0.0.1:<port>.',
        });
        page.add(appGroup);
        const appUrl = new Adw.EntryRow({title: 'App server URL', show_apply_button: true});
        appUrl.connect('apply', () => settings.set_string('app-url', appUrl.text.trim()));
        appGroup.add(appUrl);
        const syncAppUrl = () => {
            appUrl.text = settings.get_string('app-url');
        };
        ids.push(settings.connect('changed::app-url', syncAppUrl));
        syncAppUrl();

        const bar = new Adw.PreferencesGroup({title: 'Top bar'});
        page.add(bar);
        const showMic = new Adw.SwitchRow({
            title: 'Show microphone indicator',
            subtitle: 'A microphone icon next to the state icon while the microphone is on',
        });
        settings.bind('show-mic-indicator', showMic, 'active', Gio.SettingsBindFlags.DEFAULT);
        bar.add(showMic);

        window.add(page);
    }

    // window-title-rules: one expander row per rule. Every edit re-validates
    // (parseTitleRules) and saves the valid rules; a refused row shows why
    // and is not saved.
    _titleRules(settings, ids) {
        const group = new Adw.PreferencesGroup({
            title: 'Window title rules',
            description: 'The first rule that matches replaces the window title before it is sent (an empty ' +
                'label sends an empty title). Pattern: the whole title, case-insensitive, * for any text, ? for ' +
                'one character, e.g. *Discord*. App: empty for every app, or an app id or WM class. Rules only ' +
                'change what is sent as the window title, not screenshots.',
        });
        const add = new Gtk.Button({icon_name: 'list-add-symbolic', tooltip_text: 'Add rule', valign: Gtk.Align.CENTER});
        add.add_css_class('flat');
        group.set_header_suffix(add);

        let rows = [];
        let saved = null;  // the value this window last loaded or wrote, as JSON
        const read = () => settings.get_value('window-title-rules').deep_unpack();
        // Shows each row's problem; returns the rules to save.
        const validate = () => {
            const {rules, errors} = parseTitleRules(rows.map(r => ({
                app: r.app.text, pattern: r.pattern.text, label: r.label.text,
            })));
            rows.forEach((r, i) => {
                r.expander.title = r.pattern.text || 'New rule';
                r.expander.subtitle = errors[i] ? `Not saved: ${errors[i]}`
                    : `${r.app.text.trim() || 'Any app'} → ${r.label.text ? r.label.text : 'empty title'}`;
                for (const entry of [r.pattern, r.label])
                    entry.remove_css_class('error');
                if (errors[i])
                    (/label/.test(errors[i]) ? r.label : r.pattern).add_css_class('error');
            });
            add.sensitive = rows.length < TITLE_RULES_MAX;
            return rules;
        };
        const save = () => {
            const rules = validate();
            saved = JSON.stringify(rules);
            if (saved !== JSON.stringify(read()))
                settings.set_value('window-title-rules', new GLib.Variant('a(sss)', rules));
        };
        const addRow = ({app, pattern, label}, expanded) => {
            const expander = new Adw.ExpanderRow({use_markup: false, expanded});
            const entry = (title, text) => {
                const row = new Adw.EntryRow({title, text, use_markup: false});
                row.connect('changed', save);
                expander.add_row(row);
                return row;
            };
            const r = {
                expander,
                app: entry('App id or WM class (empty = every app)', app),
                pattern: entry('Pattern (* any text, ? one character)', pattern),
                label: entry('Label (empty = empty title)', label),
            };
            const remove = new Gtk.Button({icon_name: 'user-trash-symbolic', tooltip_text: 'Remove rule',
                valign: Gtk.Align.CENTER});
            remove.add_css_class('flat');
            remove.connect('clicked', () => {
                rows = rows.filter(x => x !== r);
                group.remove(expander);
                save();
            });
            expander.add_suffix(remove);
            group.add(expander);
            rows.push(r);
        };
        // Rebuild from the setting, unless the change is this window's own
        // write. Loading never writes: entries refused here (possible
        // through dconf) stay until the rules are edited.
        const load = () => {
            const value = read();
            if (JSON.stringify(value) === saved)
                return;
            for (const r of rows)
                group.remove(r.expander);
            rows = [];
            for (const rule of formatTitleRules(value))
                addRow(rule, false);
            saved = JSON.stringify(value);
            validate();
        };
        add.connect('clicked', () => {
            addRow({app: '', pattern: '', label: ''}, true);
            save();
        });
        ids.push(settings.connect('changed::window-title-rules', load));
        load();
        return group;
    }
}
