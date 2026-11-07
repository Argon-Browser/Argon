#!/bin/sh
# SPDX-License-Identifier: MPL-2.0
# Flatpak launch wrapper for Argon Browser (org.argon.browser).

set -eu

if [ -n "${WAYLAND_DISPLAY:-}" ] && [ "${MOZ_ENABLE_WAYLAND:-}" != "0" ]; then
  export MOZ_ENABLE_WAYLAND=1
fi

export GTK_USE_PORTAL="${GTK_USE_PORTAL:-1}"
export MOZ_APP_REMOTINGNAME="${MOZ_APP_REMOTINGNAME:-argon}"

exec /app/lib/argon/argon "$@"
