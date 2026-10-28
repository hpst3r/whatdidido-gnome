UUID   := whatdidido@wporter.org
SCHEMA := org.gnome.shell.extensions.whatdidido.gschema.xml
SRC    := $(UUID)
DEST   := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
# Stand-in for $XDG_RUNTIME_DIR in client tests (holds the fake control.json).
TEST_RUNTIME ?= $(CURDIR)/build/test-runtime

.PHONY: test live check pack install uninstall nested

# Unit tests (pure models) + client tests against a loopback fake control API.
test:
	gjs -m tests/model_test.js
	gjs -m tests/mic_model_test.js
	gjs -m tests/mic_review_forget_test.js
	gjs -m tests/mic_review_indicator_test.js
	gjs -m tests/pause_reminder_test.js
	gjs -m tests/mic_reminder_test.js
	gjs -m tests/window_model_test.js
	gjs -m tests/window_retry_test.js
	gjs -m tests/window_stale_dedupe_test.js
	gjs -m tests/window_disable_none_test.js
	gjs -m tests/window_log_once_test.js
	gjs -m tests/window_geometry_test.js
	gjs -m tests/window_paused_test.js
	gjs -m tests/window_burst_test.js
	gjs -m tests/window_title_rules_test.js
	gjs -m tests/window_digit_filter_test.js
	gjs -m tests/window_tracker_test.js
	mkdir -p $(TEST_RUNTIME)/schemas
	glib-compile-schemas --strict --targetdir=$(TEST_RUNTIME)/schemas $(SRC)/schemas
	gjs -m tests/window_tracker_settings_test.js $(TEST_RUNTIME)/schemas
	gjs -m tests/client_test.js $(TEST_RUNTIME)
	gjs -m tests/window_body_size_test.js $(TEST_RUNTIME)/body-size
	gjs -m tests/window_geometry_client_test.js $(TEST_RUNTIME)/geometry
	gjs -m tests/mic_scenarios_test.js $(TEST_RUNTIME)/mic-scenarios
	gjs -m tests/mic_review_toggle_race_test.js $(TEST_RUNTIME)/mic-toggle-race
	gjs -m tests/day_model_test.js
	gjs -m tests/popover_model_test.js
	gjs -m tests/app_client_test.js $(TEST_RUNTIME)/app-client
	gjs -m tests/app_redirect_test.js
	gjs -m tests/shots/fakes_test.js $(TEST_RUNTIME)/shots-fakes

# Read-only check against the running server (control.json in $XDG_RUNTIME_DIR).
live:
	gjs -m tests/live_client.js $(RUNTIME)

check: test
	for f in $(SRC)/*.js $(SRC)/lib/*.js tests/*.js; do node --input-type=module --check < $$f || exit 1; done
	glib-compile-schemas --strict --dry-run $(SRC)/schemas

pack: check
	mkdir -p build  # gnome-extensions pack segfaults if -o dir is missing
	cd $(SRC) && gnome-extensions pack --force --extra-source=lib --extra-source=icons --schema=schemas/$(SCHEMA) -o ../build .

# Symlink install for development. GNOME Shell on Wayland only picks up a new
# extension after re-login (or use `make nested`).
install:
	mkdir -p $(dir $(DEST))
	glib-compile-schemas $(SRC)/schemas
	ln -sfn $(CURDIR)/$(SRC) $(DEST)
	@echo "Installed -> $(DEST). Log out/in, then: gnome-extensions enable $(UUID)"

uninstall:
	-gnome-extensions disable $(UUID)
	rm -f $(DEST)

# Nested test shell in a window, extension pre-enabled, isolated dconf db so
# the real session is untouched. GNOME 49+ needs mutter-devkit. NESTED_SIZE=WxH.
nested: install
	scripts/nested.sh

# Screenshots of the menu in an isolated headless shell (scripts/shots.sh,
# tests/shots/README.md): build/shots/<scenario>-<dark|light>.png.
# SCENARIOS="a b" picks some.
.PHONY: shots
shots:
	scripts/shots.sh $(SCENARIOS)
