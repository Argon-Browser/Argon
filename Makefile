# Argon Browser Makefile (LibreWolf fork base — Linux Flatpak only)

version := $(shell cat version)
release := $(shell cat release)
ff_source_dir=firefox-$(version)
ff_source_tarball=firefox-$(version).source.tar.xz
argon_source_dir=argon-$(version)-$(release)
argon_source_tarball=argon-$(version)-$(release).source.tar.gz

default: help

help:
	@printf "Argon Browser (LibreWolf fork) — Linux Flatpak build targets:\n"
	@printf "  all        : prepare patched Argon source tree (check + dir + patches)\n"
	@printf "  dir        : extract Firefox $(version) into $(argon_source_dir)\n"
	@printf "  patches    : apply LibreWolf & Argon patches, branding, and overlay\n"
	@printf "  build      : compile Argon inside $(argon_source_dir)\n"
	@printf "  package    : package Argon build inside $(argon_source_dir)\n"
	@printf "  flatpak    : build the single-file Flatpak bundle (org.argon.browser)\n"
	@printf "  run        : run compiled Argon binary\n"
	@printf "  clean      : remove $(argon_source_dir)\n"
	@printf "  distclean  : remove $(argon_source_dir) and downloaded source archives\n"

all: check dir patches

check:
	@which wget > /dev/null
	@which tar > /dev/null
	@which unzip > /dev/null
	@which python3 > /dev/null

# We never overwrite version and release manually anymore, they get updated through CI.
update:
	@echo "We currently read version=$(version) release=$(release)"

$(ff_source_tarball) : version
	wget -O $(ff_source_tarball) https://archive.mozilla.org/pub/firefox/releases/$(version)/source/$(ff_source_tarball)

# Create initial directory structure before patches.
dir: $(ff_source_tarball)
	rm -rf $(argon_source_dir) $(ff_source_dir)
	tar xf $(ff_source_tarball)
	mv $(ff_source_dir) $(argon_source_dir)

patches:
	python3 scripts/librewolf-patches.py $(version) $(release)

run:
	(cd $(argon_source_dir) && ./mach run)

build:
	(cd $(argon_source_dir) && ./mach build)

package:
	(cd $(argon_source_dir) && ./mach package)

flatpak:
	python3 scripts/argon.py flatpak

src-tarball: all
	tar czf $(argon_source_tarball) $(argon_source_dir)
	sha256sum $(argon_source_tarball) > $(argon_source_tarball).sha256sum
	cat $(argon_source_tarball).sha256sum

clean:
	rm -rf $(argon_source_dir)

distclean: clean
	rm -rf $(ff_source_dir) $(ff_source_tarball) $(argon_source_tarball) $(argon_source_tarball).sha256sum

check-patchfail: dir
	./scripts/check-patchfail.sh $(argon_source_dir)

setup-wasi:
	./scripts/setup-wasi-linux.sh

fetch-uBO:
	python3 scripts/generate-ubo-assets.py

include assets/testing.mk
