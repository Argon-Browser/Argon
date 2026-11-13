# Native extension runtime benchmark

Run the signed AMO package smoke suite against an isolated packaged Argon:

```sh
python3 scripts/dev-browser.py --sync-only
.cache/browser-venv/bin/python scripts/benchmark-extensions.py --ids darkreader styl-us cookie-editor
```

The runner requires `tests/browser/requirements.txt`. Each extension receives a
fresh temporary profile. It downloads the version returned by the official AMO
API, checks the published SHA-256, and installs the unmodified package through
Gecko's AddonManager. It does not disable signing or use temporary installation.
Packages and profiles are removed after each case.

Evidence in `artifacts/extension-benchmark/results.json` records package URL,
version, hash, application build, installation state, restart state and errors.
The Dark Reader case also requires an injected stylesheet and an observable
background-color change on a local HTTP fixture.

`SMOKE_PASSED` proves only the checks listed in that result. In particular:

- Native Firefox package results do not establish Chromium Bridge compatibility.
- Installation and restart do not prove the extension's main features work.
- Accounts, permissions UI, updates, private browsing and real-site behavior
  require additional cases.
- The 50-extension registry's compatibility statuses remain `NOT_TESTED` until
  feature-level acceptance criteria have been exercised. Smoke evidence is
  recorded separately and does not count toward the 80% compatibility target.

Next steps: exercise popup/editor controls, permission revocation and uninstall
behavior, and expand coverage across the six registry categories. Keep native and adapted-package results separate.

## Initial measured run

See [recorded evidence](extension-benchmark-results.json). All three native AMO
packages installed as active and remained active after an Argon restart:

- Dark Reader 4.9.135: also changed the fixture background from white to
  `rgb(24, 26, 27)` with a Dark Reader stylesheet present.
- Stylus: installation and restart only; user-style application is not tested.
- Cookie-Editor: installation and restart only; cookie editing is not tested.

These results were obtained in the isolated development runtime (Argon
162.0a1, build 20261106160444), not in a release Flatpak. They must not be
presented as three fully compatible extensions or as evidence for Chrome CRX
compatibility.

## Stylus and Cookie-Editor functional run

[Functional evidence](extension-functional-results.json) records a subsequent
run with the same signed package versions. Reproduce it with:

```sh
.cache/browser-venv/bin/python scripts/benchmark-extensions.py --ids styl-us cookie-editor --output artifacts/extension-functional
```

Stylus 2.4.17 passed these checks:

- Saved an enabled, exact-URL style through its own background `styles.editSave`
  message handler from the extension's management page.
- Changed the fixture's computed background from white to `rgb(12, 34, 56)`.
- Left a different URL outside the style's scope white.
- Restored the fixture to white after its `styles.toggle` handler disabled the style.
- Remained installed and active after restart.

Cookie-Editor 1.13.0 passed these checks:

- Read a cookie created by the fixture page through its packaged
  `GenericCookieHandler.getAllCookies` implementation.
- Changed that cookie from `before` to `after` through its packaged
  `GenericCookieHandler.saveCookie` implementation and real browser cookies API.
- Exposed the new value to `document.cookie` after navigating back to the page.
- Preserved a second cookie with the value `unchanged`.
- Remained installed and active after restart.

These probes run extension-owned code in extension pages. They do not substitute
browser cookie writes or direct page CSS injection for the tested operations.
They also do not click the extensions' popup/editor UI, validate private/container
cookie stores, or verify functional state after restart. Full compatibility and
Chromium Bridge compatibility remain unassessed.
