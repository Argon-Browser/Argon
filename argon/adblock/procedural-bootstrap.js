// SPDX-License-Identifier: GPL-3.0-or-later
// Template: scripts/build-ublock-cosmetics.py inserts the unmodified upstream
// interpreter into this content-principal closure. No privileged objects enter.
(function installArgonCosmetics(selectors, prefix) {
    'use strict';
    let timer = 0, stopped = false, counter = 0, filterer;
    const commit = () => {
        if (timer || stopped) return;
        timer = setTimeout(() => { timer = 0; filterer.commitNow(); }, 50);
    };
    const vAPI = {
        randomToken: () => prefix + (++counter),
        hideStyle: 'display: none !important;',
        domFilterer: { commit, addCSS: () => {}, hasListeners: () => false },
    };
    /* UBO_SOURCE */
    filterer = new vAPI.DOMProceduralFilterer(vAPI.domFilterer);
    vAPI.domFilterer.proceduralFilterer = filterer;
    filterer.addProceduralSelectors(selectors);
    const observer = new MutationObserver(records => {
        // Ignore our own marker writes; otherwise hiding a node schedules an
        // unbounded loop. Other attributes/text changes must re-evaluate rules.
        if (records.some(r => r.type !== 'attributes' || !r.attributeName.startsWith(prefix))) commit();
    });
    const observe = () => observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    observe();
    addEventListener('pagehide', () => { stopped = true; observer.disconnect(); clearTimeout(timer); timer = 0; });
    addEventListener('pageshow', () => { stopped = false; observe(); commit(); });
    return true;
})
