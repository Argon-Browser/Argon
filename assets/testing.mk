# Testing Makefile targets for Argon Browser (Linux only)

test_firefox_artifacts : check
	@echo "-> Attempting to obtain stage2 Linux build artifacts from taskcluster..."
	rm -f target.crashreporter-symbols.zip target.tar.xz
	./scripts/fetch-build.sh linux x86_64
	ls -la target.crashreporter-symbols.zip target.tar.xz

full_build_stage2_linux : dir
	cp -v assets/mozconfig.new $(argon_source_dir)/mozconfig
	echo "ac_add_options --enable-artifact-builds" >> $(argon_source_dir)/mozconfig
	echo "export MOZ_FETCHES_DIR=$(shell pwd)" >> $(argon_source_dir)/mozconfig
	echo "ac_add_options --with-UNOFFICIAL-branding=browser/branding/argon" >> $(argon_source_dir)/mozconfig
	python3 scripts/librewolf-patches.py $(version) $(release) --no-mozconfig
	(cd $(argon_source_dir) && ./mach --no-interactive bootstrap --application-choice="Firefox for Desktop Artifact Mode")
	(cd $(argon_source_dir) && ./mach configure)
	(cd $(argon_source_dir) && ./mach build)
	(cd $(argon_source_dir) && ./mach package)

test-linux : test_firefox_artifacts full_build_stage2_linux
