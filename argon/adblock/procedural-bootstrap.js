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
    const hideGenericCSS = options && typeof options.shadowGenericCSS === 'string' ? options.shadowGenericCSS : '';
    const hideCSS = options && typeof options.shadowCSS === 'string' ? options.shadowCSS : '';
    const proceduralStyleRules = [];
    let timer = 0, sliceHandle = 0, sliceIsRAF = false, stopped = false, counter = 0, filterer;
    let dynamicRefreshQueued = false;
    let dynamicSheetDirty = false;
    const pendingToUnstyle = new Set();

    // Closure-private Shadow DOM registry (captures both open and closed roots
    // without exposing any API or privileged reference to page scripts).
    const shadowRoots = new WeakMap();
    const observedShadowRoots = new WeakSet();
    const trackedShadowRefs = [];
    let genericShadowSheet = null;
    let staticShadowSheet = null;
    let dynamicShadowSheet = null;

    const buildSheet = cssText => {
        if (!cssText || typeof pageGlobal.CSSStyleSheet !== 'function') return null;
        try {
            const sheet = new pageGlobal.CSSStyleSheet();
            sheet.replaceSync(cssText);
            return sheet;
        } catch {
            return null;
        }
    };

    const getDynamicShadowSheet = () => {
        if (proceduralStyleRules.length === 0) return null;
        if (dynamicShadowSheet === null) {
            dynamicShadowSheet = buildSheet(proceduralStyleRules.join('\n'));
            dynamicSheetDirty = false;
        } else if (dynamicSheetDirty) {
            try {
                dynamicShadowSheet.replaceSync(proceduralStyleRules.join('\n'));
                dynamicSheetDirty = false;
            } catch {}
        }
        return dynamicShadowSheet;
    };

    const adoptIntoShadowRoot = root => {
        if (!root || typeof root !== 'object' || !Array.isArray(root.adoptedStyleSheets)) return;
        if (genericShadowSheet === null && hideGenericCSS) {
            genericShadowSheet = buildSheet(hideGenericCSS);
        }
        if (staticShadowSheet === null && hideCSS) {
            staticShadowSheet = buildSheet(hideCSS);
        }
        const dynSheet = getDynamicShadowSheet();
        const existing = root.adoptedStyleSheets;
        let next = null;
        const appendIfMissing = sheet => {
            if (!sheet) return;
            const list = next || existing;
            if (!list.includes(sheet)) {
                next = next || [...existing];
                next.push(sheet);
            }
        };
        appendIfMissing(genericShadowSheet);
        appendIfMissing(staticShadowSheet);
        appendIfMissing(dynSheet);
        if (next !== null) {
            try { root.adoptedStyleSheets = next; } catch {}
        }
    };

    const refreshAllShadowSheets = () => {
        dynamicRefreshQueued = false;
        if (trackedShadowRefs.length === 0) return;
        const hadDynamic = dynamicShadowSheet !== null;
        const sheet = getDynamicShadowSheet();
        // If dynamicShadowSheet already existed, replaceSync updated all adopting roots in-place.
        if (!sheet || (hadDynamic && !dynamicSheetDirty)) return;
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

    const scheduleDynamicSheetRefresh = () => {
        if (dynamicRefreshQueued || trackedShadowRefs.length === 0) return;
        dynamicRefreshQueued = true;
        if (typeof queueMicrotask === 'function') {
            queueMicrotask(refreshAllShadowSheets);
        } else {
            Promise.resolve().then(refreshAllShadowSheets);
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
    const boundSelfCache = new Map();
    const self = new Proxy(pageGlobal, {
        get(target, prop) {
            if (prop === 'chrome') return lexicalChrome;
            const val = Reflect.get(target, prop, target);
            if (typeof val !== 'function') return val;
            let entry = boundSelfCache.get(prop);
            if (!entry || entry.fn !== val) {
                entry = { fn: val, bound: val.bind(target) };
                boundSelfCache.set(prop, entry);
            }
            return entry.bound;
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

    const inspectObserverNeeds = rules => {
        let needsCharacterData = false;
        let needsStyleAttr = false;
        const visitTasks = tasks => {
            if (!Array.isArray(tasks)) return;
            for (let i = 0; i < tasks.length; i++) {
                const task = tasks[i];
                if (!Array.isArray(task)) continue;
                const op = task[0];
                if (op === 'has-text' || op === 'min-text-length' || op === 'xpath') {
                    needsCharacterData = true;
                } else if (op === 'matches-css' || op === 'matches-css-before' || op === 'matches-css-after') {
                    needsStyleAttr = true;
                }
                const arg = task[1];
                if (arg && typeof arg === 'object' && Array.isArray(arg.tasks)) {
                    visitTasks(arg.tasks);
                }
            }
        };
        for (let i = 0; i < rules.length; i++) {
            const rule = rules[i];
            if (
                (typeof rule?.raw === 'string' && rule.raw.includes('[style')) ||
                (typeof rule?.selector === 'string' && rule.selector.includes('[style'))
            ) {
                needsStyleAttr = true;
            }
            if (rule && typeof rule === 'object' && Array.isArray(rule.tasks)) {
                visitTasks(rule.tasks);
            }
        }
        return { needsCharacterData, needsStyleAttr };
    };

    const cancelSlice = () => {
        if (!sliceHandle) return;
        if (sliceIsRAF && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(sliceHandle);
        else clearTimeout(sliceHandle);
        sliceHandle = 0;
    };

    let observer;
    let processMutations;

    // Frame-budgeted procedural execution: slices selector evaluation across
    // frames whenever cumulative work exceeds FRAME_BUDGET_MS (~8ms), preventing
    // main-thread stalls on heavy SPAs while executing small batches immediately.
    const runBudgetedCommit = () => {
        if (stopped || !filterer || filterer.selectors.size === 0) return;
        cancelSlice();
        if (dynamicSheetDirty && trackedShadowRefs.length > 0) {
            refreshAllShadowSheets();
        }
        filterer.mustApplySelectors = false;
        for (const node of filterer.styledNodes) {
            pendingToUnstyle.add(node);
        }
        filterer.styledNodes = new Set();
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
                // Also evaluate inside any tracked live shadow roots while pruning dead WeakRefs.
                if (trackedShadowRefs.length > 0) {
                    let write = 0;
                    for (let s = 0; s < trackedShadowRefs.length; s++) {
                        const ref = trackedShadowRefs[s];
                        const sroot = typeof ref.deref === 'function' ? ref.deref() : ref;
                        if (!sroot) continue;
                        trackedShadowRefs[write++] = ref;
                        try {
                            const shadowMatches = pselector.exec(sroot);
                            if (shadowMatches.length) nodes.push(...shadowMatches);
                        } catch {}
                    }
                    trackedShadowRefs.length = write;
                }
                const t1 = now();
                pselector.budget += t0 - t1;
                if (pselector.budget < -500) {
                    pselector.budget = -0x7FFFFFFF;
                }
                t0 = t1;
                if (nodes.length > 0) {
                    pselector.hit = true;
                    if (observer && typeof observer.takeRecords === 'function') {
                        processMutations(observer.takeRecords(), false);
                        filterer.processNodes(nodes, pselector.action);
                        observer.takeRecords();
                    } else {
                        filterer.processNodes(nodes, pselector.action);
                    }
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
            if (pendingToUnstyle.size > 0) {
                if (observer && typeof observer.takeRecords === 'function') {
                    processMutations(observer.takeRecords(), false);
                    filterer.unprocessNodes(pendingToUnstyle);
                    observer.takeRecords();
                } else {
                    filterer.unprocessNodes(pendingToUnstyle);
                }
                pendingToUnstyle.clear();
            }
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
                    dynamicSheetDirty = true;
                    scheduleDynamicSheetRefresh();
                }
            },
            hasListeners: () => false,
        },
    };
    /* UBO_SOURCE */
    filterer = new vAPI.DOMProceduralFilterer(vAPI.domFilterer);
    vAPI.domFilterer.proceduralFilterer = filterer;
    const normalizedSelectors = Array.isArray(selectors) ? selectors.map(normalizeTasks) : [];
    const { needsCharacterData, needsStyleAttr } = inspectObserverNeeds(normalizedSelectors);
    processMutations = (records, triggerCommit = true) => {
        if (!records || records.length === 0) return;
        let shouldCommit = false;
        for (let i = 0; i < records.length; i++) {
            const r = records[i];
            if (r.type === 'childList') {
                for (let j = 0; j < r.addedNodes.length; j++) {
                    const added = r.addedNodes[j];
                    if (added && added.nodeType === 1) {
                        resolveShadowRoot(added);
                        shouldCommit = true;
                    }
                }
                if (r.removedNodes.length > 0) shouldCommit = true;
            } else if (r.type === 'attributes') {
                const attr = r.attributeName;
                if (!attr) {
                    shouldCommit = true;
                } else if (!attr.startsWith(prefix) && (needsStyleAttr || attr !== 'style')) {
                    shouldCommit = true;
                }
            } else {
                shouldCommit = true;
            }
        }
        if (shouldCommit && triggerCommit) commit();
    };
    observer = new MutationObserver(records => processMutations(records, true));
    observeRoot = root => {
        try {
            observer.observe(root, {
                subtree: true,
                childList: true,
                characterData: needsCharacterData,
                attributes: true,
            });
        } catch {}
    };
    // Discover any open shadow roots already attached before procedural startup.
    if (document.documentElement) {
        try {
            if (document.documentElement.shadowRoot) {
                registerShadowRoot(document.documentElement, document.documentElement.shadowRoot);
            }
            if (typeof document.createTreeWalker === 'function') {
                const walker = document.createTreeWalker(document.documentElement, 1 /* NodeFilter.SHOW_ELEMENT */);
                for (let el = walker.nextNode(); el !== null; el = walker.nextNode()) {
                    if (el.shadowRoot) registerShadowRoot(el, el.shadowRoot);
                }
            } else {
                for (const el of document.documentElement.querySelectorAll('*')) {
                    if (el.shadowRoot) registerShadowRoot(el, el.shadowRoot);
                }
            }
        } catch {}
    }
    filterer.addProceduralSelectors(normalizedSelectors);
    runBudgetedCommit();
    observeRoot(document);
    addEventListener('pagehide', ev => {
        stopped = true;
        observer.disconnect();
        clearTimeout(timer);
        timer = 0;
        cancelSlice();
        if (!ev || !ev.persisted) {
            pendingToUnstyle.clear();
            filterer.styledNodes.clear();
            trackedShadowRefs.length = 0;
            boundSelfCache.clear();
        }
    });
    addEventListener('pageshow', () => {
        stopped = false;
        observeRoot(document);
        for (let i = trackedShadowRefs.length - 1; i >= 0; i--) {
            const ref = trackedShadowRefs[i];
            const root = typeof ref.deref === 'function' ? ref.deref() : ref;
            if (!root) {
                trackedShadowRefs.splice(i, 1);
                continue;
            }
            observeRoot(root);
        }
        commit();
    });
    return true;
})
