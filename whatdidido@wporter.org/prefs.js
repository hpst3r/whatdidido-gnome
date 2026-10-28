import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    TITLE_RULES_MAX, formatExcludedApps, formatTitleRules, parseExcludedApps, parseTitleRule, titleEntryProblem,
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
            description: 'Only sent to the local work session, only while it is recording (or paused, to a ' +
                'session whose at-rest guard takes window reports; not counted as active time), and only if ' +
                'the server offers it (--window-activity).',
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
            title: 'Delay digit-only title changes',
            subtitle: 'A title that only changes a number of up to 3 digits (an FPS counter, Issue 123 → 124) is ' +
                'sent once it has stayed the same for 15 seconds; longer numbers such as ticket numbers at once',
        });
        settings.bind('window-title-ignore-digit-changes', digits, 'active', Gio.SettingsBindFlags.DEFAULT);
        activity.add(digits);

        page.add(this._titleRules(settings, ids, window));

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

    // window-title-rules: one expander row per rule. A row is saved on Enter
    // or when focus leaves one of its entries, and only when the whole row
    // is valid (parseTitleRule); until then the setting keeps the row's last
    // saved value, so editing a rule never drops it. Removing a row saves at
    // once; a new row is saved only once it is valid and committed. Closing
    // the window commits every valid row.
    _titleRules(settings, ids, window) {
        const group = new Adw.PreferencesGroup({
            title: 'Window title rules',
            description: 'The first rule that matches replaces the window title before it is sent (an empty ' +
                'label sends an empty title). Pattern: the whole title, case-insensitive, * for any text, ? for ' +
                'one character, e.g. *Discord*. App: empty for every app, or an app id or WM class (a pattern of ' +
                'only * and ? needs one: it matches every title). Press Enter ' +
                'to save a rule. While a rule is invalid, or a title is longer than 4096 characters, every title ' +
                'is sent empty. Rules only change what is sent as the window title, not screenshots.',
        });
        const add = new Gtk.Button({icon_name: 'list-add-symbolic', tooltip_text: 'Add rule', valign: Gtk.Align.CENTER});
        add.add_css_class('flat');
        group.set_header_suffix(add);

        // r.saved: the row's entry in the setting, or null (a new row).
        let rows = [];
        let written = null;  // the value this window last loaded or wrote, as JSON
        const read = () => settings.get_value('window-title-rules').deep_unpack();
        const fields = r => ({app: r.app.text, pattern: r.pattern.text, label: r.label.text});
        const write = () => {
            const value = rows.filter(r => r.saved).map(r => r.saved);
            written = JSON.stringify(value);
            if (written !== JSON.stringify(read()))
                settings.set_value('window-title-rules', new GLib.Variant('a(sss)', value));
        };
        // Each row's state: its problem as typed, whether it differs from
        // what is saved, and whether the saved entry itself can't be used
        // (from dconf: then every title is sent empty).
        const show = () => {
            let stored = 0;
            rows.forEach((r, i) => {
                const {rule, problem} = parseTitleRule(fields(r), i);
                const broken = r.saved ? titleEntryProblem(r.saved, stored++) !== null : false;
                const dirty = JSON.stringify(rule) !== JSON.stringify(r.saved);
                const summary = `${rule[0] || 'Any app'} → ${rule[2] || 'empty title'}`;
                let text;
                if (problem)
                    text = `Not saved: ${problem}.${r.saved && !broken ? ' The saved rule stays in use.' : ''}`;
                else
                    text = dirty ? `${summary} (press Enter to save)` : summary;
                if (broken)
                    text += ' Every window title is sent empty until this rule is fixed or removed.';
                r.expander.title = r.pattern.text || 'New rule';
                r.expander.subtitle = text;
                for (const entry of [r.app, r.pattern, r.label])
                    entry.remove_css_class('error');
                if (problem) {
                    const field = /^The app /.test(problem) ? r.app : /^The label /.test(problem) ? r.label : r.pattern;
                    field.add_css_class('error');
                }
            });
            add.sensitive = rows.length < TITLE_RULES_MAX;
        };
        const commit = r => {
            const i = rows.indexOf(r);
            if (i < 0)
                return;
            const {rule, problem} = parseTitleRule(fields(r), i);
            if (!problem && JSON.stringify(rule) !== JSON.stringify(r.saved)) {
                r.saved = rule;
                write();
            }
            show();
        };
        const addRow = ({app, pattern, label}, saved) => {
            const expander = new Adw.ExpanderRow({use_markup: false, expanded: !saved});
            const r = {expander, saved};
            const entry = (title, text) => {
                const row = new Adw.EntryRow({title, text, use_markup: false});
                row.connect('changed', show);
                row.connect('entry-activated', () => commit(r));
                const focus = new Gtk.EventControllerFocus();
                focus.connect('leave', () => commit(r));
                row.add_controller(focus);
                expander.add_row(row);
                return row;
            };
            r.app = entry('App id or WM class (empty = every app)', app);
            r.pattern = entry('Pattern (* any text, ? one character)', pattern);
            r.label = entry('Label (empty = empty title)', label);
            const remove = new Gtk.Button({icon_name: 'user-trash-symbolic', tooltip_text: 'Remove rule',
                valign: Gtk.Align.CENTER});
            remove.add_css_class('flat');
            remove.connect('clicked', () => {
                rows = rows.filter(x => x !== r);
                group.remove(expander);
                write();
                show();
            });
            expander.add_suffix(remove);
            group.add(expander);
            rows.push(r);
            return r;
        };
        // Rebuild from the setting, unless the change is this window's own
        // write. Loading never writes: entries that can't be used (possible
        // through dconf) stay, shown as such, until fixed or removed.
        const load = () => {
            const value = read();
            if (JSON.stringify(value) === written)
                return;
            for (const r of rows)
                group.remove(r.expander);
            rows = [];
            for (const [i, rule] of formatTitleRules(value).entries())
                addRow(rule, value[i]);
            written = JSON.stringify(value);
            show();
        };
        add.connect('clicked', () => {
            addRow({app: '', pattern: '', label: ''}, null).pattern.grab_focus();
            show();
        });
        ids.push(settings.connect('changed::window-title-rules', load));
        // Before the window's own close-request handler disconnects ids.
        window.connect('close-request', () => {
            for (const r of [...rows])
                commit(r);
            return false;
        });
        load();
        return group;
    }
}
