#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Screenshots of the whatdidido menu in an isolated headless GNOME Shell.
#
#   scripts/shots.sh [scenario ...]     (no args: every tests/shots/scenarios/*.json)
#
# Writes build/shots/<scenario>-<dark|light>.png (cropped to the open menu
# plus a margin) and build/shots/results.json. Exits non-zero if any
# scenario failed (after running the rest).
#
# Isolation: HOME, XDG dirs, the dconf database, the D-Bus session bus (it
# can only activate dconf), an empty private "system" bus and the Wayland
# socket all live under .shots/run-<timestamp>/ (sockets in a short private
# runtime dir linked as .shots/run-*/rt). The host session, its dconf, its
# buses, logind/GDM and ~/.local/share/gnome-shell are never touched; the
# host dconf database's mtime is checked before and after. The fake servers
# bind 127.0.0.1 on OS-picked ports and write control.json only into the
# private runtime dir.
#
# Environment:
#   SHOTS_TIMEOUT=secs  whole-run limit (default 600)
#   SHOTS_ANIMATIONS=1  keep animations on (default: off, stable images)
#   SHOTS_VARIANTS=...  "dark light" (default), or one of them
#   SHOTS_TZ=zone       time zone of the private session and the fakes
#                       (default America/New_York; fixtures are local times)
#   SHOTS_EXT_SRC=dir   extension tree to shoot (default ./whatdidido@wporter.org)
#   SHOTS_KEEP=1        keep the run dir (logs) even when everything passed

set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
UUID=whatdidido@wporter.org
HELPER=wdishots@wporter.org

if [[ -z ${SHOTS_INNER:-} ]]; then
    # ---- outer stage: prepare the private run dir, then re-exec inside a
    # private D-Bus session with a fully private environment.
    START=$(date +%s)
    TIMEOUT=${SHOTS_TIMEOUT:-600}
    RUN=$REPO/.shots/run-$(date +%Y%m%d-%H%M%S)-$$
    mkdir -p "$RUN"
    for d in home config data cache state; do
        mkdir -p "$RUN/$d"
        chmod 0700 "$RUN/$d"
    done
    OUT=$REPO/build/shots
    mkdir -p "$OUT"

    EXT_DIR=$RUN/data/gnome-shell/extensions
    mkdir -p "$EXT_DIR"
    cp -r "${SHOTS_EXT_SRC:-$REPO/$UUID}" "$EXT_DIR/$UUID"
    cp -r "$REPO/tests/shots/$HELPER" "$EXT_DIR/"
    # Compiled in the private copy only, never in the worktree.
    rm -f "$EXT_DIR/$UUID/schemas/gschemas.compiled"
    glib-compile-schemas --strict "$EXT_DIR/$UUID/schemas"

    # Links the menu opens go to a stand-in "browser" that only records them.
    mkdir -p "$RUN/data/applications"
    cat >"$RUN/data/applications/shots-browser.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Shots browser (records URLs)
Exec=sh -c 'echo "\$1" >>"$RUN/opened-urls.txt"' sh %u
MimeType=x-scheme-handler/http;x-scheme-handler/https;
NoDisplay=true
EOF
    cat >"$RUN/config/mimeapps.list" <<'EOF'
