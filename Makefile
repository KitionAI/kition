# Kit (Photo, Film) shortcuts for trying and testing the in-page kit editors.
# See docs/kit-sdk.md. Kit repositories are sibling checkouts (../kit-photo,
# ../kit-film); set KIT_PHOTO_REPO or KIT_FILM_REPO to use other paths.
#
#   make kit-dev      build what is missing, then run Kition with both kits
#   make kit-test     contract checks and the kit e2e specs
#   make kit-sdks     rebuild both kit engines to WebAssembly

SHELL := /bin/bash
REPO_ROOT := $(shell git rev-parse --show-toplevel)
KIT_PHOTO_REPO ?= $(REPO_ROOT)/../kit-photo
KIT_FILM_REPO ?= $(REPO_ROOT)/../kit-film
KITS := photo film

# The kits need a newer Rust than some system installs; prefer rustup's stable toolchain.
STABLE_BIN := $(patsubst %/,%,$(dir $(shell rustup which --toolchain stable cargo 2>/dev/null)))
TOOLCHAIN_PATH := $(if $(STABLE_BIN),$(STABLE_BIN):,)$(PATH)
# The e2e web server is probed through any HTTP proxy; run without one.
NO_PROXY_ENV := env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy
E2E_PORT ?= 3123
KIT_E2E := e2e/photo-web-editor.spec.ts e2e/film-web-editor.spec.ts e2e/desktop-photo-kit.spec.ts
PHOTO_BINARY := $(KIT_PHOTO_REPO)/target/debug/kit-photo

.PHONY: help kit-e2e-webkit kit-dev kit-sdks kit-sdk-photo kit-sdk-film kit-photo-binary kit-check kit-test kit-e2e kit-e2e-headed kit-clean

help:
	@echo "make kit-dev         build missing kit engines and the Photo kit binary, then run Kition (pnpm dev)"
	@echo "make kit-test        kit contract checks, then the Photo and Film e2e specs"
	@echo "make kit-e2e-headed  the kit e2e specs in a visible browser"
	@echo "make kit-e2e-webkit  the in-page kit specs in WebKit, the desktop app's engine"
	@echo "make kit-sdks        rebuild both kit engines to WebAssembly (public/kits/<kit>-sdk)"
	@echo "make kit-sdk-photo   rebuild one kit engine (also kit-sdk-film)"
	@echo "make kit-check       contract checks of the built kit engines only"
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

# The headless Photo kit the agent uses (photo_inspect, photo_commands, photo_run).
$(PHOTO_BINARY):
	@cd "$(KIT_PHOTO_REPO)" && PATH="$(TOOLCHAIN_PATH)" cargo build -p kit-photo

kit-photo-binary: $(PHOTO_BINARY)

kit-dev: $(addprefix public/kits/,$(addsuffix -sdk/.built,$(KITS))) $(PHOTO_BINARY)
	@echo "Kition with Photo and Film: open a .psd or .fcproj, or New > Image / Video project."
	$(NO_PROXY_ENV) KITION_KIT_PHOTO_BINARY="$(PHOTO_BINARY)" pnpm dev

kit-check: $(addprefix public/kits/,$(addsuffix -sdk/.built,$(KITS)))
	pnpm check:kit-sdks

kit-e2e: $(addprefix public/kits/,$(addsuffix -sdk/.built,$(KITS)))
	$(NO_PROXY_ENV) KITION_E2E_PORT=$(E2E_PORT) pnpm exec playwright test --config tooling/playwright.config.ts $(KIT_E2E) --reporter=line

kit-e2e-headed: $(addprefix public/kits/,$(addsuffix -sdk/.built,$(KITS)))
	$(NO_PROXY_ENV) KITION_E2E_PORT=$(E2E_PORT) pnpm exec playwright test --config tooling/playwright.config.ts $(KIT_E2E) --headed --workers=1

# WebKit is what the desktop app runs (WKWebView); `playwright install webkit` once.
kit-e2e-webkit: $(addprefix public/kits/,$(addsuffix -sdk/.built,$(KITS)))
	$(NO_PROXY_ENV) KITION_E2E_PORT=$(E2E_PORT) pnpm exec playwright test --config tooling/playwright.webkit.config.ts e2e/photo-web-editor.spec.ts e2e/film-web-editor.spec.ts --reporter=line

kit-test: kit-check kit-e2e

kit-clean:
	rm -rf $(addprefix public/kits/,$(addsuffix -sdk,$(KITS)))
