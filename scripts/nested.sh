#!/usr/bin/env bash
# Throwaway nested GNOME Shell (in a window) with only this extension enabled.
# Uses a separate dconf db (~/.config/dconf/whatdidido-nested), compiled
# offline, so your real session's enabled-extensions/prefs are never touched.
# The nested shell shares $XDG_RUNTIME_DIR, so it controls the same running
# work-session server as the real one would.
set -euo pipefail
UUID=whatdidido@wporter.org
RUN="${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR must be set}/whatdidido-nested"
DB="${XDG_CONFIG_HOME:-$HOME/.config}/dconf/whatdidido-nested"
mkdir -p "$RUN/keyfiles" "$(dirname "$DB")"

cat > "$RUN/keyfiles/00-nested" <<EOT
[org/gnome/shell]
disable-user-extensions=false
enabled-extensions=['$UUID']
welcome-dialog-last-shown-version='999'
EOT
# Recompiled each run: resets nested state; extension prefs changed inside
# the nested shell last only for that run.
dconf compile "$DB" "$RUN/keyfiles"
printf 'user-db:whatdidido-nested\n' > "$RUN/profile"

export DCONF_PROFILE="$RUN/profile"
export MUTTER_DEBUG_DUMMY_MODE_SPECS="${NESTED_SIZE:-1600x1000}"
exec dbus-run-session -- gnome-shell --devkit --wayland
