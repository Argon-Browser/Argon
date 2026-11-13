# Argon Workspaces

Status: implemented and verified in the packaged browser. The isolation model
below is covered by `tests/workspaces/workspaces.test.mjs` (unit) and
`tests/browser/test_workspaces.py` (real browser, real containers).

## What a workspace is

A workspace is a named set of tabs that shares one Firefox container. The
container is the storage principal, so a workspace keeps its own cookies,
`localStorage`, IndexedDB, cache, and service workers. General is the only
workspace without a container: it uses the default storage of the profile.

| Workspace | Container | Storage |
| :-- | :-- | :-- |
| General | default (user context 0) | profile default storage |
| Work | `Argon: Work` | container storage |
| Personal | `Argon: Personal` | container storage |

The mapping between workspace ids and container ids lives in the
`argon.workspaces.containers` preference (a JSON object). The container
identities themselves are ordinary Firefox containers named `Argon: <name>`,
so the browser can clean them up like any other container.

## Rules the browser enforces

- **The container is assigned before the first request.** Argon wraps
  `gBrowser.addTab`, so a tab is created with its user context instead of
  being moved into a container afterwards. A tab that is opened, restored from
  the session store, duplicated, or opened from a link therefore loads with
  the right storage from the very first byte.
- **Restored tabs keep their container.** Gecko restores session tabs with the
  container as a string; Argon normalizes that value, so a tab reopens in the
  workspace it was saved in.
- **Moving a tab reloads it in the destination.** `assignTabToWorkspace()`
  opens the same address in the destination container and closes the original
  tab. Form state, scroll position, and the previous session are not
  transferred, and the browser keeps its normal `beforeunload` handling, so a
  cancelled close leaves the tab where it was.
- **Pinned tabs belong to their workspace.** A pinned tab is hidden while
  another workspace is active and returns with its workspace.
- **Private windows stay separate.** A private window reuses the containers of
  the profile, but Firefox keeps private cookie jars and ephemeral storage
  apart, so a private workspace never sees the normal session of the same
  container.
- **The window survives the last tab.** Firefox closes a window when its last
  visible tab goes away and ignores the hidden tabs of the other workspaces.
  Argon switches to a workspace that still holds tabs before the close, so the
  other workspaces are not thrown away.
- **A workspace with open tabs cannot be deleted.** The guard covers every
  browser window, including private ones. Deleting a workspace also deletes
  its container and the data inside it.

## Preferences

| Preference | Meaning |
| :-- | :-- |
| `argon.workspaces.enabled` | Master switch for the workspace layer |
| `argon.workspaces.active` | Active workspace, shared by every window |
| `argon.workspaces.list` | Ordered workspace list with id, name, and color |
| `argon.workspaces.containers` | Workspace id to container id mapping |
| `argon.tabs.autoUnload` | Unload the tabs of the inactive workspaces |

## Limits

- The active workspace is a single profile-wide preference, so every window
  follows the same workspace.
- A tab can only be moved when its address can be loaded again: `http`,
  `https`, `about:blank`, and `about:newtab`. Internal pages such as
  `about:preferences` are refused instead of being reopened somewhere else.
- Argon does not sync containers or workspaces between profiles.
