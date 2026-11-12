// SPDX-License-Identifier: GPL-3.0-or-later
// Template: scripts/build-ublock-cosmetics.py inserts the unmodified upstream
// interpreter into this content-principal closure. No privileged objects enter.
(function installArgonCosmetics(selectors, prefix, options) {
    'use strict';
    const pageGlobal = typeof globalThis !== 'undefined' ? globalThis : window;
    const now = typeof performance === 'object' && typeof performance?.now === 'function'
        ? performance.now.bind(performance)
        : Date.now;
    const FRAME_BUDGET_MS = options && typeof options.frameBudgetMs === 'number' && options.frameBudgetMs > 0
        ? options.frameBudgetMs
        : 8;
    const hideCSS = options && typeof options.shadowCSS === 'string' ? options.shadowCSS : '';
    const proceduralStyleRules = [];
    let timer = 0, sliceHandle = 0, sliceIsRAF = false, stopped = false, counter = 0, filterer;

    // Closure-private Shadow DOM registry (captures both open and closed roots
    // without exposing any API or privileged reference to page scripts).
    const shadowRoots = new WeakMap();
    const observedShadowRoots = new WeakSet();
    const trackedShadowRefs = [];
    let sharedShadowSheet = null;

    const getShadowSheet = () => {
        if (sharedShadowSheet !== null) return sharedShadowSheet;
        const fullCSS = [hideCSS, ...proceduralStyleRules].filter(Boolean).join('\n');
        if (!fullCSS || typeof pageGlobal.CSSStyleSheet !== 'function') return null;
        try {
            const sheet = new pageGlobal.CSSStyleSheet();
            sheet.replaceSync(fullCSS);
            sharedShadowSheet = sheet;
            return sheet;
        } catch {
            return null;
        }
    };

    const adoptIntoShadowRoot = root => {
        if (!root || typeof root !== 'object') return;
        const sheet = getShadowSheet();
        if (sheet && Array.isArray(root.adoptedStyleSheets)) {
            try {
                if (!root.adoptedStyleSheets.includes(sheet)) {
                    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
                }
            } catch {}
        }
    };

    const refreshAllShadowSheets = () => {
        sharedShadowSheet = null;
        const sheet = getShadowSheet();
        if (!sheet) return;
        for (let i = trackedShadowRefs.length - 1; i >= 0; i--) {
            const root = typeof trackedShadowRefs[i].deref === 'function'
                ? trackedShadowRefs[i].deref()
                : trackedShadowRefs[i];
            if (!root) {
                trackedShadowRefs.splice(i, 1);
                continue;
            }
            adoptIntoShadowRoot(root);
        }
    };

    let observeRoot;
    const registerShadowRoot = (host, root) => {
        if (!host || !root) return root;
        shadowRoots.set(host, root);
        if (!observedShadowRoots.has(root)) {
            observedShadowRoots.add(root);
            trackedShadowRefs.push(typeof WeakRef === 'function' ? new WeakRef(root) : root);
            adoptIntoShadowRoot(root);
            if (typeof observeRoot === 'function' && !stopped) observeRoot(root);
        }
        return root;
    };

    // Hook Element.prototype.attachShadow to inspect both open and closed Web Components.
    if (typeof Element === 'function' && Element.prototype && typeof Element.prototype.attachShadow === 'function') {
        const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'attachShadow');
        if (desc && desc.configurable !== false && typeof desc.value === 'function') {
            const origAttachShadow = desc.value;
            const wrappedAttachShadow = {
                attachShadow() {
                    const root = Reflect.apply(origAttachShadow, this, arguments);
                    try { registerShadowRoot(this, root); commit(); } catch {}
                    return root;
                }
            }.attachShadow;
            try {
                Object.defineProperty(Element.prototype, 'attachShadow', {
                    value: wrappedAttachShadow,
                    writable: desc.writable,
                    enumerable: desc.enumerable,
                    configurable: desc.configurable,
                });
            } catch {}
        }
    }

    const resolveShadowRoot = node => {
        if (!node || typeof node !== 'object') return null;
        const known = shadowRoots.get(node) || node.shadowRoot || null;
        if (known) registerShadowRoot(node, known);
        return known;
    };

    // Lexical `self` proxy lets unmodified upstream PSelectorShadowTask resolve
    // `self.chrome.dom.openOrClosedShadowRoot` inside this closure ONLY, never
    // mutating `window.chrome` in the page global.
    const lexicalChrome = Object.freeze({
        dom: Object.freeze({ openOrClosedShadowRoot: resolveShadowRoot }),
    });
    const self = new Proxy(pageGlobal, {
        get(target, prop) {
            if (prop === 'chrome') return lexicalChrome;
            const val = Reflect.get(target, prop, target);
            return typeof val === 'function' ? val.bind(target) : val;
        },
    });

    const normalizeTasks = rule => {
        if (!rule || typeof rule !== 'object' || !Array.isArray(rule.tasks)) return rule;
        const copy = { ...rule, tasks: rule.tasks.map(task => {
            if (!Array.isArray(task)) return task;
            const op = task[0] === 'nth-ancestor' ? 'upward' : task[0];
            const arg = task[1] && typeof task[1] === 'object' && Array.isArray(task[1].tasks)
                ? normalizeTasks(task[1])
                : task[1];
            return [op, arg];
        }) };
        return copy;
    };

    const cancelSlice = () => {
        if (!sliceHandle) return;
        if (sliceIsRAF && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(sliceHandle);
        else clearTimeout(sliceHandle);
        sliceHandle = 0;
    };

    // Frame-budgeted procedural execution: slices selector evaluation across
    // frames whenever cumulative work exceeds FRAME_BUDGET_MS (~8ms), preventing
    // main-thread stalls on heavy SPAs while executing small batches immediately.
    const runBudgetedCommit = () => {
        if (stopped || !filterer || filterer.selectors.size === 0) return;
        cancelSlice();
        filterer.mustApplySelectors = false;
        const previousStyled = filterer.styledNodes;
        const nextStyled = new Set();
        filterer.styledNodes = nextStyled;
        const queue = Array.from(filterer.selectors.values());
        let cursor = 0;

        const processSlice = () => {
            sliceHandle = 0;
            if (stopped) return;
            let t0 = now();
            const sliceStart = t0;
            while (cursor < queue.length) {
                const pselector = queue[cursor++];
                const wallNow = Date.now();
                const allowance = Math.floor((wallNow - pselector.lastAllowanceTime) / 2000);
                if (allowance >= 1) {
                    pselector.budget += allowance * 50;
                    if (pselector.budget > 200) pselector.budget = 200;
                    pselector.lastAllowanceTime = wallNow;
                }
                if (pselector.budget <= 0) continue;
                const nodes = pselector.exec();
                // Also evaluate inside any tracked open/closed shadow roots when root selector is not document-only
                if (trackedShadowRefs.length > 0) {
                    for (let s = 0; s < trackedShadowRefs.length; s++) {
                        const sroot = typeof trackedShadowRefs[s].deref === 'function'
                            ? trackedShadowRefs[s].deref()
                            : trackedShadowRefs[s];
                        if (!sroot) continue;
                        try {
                            const shadowMatches = pselector.exec(sroot);
                            if (shadowMatches.length) nodes.push(...shadowMatches);
                        } catch {}
                    }
                }
                const t1 = now();
                pselector.budget += t0 - t1;
                if (pselector.budget < -500) {
                    pselector.budget = -0x7FFFFFFF;
                }
                t0 = t1;
                if (nodes.length > 0) {
                    pselector.hit = true;
                    filterer.processNodes(nodes, pselector.action);
                }
                if (cursor < queue.length && (t1 - sliceStart) >= FRAME_BUDGET_MS) {
                    if (typeof requestAnimationFrame === 'function' && document.visibilityState !== 'hidden') {
                        sliceIsRAF = true;
                        sliceHandle = requestAnimationFrame(processSlice);
                    } else {
                        sliceIsRAF = false;
                        sliceHandle = setTimeout(processSlice, 16);
                    }
                    return;
                }
            }
            filterer.unprocessNodes(previousStyled);
        };

        processSlice();
    };

    const commit = () => {
        if (timer || stopped) return;
        timer = setTimeout(() => { timer = 0; runBudgetedCommit(); }, 32);
    };
    const vAPI = {
        randomToken: () => prefix + (++counter),
        hideStyle: 'display: none !important;',
        domFilterer: {
            commit,
            addCSS: css => {
                if (typeof css === 'string' && css) {
                    proceduralStyleRules.push(css);
                    refreshAllShadowSheets();
                }
            },
            hasListeners: () => false,
        },
    };
    /* UBO_SOURCE */
    filterer = new vAPI.DOMProceduralFilterer(vAPI.domFilterer);
    vAPI.domFilterer.proceduralFilterer = filterer;
    const normalizedSelectors = Array.isArray(selectors) ? selectors.map(normalizeTasks) : [];
    const observer = new MutationObserver(records => {
        let shouldCommit = false;
        for (const r of records) {
            if (r.type === 'childList') {
                for (const added of r.addedNodes) {
                    if (added && added.nodeType === 1) {
                        resolveShadowRoot(added);
                        shouldCommit = true;
                    }
                }
                if (r.removedNodes.length > 0) shouldCommit = true;
            } else if (r.type !== 'attributes' || !r.attributeName || !r.attributeName.startsWith(prefix)) {
                shouldCommit = true;
            }
        }
        if (shouldCommit) commit();
    });
    observeRoot = root => {
        try {
            observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
        } catch {}
    };
    // Discover any open shadow roots already attached before procedural startup.
    if (document.documentElement) {
        try {
            if (document.documentElement.shadowRoot) registerShadowRoot(document.documentElement, document.documentElement.shadowRoot);
            for (const el of document.documentElement.querySelectorAll('*')) {
                if (el.shadowRoot) registerShadowRoot(el, el.shadowRoot);
            }
        } catch {}
    }
    filterer.addProceduralSelectors(normalizedSelectors);
    runBudgetedCommit();
    observeRoot(document);
    addEventListener('pagehide', () => { stopped = true; observer.disconnect(); clearTimeout(timer); timer = 0; cancelSlice(); });
    addEventListener('pageshow', () => {
        stopped = false;
        observeRoot(document);
        for (const ref of trackedShadowRefs) {
            const root = typeof ref.deref === 'function' ? ref.deref() : ref;
            if (root) observeRoot(root);
        }
        commit();
    });
    return true;
})
