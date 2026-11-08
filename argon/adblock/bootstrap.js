// SPDX-License-Identifier: MPL-2.0
// Classic window hook: install the process-global request observer before tab startup.
ChromeUtils.importESModule('chrome://browser/content/argon/adblock/service.sys.mjs').ArgonAdblock.start();
