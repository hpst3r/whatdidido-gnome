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
	gjs -m tests/window_model_test.js
	gjs -m tests/client_test.js $(TEST_RUNTIME)

# Read-only check against the running server (control.json in $XDG_RUNTIME_DIR).
live:
	gjs -m tests/live_client.js $(RUNTIME)

check: test
	for f in $(SRC)/*.js $(SRC)/lib/*.js tests/*.js; do node --input-type=module --check < $$f || exit 1; done
	glib-compile-schemas --strict --dry-run $(SRC)/schemas

pack: check
	mkdir -p build  # gnome-extensions pack segfaults if -o dir is missing
	cd $(SRC) && gnome-extensions pack --force --extra-source=lib --schema=schemas/$(SCHEMA) -o ../build .

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
