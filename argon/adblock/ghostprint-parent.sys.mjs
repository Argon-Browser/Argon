// SPDX-License-Identifier: MPL-2.0
// No content-to-parent mutation/configuration channel.
const ActorParentBase = typeof JSWindowActorParent !== 'undefined' ? JSWindowActorParent : class {};
export class ArgonGhostPrintParent extends ActorParentBase {}
