# Kit (Photo, Film, Vector, Effect, Design) shortcuts for trying and testing the in-page kit editors.
# See docs/kit-sdk.md. Kit repositories are sibling checkouts (../kit-photo,
# ../kit-film, ../kit-vector, ../kit-effect, ../kit-design); set KIT_<KIT>_REPO, for example KIT_FILM_REPO,
# to use other paths.
#
#   make kit-dev      build what is missing, then run Kition with the kits
#   make kit-test     contract checks and the kit e2e specs
#   make kit-sdks     rebuild every kit engine to WebAssembly

SHELL := /bin/bash
REPO_ROOT := $(shell git rev-parse --show-toplevel)
KIT_PHOTO_REPO ?= $(REPO_ROOT)/../kit-photo
KIT_FILM_REPO ?= $(REPO_ROOT)/../kit-film
KIT_VECTOR_REPO ?= $(REPO_ROOT)/../kit-vector
KIT_EFFECT_REPO ?= $(REPO_ROOT)/../kit-effect
KIT_DESIGN_REPO ?= $(REPO_ROOT)/../kit-design
KITS := photo film vector effect design

# The kits need a newer Rust than some system installs; prefer rustup's stable toolchain.
STABLE_BIN := $(patsubst %/,%,$(dir $(shell rustup which --toolchain stable cargo 2>/dev/null)))
TOOLCHAIN_PATH := $(if $(STABLE_BIN),$(STABLE_BIN):,)$(PATH)
# The e2e web server is probed through any HTTP proxy; run without one.
NO_PROXY_ENV := env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy
E2E_PORT ?= 3123
WEB_KIT_E2E := e2e/photo-web-editor.spec.ts e2e/film-web-editor.spec.ts e2e/vector-web-editor.spec.ts e2e/effect-web-editor.spec.ts e2e/design-web-editor.spec.ts e2e/kit-bridge.spec.ts
KIT_E2E := $(WEB_KIT_E2E) e2e/desktop-photo-kit.spec.ts
PHOTO_BINARY := $(KIT_PHOTO_REPO)/target/debug/kit-photo
# The SDK kits' headless executables for the agent (kit-film, kit-vector, ...), from kition-headless.
SDK_KITS := film vector effect design
kit_binary = $(KIT_$(shell echo $(1) | tr a-z A-Z)_REPO)/target/debug/kit-$(1)
SDK_BINARIES := $(foreach kit,$(SDK_KITS),$(call kit_binary,$(kit)))
# Points the runtime at every kit executable (KITION_KIT_<KIT>_BINARY).
KIT_BINARY_ENV := KITION_KIT_PHOTO_BINARY="$(PHOTO_BINARY)" $(foreach kit,$(SDK_KITS),KITION_KIT_$(shell echo $(kit) | tr a-z A-Z)_BINARY="$(call kit_binary,$(kit))")

.PHONY: help kit-e2e-webkit kit-dev kit-sdks $(addprefix kit-sdk-,$(KITS)) kit-photo-binary kit-binaries kit-check kit-test kit-e2e kit-e2e-headed kit-clean

help:
	@echo "make kit-dev         build missing kit engines and kit executables, then run Kition (pnpm dev)"
	@echo "make kit-test        kit contract checks, then the kit e2e specs"
	@echo "make kit-e2e-headed  the kit e2e specs in a visible browser"
	@echo "make kit-e2e-webkit  the in-page kit specs in WebKit, the desktop app's engine"
	@echo "make kit-sdks        rebuild every kit engine to WebAssembly (public/kits/<kit>-sdk)"
	@echo "make kit-sdk-photo   rebuild one kit engine (also kit-sdk-film, kit-sdk-vector, kit-sdk-effect, kit-sdk-design)"
	@echo "make kit-check       contract checks of the built kit engines only"
	@echo "make kit-binaries    build every kit's headless executable for the agent"
	@echo "make kit-clean       remove the built kit engines"

# Builds a kit's engine only when it is missing; `make kit-sdks` always rebuilds.
public/kits/%-sdk/.built:
	@PATH="$(TOOLCHAIN_PATH)" KIT_REPO="$(KIT_$(shell echo $* | tr a-z A-Z)_REPO)" scripts/build-kit-sdk.sh $*
	@touch $@

# A static pattern rule: plain pattern rules are skipped for .PHONY targets.
$(addprefix kit-sdk-,$(KITS)): kit-sdk-%:
	@rm -f public/kits/$*-sdk/.built
	@$(MAKE) --no-print-directory public/kits/$*-sdk/.built

kit-sdks: $(addprefix kit-sdk-,$(KITS))

# The headless Photo kit the agent uses (photo_inspect, photo_commands, photo_run; each kit's
# tools are <prefix>_inspect, _commands, and _run).
$(PHOTO_BINARY):
	@cd "$(KIT_PHOTO_REPO)" && PATH="$(TOOLCHAIN_PATH)" cargo build -p kit-photo

kit-photo-binary: $(PHOTO_BINARY)

# kit-film, kit-vector, kit-effect, kit-design: the kit's own document over the Kit Protocol.
$(SDK_BINARIES):
	@cd "$(abspath $(dir $@)/../..)" && PATH="$(TOOLCHAIN_PATH)" cargo build -p $(notdir $@)

kit-binaries: $(PHOTO_BINARY) $(SDK_BINARIES)

kit-dev: $(addprefix public/kits/,$(addsuffix -sdk/.built,$(KITS))) $(PHOTO_BINARY) $(SDK_BINARIES)
	@echo "Kition with Photo, Film, Vector, Effect, and Design: open a .psd, .fcproj, .vectorcraft, .ecproj, or .designcraft, or use the New menu."
	$(NO_PROXY_ENV) $(KIT_BINARY_ENV) pnpm dev

kit-check: $(addprefix public/kits/,$(addsuffix -sdk/.built,$(KITS)))
	pnpm check:kit-sdks

kit-e2e: $(addprefix public/kits/,$(addsuffix -sdk/.built,$(KITS)))
	$(NO_PROXY_ENV) KITION_E2E_PORT=$(E2E_PORT) pnpm exec playwright test --config tooling/playwright.config.ts $(KIT_E2E) --reporter=line

kit-e2e-headed: $(addprefix public/kits/,$(addsuffix -sdk/.built,$(KITS)))
	$(NO_PROXY_ENV) KITION_E2E_PORT=$(E2E_PORT) pnpm exec playwright test --config tooling/playwright.config.ts $(KIT_E2E) --headed --workers=1

# WebKit is what the desktop app runs (WKWebView); `playwright install webkit` once.
kit-e2e-webkit: $(addprefix public/kits/,$(addsuffix -sdk/.built,$(KITS)))
	$(NO_PROXY_ENV) KITION_E2E_PORT=$(E2E_PORT) pnpm exec playwright test --config tooling/playwright.webkit.config.ts $(WEB_KIT_E2E) --reporter=line

kit-test: kit-check kit-e2e

kit-clean:
	rm -rf $(addprefix public/kits/,$(addsuffix -sdk,$(KITS)))
