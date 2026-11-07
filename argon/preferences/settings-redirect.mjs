// SPDX-License-Identifier: MIT
import { settingsURL } from "./settings-routing.mjs";

// A compatibility entry point, not a second settings application. Replace the
// entry so Back never gets trapped on a redirect, and retain native query args.
const target = new URL(settingsURL(location.hash, { legacy: true }));
target.search = location.search;
location.replace(target.href);
