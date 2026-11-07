# SPDX-License-Identifier: MPL-2.0
# Argon application identity for the build system.
#
# Read by configure when config/mozconfig selects this branding directory. The
# rest of the identity (binary name, profile, remoting name, vendor) lives in
# config/mozconfig and config/overlay.json. A front-end-only artifact build
# reuses Mozilla's binaries and does not pick these values up.

MOZ_APP_DISPLAYNAME=Argon
