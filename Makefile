# Kit (Photo, Film, Vector, Effect, Design, CAD, Slide, Word, Sheet, PDF) shortcuts for building, trying, and testing the kits.
# See docs/kit-sdk.md. Kit repositories are sibling checkouts (../kition-photo,
# ../kition-film, ../kition-vector, ../kition-effect, ../kition-design, ../kition-cad, ../kition-slide, ../kition-word, ../kition-sheet, ../kition-pdf); set KIT_<KIT>_REPO, for example KIT_FILM_REPO,
# to use other paths.
#
#   make kit-dev      build what is missing, then run Kition with the kits
#   make kit-test     contract checks and the kit e2e specs
#   make kit-uis      rebuild every kit's package (its editor and its engine)

SHELL := /bin/bash
REPO_ROOT := $(shell git rev-parse --show-toplevel)
KIT_PHOTO_REPO ?= $(REPO_ROOT)/../kition-photo
KIT_FILM_REPO ?= $(REPO_ROOT)/../kition-film
KIT_VECTOR_REPO ?= $(REPO_ROOT)/../kition-vector
KIT_EFFECT_REPO ?= $(REPO_ROOT)/../kition-effect
KIT_DESIGN_REPO ?= $(REPO_ROOT)/../kition-design
KIT_CAD_REPO ?= $(REPO_ROOT)/../kition-cad
KIT_SLIDE_REPO ?= $(REPO_ROOT)/../kition-slide
KIT_WORD_REPO ?= $(REPO_ROOT)/../kition-word
KIT_SHEET_REPO ?= $(REPO_ROOT)/../kition-sheet
KIT_PDF_REPO ?= $(REPO_ROOT)/../kition-pdf
# Each kit's package (its own editor and its engine, Kit UI protocol), built into public/kits/<kit>-ui.
KIT_UIS := photo film vector effect design cad slide word sheet pdf

# The kits need a newer Rust than some system installs; prefer rustup's stable toolchain.
STABLE_BIN := $(patsubst %/,%,$(dir $(shell rustup which --toolchain stable cargo 2>/dev/null)))
TOOLCHAIN_PATH := $(if $(STABLE_BIN),$(STABLE_BIN):,)$(PATH)
# The e2e web server is probed through any HTTP proxy; run without one.
NO_PROXY_ENV := env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy
E2E_PORT ?= 3123
KIT_E2E := e2e/slide-embedded.spec.ts e2e/word-embedded.spec.ts e2e/sheet-embedded.spec.ts e2e/pdf-embedded.spec.ts e2e/cad-embedded.spec.ts e2e/vector-embedded.spec.ts e2e/design-embedded.spec.ts e2e/photo-embedded.spec.ts e2e/effect-embedded.spec.ts e2e/film-embedded.spec.ts e2e/kit-bridge.spec.ts e2e/kit-create.spec.ts e2e/kdm-smoke.spec.ts
PHOTO_BINARY := $(KIT_PHOTO_REPO)/target/debug/kit-photo
# The SDK kits' headless executables for the agent (kit-film, kit-vector, ...), from kition-headless.
SDK_KITS := film vector effect design cad slide word sheet pdf
kit_binary = $(KIT_$(shell echo $(1) | tr a-z A-Z)_REPO)/target/debug/kit-$(1)
SDK_BINARIES := $(foreach kit,$(SDK_KITS),$(call kit_binary,$(kit)))
# Points the runtime at every kit executable (KITION_KIT_<KIT>_BINARY).
KIT_BINARY_ENV := KITION_KIT_PHOTO_BINARY="$(PHOTO_BINARY)" $(foreach kit,$(SDK_KITS),KITION_KIT_$(shell echo $(kit) | tr a-z A-Z)_BINARY="$(call kit_binary,$(kit))")

.PHONY: help kit-e2e-webkit kit-dev kit-fetch kit-uis $(addprefix kit-ui-,$(KIT_UIS)) kit-photo-binary kit-binaries kit-check kit-test kit-e2e kit-e2e-headed kit-clean

