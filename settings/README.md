# Argon Settings (LibreWolf Base)

This directory contains the hardened default configuration inherited from LibreWolf and customized for **Argon Browser** on Linux (Flatpak):

- `librewolf.cfg`: Hardened runtime defaults for privacy, fingerprinting resistance, networking, and Linux Flatpak desktop portal integration.
- `defaults/pref/local-settings.js`: Loads `librewolf.cfg` at startup.
- `distribution/policies.json`: Enterprise policy configuration disabling telemetry, studies, Firefox Accounts by default, Pocket, and background app updates.