[Default Applications]
x-scheme-handler/http=shots-browser.desktop
x-scheme-handler/https=shots-browser.desktop
EOF

    # Private D-Bus configs: the session bus can only activate dconf; the
    # empty "system" bus keeps the shell away from the host's logind/GDM.
    mkdir -p "$RUN/dbus/services"
    cp /usr/share/dbus-1/services/ca.desrt.dconf.service "$RUN/dbus/services/"
    write_bus_conf() { # type listen-address servicedir file
        {
            echo '<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"'
            echo ' "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">'
            echo "<busconfig><type>$1</type><listen>$2</listen>"
            echo '<auth>EXTERNAL</auth>'
            [[ -n $3 ]] && echo "<servicedir>$3</servicedir>"
            echo '<policy context="default"><allow send_destination="*" eavesdrop="true"/>'
            echo '<allow eavesdrop="true"/><allow own="*"/></policy></busconfig>'
        } >"$4"
    }
    # Sockets overflow sun_path (~107 bytes) under a deep worktree: a short
    # private runtime dir, linked as $RUN/rt and removed afterwards.
    RT=$(mktemp -d "${TMPDIR:-/tmp}/wdishots-XXXXXX")
    chmod 0700 "$RT"
    ln -s "$RT" "$RUN/rt"
    write_bus_conf session "unix:path=$RT/bus" "$RUN/dbus/services" "$RUN/dbus/session.conf"
    SYSTEM_SOCK=$RT/sysbus
    write_bus_conf system "unix:path=$SYSTEM_SOCK" "" "$RUN/dbus/system.conf"

    # Every process of the private session carries SHOTS_RUN_MARK=$RUN;
    # survivors are stopped at the end (and on any exit of this script).
    run_pids() {
        local p
        for p in /proc/[0-9]*; do
            [[ -O $p ]] || continue
            if tr '\0' '\n' 2>/dev/null <"$p/environ" | grep -qxF "SHOTS_RUN_MARK=$RUN"; then
                echo "${p#/proc/}"
            fi
        done
    }
    reap() {
        local pids sig
        for sig in TERM KILL; do
            for _ in $(seq 30); do
                pids=$(run_pids)
                [[ -z $pids ]] && return 0
                sleep 0.1
            done
            echo "stopping leftover processes (SIG$sig): $(echo $pids)"
            # shellcheck disable=SC2086
            kill -s "$sig" $pids 2>/dev/null || true
        done
    }
    SYSTEM_BUS_PID=''
    outer_cleanup() {
        [[ -n $SYSTEM_BUS_PID ]] && kill "$SYSTEM_BUS_PID" 2>/dev/null || true
        reap
        rm -rf "$RT"
    }
    trap outer_cleanup EXIT

    SHOTS_RUN_MARK=$RUN dbus-daemon --config-file="$RUN/dbus/system.conf" --nofork --nopidfile \
        2>>"$RUN/session.log" &
    SYSTEM_BUS_PID=$!
    for _ in $(seq 50); do
        [[ -S $SYSTEM_SOCK ]] && break
        sleep 0.1
    done
    if [[ ! -S $SYSTEM_SOCK ]]; then
        echo "private system bus failed to start (see $RUN/session.log)" >&2
        exit 1
    fi

    HOST_DCONF=$HOME/.config/dconf/user
    host_mtime() { stat -c '%.9Y' "$HOST_DCONF" 2>/dev/null || echo missing; }
    BEFORE=$(host_mtime)

    status=0
    # The inner stage has its own limit; this one is the backstop.
    timeout --kill-after=10 $((TIMEOUT + 30)) env -i \
        DBUS_SYSTEM_BUS_ADDRESS="unix:path=$SYSTEM_SOCK" \
        HOME="$RUN/home" USER="${USER:-}" LOGNAME="${LOGNAME:-}" \
        PATH="/usr/local/bin:/usr/bin:/bin" LANG=C.UTF-8 TZ="${SHOTS_TZ:-America/New_York}" \
        XDG_CONFIG_HOME="$RUN/config" XDG_DATA_HOME="$RUN/data" \
        XDG_CACHE_HOME="$RUN/cache" XDG_STATE_HOME="$RUN/state" \
        XDG_RUNTIME_DIR="$RT" XDG_SESSION_TYPE=wayland \
        XDG_DATA_DIRS="/usr/local/share:/usr/share" \
        NO_AT_BRIDGE=1 GTK_A11Y=none GSK_RENDERER=cairo \
        SHOTS_INNER=1 SHOTS_RUN_MARK="$RUN" SHOTS_RUN="$RUN" SHOTS_REPO="$REPO" SHOTS_OUT="$OUT" \
        SHOTS_DEADLINE=$((START + TIMEOUT)) \
        SHOTS_ANIMATIONS="${SHOTS_ANIMATIONS:-}" SHOTS_VARIANTS="${SHOTS_VARIANTS:-}" \
        dbus-run-session --config-file="$RUN/dbus/session.conf" \
        -- "$REPO/scripts/shots.sh" "$@" \
        2>>"$RUN/session.log" || status=$?
    [[ $status == 124 || $status == 137 ]] && echo "TIMEOUT: the run exceeded ${TIMEOUT}s" >&2
    outer_cleanup
    trap - EXIT

    AFTER=$(host_mtime)
    echo "host dconf mtime before: $BEFORE"
    echo "host dconf mtime after:  $AFTER"
    if [[ $BEFORE != "$AFTER" ]]; then
        echo "ISOLATION CHECK FAILED: the host dconf database ($HOST_DCONF) changed during the run." >&2
        echo "  Note: the host's own gsd-color writes org.gnome.settings-daemon.plugins.color" >&2
        echo "  night-light-last-coordinates by itself now and then; if 'dconf dump /' on the host" >&2
        echo "  shows only that key changed, it was not this run. Re-run to confirm." >&2
        status=1
    fi
    if [[ $status == 0 && -z ${SHOTS_KEEP:-} ]]; then
        rm -rf "$RUN"
        rmdir "$REPO/.shots" 2>/dev/null || true
        echo "wall time: $(( $(date +%s) - START )) s (run dir removed; SHOTS_KEEP=1 keeps it)"
    else
        echo "wall time: $(( $(date +%s) - START )) s; run dir (logs): $RUN"
    fi
    exit "$status"