help:
	@echo "make kit-dev         build missing kit engines and kit executables, then run Kition (pnpm dev)"
	@echo "make kit-test        kit contract checks, then the kit e2e specs"
	@echo "make kit-e2e-headed  the kit e2e specs in a visible browser"
	@echo "make kit-e2e-webkit  the in-page kit specs in WebKit, the desktop app's engine"
	@echo "make kit-uis         rebuild every kit's package, its editor and engine (public/kits/<kit>-ui); one: make kit-ui-slide"
	@echo "make kit-fetch       download the kit packages pinned in kits/kits.lock.json into public/kits"
	@echo "make kit-check       contract checks of the built kit engines only"
	@echo "make kit-binaries    build every kit's headless executable for the agent"
	@echo "make kit-clean       remove the built kit packages"

# A kit's package, only when it is missing; `make kit-uis` always rebuilds.
public/kits/%-ui/kit-ui.json:
	@PATH="$(TOOLCHAIN_PATH)" KIT_REPO="$(KIT_$(shell echo $* | tr a-z A-Z)_REPO)" scripts/build-kit-ui.sh $*

$(addprefix kit-ui-,$(KIT_UIS)): kit-ui-%:
	@rm -f public/kits/$*-ui/kit-ui.json
	@$(MAKE) --no-print-directory public/kits/$*-ui/kit-ui.json

kit-uis: $(addprefix kit-ui-,$(KIT_UIS))

# The published packages instead of local builds (scripts/publish-kit.sh publishes them).
kit-fetch:
	node scripts/fetch-kits.mjs

# The headless Photo kit the agent uses (photo_inspect, photo_commands, photo_run; each kit's
# tools are <prefix>_inspect, _commands, and _run).
$(PHOTO_BINARY):
	@cd "$(KIT_PHOTO_REPO)" && PATH="$(TOOLCHAIN_PATH)" cargo build -p kit-photo

kit-photo-binary: $(PHOTO_BINARY)

# kit-film, kit-vector, kit-effect, kit-design, kit-cad, kit-slide, kit-word, kit-sheet, kit-pdf: the kit's own document over the Kit Protocol.
$(SDK_BINARIES):
	@cd "$(abspath $(dir $@)/../..)" && PATH="$(TOOLCHAIN_PATH)" cargo build -p $(notdir $@)

kit-binaries: $(PHOTO_BINARY) $(SDK_BINARIES)

kit-dev: $(addprefix public/kits/,$(addsuffix -ui/kit-ui.json,$(KIT_UIS))) $(PHOTO_BINARY) $(SDK_BINARIES)
	@echo "Kition with Photo, Film, Vector, Effect, Design, CAD, Slide, Word, Sheet, and PDF: open a .psd, .kitionfilm, .kitionvector, .kitioneffect, .kitiondesign, .dxf, .kitionslide, .pptx, .docx, .xlsx, or .pdf, or use the New menu."
	$(NO_PROXY_ENV) $(KIT_BINARY_ENV) pnpm dev

kit-check: $(addprefix public/kits/,$(addsuffix -ui/kit-ui.json,$(KIT_UIS)))
	pnpm check:kit-sdks

kit-e2e: $(addprefix public/kits/,$(addsuffix -ui/kit-ui.json,$(KIT_UIS)))
	$(NO_PROXY_ENV) KITION_E2E_PORT=$(E2E_PORT) pnpm exec playwright test --config tooling/playwright.config.ts $(KIT_E2E) --reporter=line

kit-e2e-headed: $(addprefix public/kits/,$(addsuffix -ui/kit-ui.json,$(KIT_UIS)))
	$(NO_PROXY_ENV) KITION_E2E_PORT=$(E2E_PORT) pnpm exec playwright test --config tooling/playwright.config.ts $(KIT_E2E) --headed --workers=1

# WebKit is what the desktop app runs (WKWebView); `playwright install webkit` once.
kit-e2e-webkit: $(addprefix public/kits/,$(addsuffix -ui/kit-ui.json,$(KIT_UIS)))
	$(NO_PROXY_ENV) KITION_E2E_PORT=$(E2E_PORT) pnpm exec playwright test --config tooling/playwright.webkit.config.ts $(KIT_E2E) --reporter=line

kit-test: kit-check kit-e2e

kit-clean:
	rm -rf $(addprefix public/kits/,$(addsuffix -ui,$(KIT_UIS)))