fi

# ---- inner stage: inside the private dbus-run-session.
RUN=$SHOTS_RUN
LOG=$RUN/gnome-shell.log
DISPLAY_NAME=wl-$$  # short: $XDG_RUNTIME_DIR/<name> must fit sun_path

# Private dconf (this bus, $XDG_CONFIG_HOME/dconf). Helper first: disabling
# an extension restarts every one enabled after it.
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell enabled-extensions "['$HELPER', '$UUID']"
gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
gsettings set org.gnome.desktop.session idle-delay 0
gsettings set org.gnome.desktop.screensaver lock-enabled false
gsettings set org.gnome.desktop.interface enable-hot-corners false
gsettings set org.gnome.desktop.interface clock-format '12h'
gsettings set org.gnome.desktop.interface color-scheme 'prefer-dark'
if [[ ${SHOTS_ANIMATIONS:-} == 1 ]]; then
    gsettings set org.gnome.desktop.interface enable-animations true
else
    gsettings set org.gnome.desktop.interface enable-animations false
fi

SHELL_PID='' FAKES_PID=''
stop_pid() {
    [[ -n $1 ]] || return 0
    kill -TERM "$1" 2>/dev/null || true
    for _ in $(seq 50); do
        kill -0 "$1" 2>/dev/null || break
        sleep 0.1
    done
    kill -KILL "$1" 2>/dev/null || true
    wait "$1" 2>/dev/null || true
}
cleanup() {
    stop_pid "$SHELL_PID"
    stop_pid "$FAKES_PID"
}
trap cleanup EXIT

gjs -m "$SHOTS_REPO/tests/shots/fakes.js" "$XDG_RUNTIME_DIR" "$RUN/ports.json" >"$RUN/fakes.log" 2>&1 &
FAKES_PID=$!

# A hung shell gets SIGABRT from the driver (JS stack in the log): no core.
ulimit -c 0
gnome-shell --headless --wayland --no-x11 --virtual-monitor 1280x800 \
    --wayland-display "$DISPLAY_NAME" >"$LOG" 2>&1 &
SHELL_PID=$!
echo "gnome-shell pid $SHELL_PID, fakes pid $FAKES_PID, log $LOG"

for _ in $(seq 50); do
    [[ -s $RUN/ports.json ]] && break
    sleep 0.1
done
if [[ ! -s $RUN/ports.json ]]; then
    echo "fakes failed to start:"
    cat "$RUN/fakes.log"
    exit 1
fi

status=0
remaining=$((SHOTS_DEADLINE - $(date +%s)))
(( remaining < 5 )) && remaining=5
SHOTS_SHELL_PID=$SHELL_PID timeout --kill-after=10 "$remaining" \
    gjs -m "$SHOTS_REPO/tests/shots/driver.js" "$RUN/ports.json" "$SHOTS_OUT" "$@" 2>&1 \
    || status=$?
[[ $status == 124 || $status == 137 ]] && echo "TIMEOUT: the driver was stopped after ${remaining}s"

if ! kill -0 "$SHELL_PID" 2>/dev/null; then
    echo "gnome-shell exited during the run; log tail:"
    tail -n 30 "$LOG"
    status=1
fi
cleanup
trap - EXIT

# Errors from the extension or the helper fail the run.
BAD_RE='JS ERROR|Extension (whatdidido|wdishots)@wporter\.org:|Could not load extension|Gjs-CRITICAL|wdishots.*(CRITICAL|WARNING)'
if grep -En "$BAD_RE" "$LOG" >"$RUN/log-errors.txt"; then
    echo "FAIL: errors in the shell log ($LOG):"
    head -n 30 "$RUN/log-errors.txt"
    status=1
fi
[[ -s $RUN/opened-urls.txt ]] && echo "URLs opened by the menu: $(tr '\n' ' ' <"$RUN/opened-urls.txt")"
exit "$status"
