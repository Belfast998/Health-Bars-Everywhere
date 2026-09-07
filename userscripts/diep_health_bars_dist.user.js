// ==UserScript==
// @name         Diep.io Health Bars Everywhere Dist
// @namespace    local.diep.healthvalues.distribution
// @version      2.0.1
// @description  Barebones adaptive health bars and values. = toggles rendering; default rendering on the death screen.
// @author       Belfast
// @match        https://diep.io/*
// @match        https://*.diep.io/*
// @run-at       document-start
// @grant        unsafeWindow
// @sandbox      raw
// ==/UserScript==

(() => {
    'use strict';
    const SCRIPT_VERSION = '2.0.1';
    const PAGE = typeof unsafeWindow !== 'undefined' && unsafeWindow ? unsafeWindow : window;
    const WASM = PAGE.WebAssembly;
    if (!WASM) return;
    const MODE_GLOBAL_EXPORT = '__droneHealthDefaultMode';
    const INSTALL_KEY = '__diepHealthBarsModularInstalled';
    if (PAGE[INSTALL_KEY]) {
          PAGE.console.warn('[Diep Health Bars] Another modular copy is already installed. Keep one copy enabled and reload.');
        return;
    }
    PAGE[INSTALL_KEY] = SCRIPT_VERSION;

    // dont hardcode offsets, it finds from the wasm
    const Binary = (() => {
        function join(...parts) {
            const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
            let at = 0;
            for (const part of parts) { out.set(part, at); at += part.length; }
              return out;
        }
    function u32(value) {
            const out = [];
            do { const byte = value & 127; value >>>= 7; out.push(byte | (value ? 128 : 0)); } while (value);
            return Uint8Array.from(out);
        }
        class Reader {
            constructor(bytes, at = 0) { this.bytes = bytes; this.at = at; }
        byte() { if (this.at >= this.bytes.length) throw Error('Truncated WASM.'); return this.bytes[this.at++]; }
            skip(n) { if (n < 0 || this.at + n > this.bytes.length) throw Error('Truncated WASM payload.'); this.at += n; }
              uint() {
                let value = 0;
                for (let i = 0; i < 5; i++) {
                    const byte = this.byte();
                    value += (byte & 127) * 2 ** (i * 7);
                if (!(byte & 128)) {
                        if (value > 0xffffffff) throw Error('WASM integer overflow.');
                        return value;
                    }
                }
                throw Error('Invalid WASM unsigned integer.');
              }
        sint(bits = 32) {
                let value = 0, shift = 0, byte;
                for (let i = 0; i < Math.ceil(bits / 7); i++) {
                    byte = this.byte();
                    value += (byte & 127) * 2 ** shift;
                    shift += 7;
                    if (!(byte & 128)) return value - ((byte & 64) ? 2 ** shift : 0);
            }
                throw Error('Invalid WASM signed integer.');
            }
              skipI64() {
                for (let i = 0; i < 10; i++) if (!(this.byte() & 128)) return;
                throw Error('Invalid WASM i64.');
            }
        float(size) {
                const at = this.at; this.skip(size);
                const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + at, size);
                return size === 4 ? view.getFloat32(0, true) : view.getFloat64(0, true);
            }
            name() {
                const length = this.uint(), at = this.at; this.skip(length);
            return String.fromCharCode(...this.bytes.subarray(at, this.at));
            }
            valueType() { const type = this.byte(); if (type === 0x63 || type === 0x64) this.sint(33); }
            limits() {
                const flags = this.uint();
                if (flags & ~3) throw Error('Unsupported memory/table limits.');
                this.uint(); if (flags & 1) this.uint();
        }
        }
        function append(payload, item) {
            const reader = new Reader(payload), count = reader.uint();
              return join(u32(count + 1), payload.subarray(reader.at), item);
        }
        return { join, u32, Reader, append };
    })();

    // just enough wasm parsing so it doesnt guess too much
    const WasmCodec = (() => {
        const { Reader, join, u32 } = Binary;
        const MAGIC = [0, 97, 115, 109, 1, 0, 0, 0];
        function isModule(bytes) { return bytes.length >= 8 && MAGIC.every((b, i) => bytes[i] === b); }
    function parse(bytes) {
              if (!isModule(bytes)) throw Error('Not a WASM 1.0 module.');
            const reader = new Reader(bytes, 8), sections = [];
            while (reader.at < bytes.length) {
                const id = reader.byte(), size = reader.uint(), start = reader.at;
                reader.skip(size); sections.push({ id, payload: bytes.slice(start, reader.at) });
            }
        return { header: bytes.slice(0, 8), sections };
        }
        function serialize(module) {
            return join(module.header, ...module.sections.map(s => join(Uint8Array.of(s.id), u32(s.payload.length), s.payload)));
        }
          function bodies(payload) {
            const reader = new Reader(payload), count = reader.uint(), result = [];
        for (let i = 0; i < count; i++) {
                const size = reader.uint(), start = reader.at; reader.skip(size);
                result.push(payload.slice(start, reader.at));
            }
            if (reader.at !== payload.length) throw Error('Invalid code section length.');
            return result;
        }
    function code(bodies) { return join(u32(bodies.length), ...bodies.map(b => join(u32(b.length), b))); }
        function importedGlobals(module) {
              const section = module.sections.find(s => s.id === 2);
            if (!section) return 0;
            const reader = new Reader(section.payload), count = reader.uint();
            let globals = 0;
            for (let i = 0; i < count; i++) {
            reader.name(); reader.name();
                switch (reader.byte()) {
                    case 0: reader.uint(); break;
                    case 1: reader.valueType(); reader.limits(); break;
                    case 2: reader.limits(); break;
                    case 3: reader.valueType(); reader.byte(); globals++; break;
                      case 4: reader.byte(); reader.uint(); break;
                default: throw Error('Unsupported WASM import kind.');
                }
            }
            if (reader.at !== section.payload.length) throw Error('Invalid WASM imports.');
            return globals;
        }
        function exportsName(module, name) {
        const section = module.sections.find(s => s.id === 7);
            if (!section) return false;
            const reader = new Reader(section.payload), count = reader.uint();
              let found = false;
            for (let i = 0; i < count; i++) {
                if (reader.name() === name) found = true;
                reader.byte(); reader.uint();
        }
            return found;
        }
        function instruction(reader) {
            const item = { at: reader.at, op: reader.byte() };
            const op = item.op;
            if ([2, 3, 4].includes(op)) item.type = reader.sint(33);
        else if ([0x0c, 0x0d, 0x10, 0x12, 0x14, 0x15, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x3f, 0x40, 0xd2, 0xd5, 0xd6].includes(op)) item.arg = reader.uint();
            else if (op === 0x0e) { const count = reader.uint(); for (let i = 0; i <= count; i++) reader.uint(); }
            else if (op === 0x11 || op === 0x13) { reader.uint(); reader.uint(); }
            else if (op === 0x1c) { const count = reader.uint(); for (let i = 0; i < count; i++) reader.valueType(); }
            else if (op >= 0x28 && op <= 0x3e) {
                item.align = reader.uint();
                if (item.align > 4) throw Error('Unsupported WASM memory argument.');
            item.offset = reader.uint();
            }
            else if (op === 0x41) item.value = reader.sint();
            else if (op === 0x42) reader.skipI64();
              else if (op === 0x43 || op === 0x44) item.value = reader.float(op === 0x43 ? 4 : 8);
            else if (op === 0xd0) reader.sint(33);
            else if (op === 0xfc) {
            const sub = reader.uint(); item.sub = sub;
                if (sub <= 7) { /* no extra bytes here */ }
                else if ([8, 10, 12, 14].includes(sub)) { reader.uint(); reader.uint(); }
                else if ([9, 11, 13, 15, 16, 17].includes(sub)) reader.uint();
                else throw Error(`Unsupported WASM extended opcode ${sub}.`);
            }
            else if (!([0, 1, 5, 0x0b, 0x0f, 0x1a, 0x1b, 0xd1, 0xd3, 0xd4].includes(op) || (op >= 0x45 && op <= 0xc4))) {
            throw Error(`Unsupported WASM opcode 0x${op.toString(16)}.`);
              }
            item.end = reader.at;
            return item;
        }
        function decode(body) {
            const reader = new Reader(body), groups = reader.uint();
        for (let i = 0; i < groups; i++) { reader.uint(); reader.valueType(); }
            const items = [], blocks = [-1];
            while (reader.at < body.length) {
                const item = instruction(reader);
                if (item.op === 0x0c || item.op === 0x0d) {
                      item.target = blocks[blocks.length - 1 - item.arg];
                    if (item.target === undefined) throw Error('Invalid WASM branch depth.');
                item.ancestors = blocks.slice(0, blocks.length - item.arg);
                }
                if ([2, 3, 4].includes(item.op)) blocks.push(item.at);
                if (item.op === 0x0b) blocks.pop();
                if (item.op !== 1) items.push(item); // nops dont matter
                if (!blocks.length && reader.at !== body.length) throw Error('Unexpected function end.');
            }
        if (blocks.length) throw Error('Unterminated WASM function.');
            return items;
          }
        function dataRanges(payload) {
            const reader = new Reader(payload), count = reader.uint(), ranges = [];
            for (let i = 0; i < count; i++) {
                const flags = reader.uint();
            if (flags === 2) reader.uint();
                if (flags === 0 || flags === 2) {
                    while (instruction(reader).op !== 0x0b) { /* Initializer expression. */ }
                } else if (flags !== 1) throw Error('Unsupported data segment.');
                const size = reader.uint(), start = reader.at; reader.skip(size);
                ranges.push({ start, end: reader.at });
              }
        return ranges;
        }
        return { isModule, parse, serialize, bodies, code, importedGlobals, exportsName, decode, dataRanges };
    })();
    // match the op stuff, not random byte spots
    const HealthDiscovery = (() => {
        const shapes = {
        gate: [0x22, 0x2d, 0x41, 0x71, 0x0d, 0x20, 0x28, 0x22, 0x28, 0x0d],
            normalization: [0x20, 0x28, 0x22, 0x45, 0x0d, 0x20, 0x2d, 0x41, 0x71, 0x45, 0x0d],
            full: [0x5d, 0x45, 0x0d, 0x20, 0x20, 0x2b, 0x44, 0xa3, 0x20, 0x2a, 0xbb, 0xa0, 0x22, 0xb6, 0x38],
              secondGate: [0x20, 0x2d, 0x41, 0x71, 0x0d],
        };
        function shape(items, at, ops) { return ops.every((op, i) => items[at + i]?.op === op); }
        function discover(bodies) {
        const gates = [], normalizations = [], full = [], secondGates = [];
            for (let bodyIndex = 0; bodyIndex < bodies.length; bodyIndex++) {
                let items;
                try { items = WasmCodec.decode(bodies[bodyIndex]); }
                catch (error) { throw Error(`Function ${bodyIndex}: ${error.message}`); }
                for (let i = 0; i < items.length; i++) {
                    const t = items[i];
                if (t.op === 0x22 && shape(items, i, shapes.gate)) {
                        const s = items.slice(i, i + 10);
                        if (s[2].value === 1 && s[0].arg === s[5].arg && s[6].offset === 0 &&
                            s[4].target === s[9].target) {
                            gates.push({ bodyIndex, local: s[0].arg, flags: s[1].offset,
                                classOffset: s[8].offset, at: t.at, end: s[9].end,
                                mask: s[2], hiddenBranch: s[9], branch: s[4] });
                    }
                    }
                    if (t.op === 0x20 && shape(items, i, shapes.normalization)) {
                        const s = items.slice(i, i + 11);
                          if (s[2].arg === s[5].arg && s[7].value === 1 && s[4].target === s[10].target) {
                            normalizations.push({ bodyIndex, flags: s[6].offset,
                                componentOffset: s[1].offset, mask: s[7], at: t.at });
                    }
                    }
                    if (t.op === 0x5d && shape(items, i, shapes.full)) {
                        const s = items.slice(i, i + 15);
                        if (s[6].value === 50 && s[3].arg === s[8].arg && s[9].offset === s[14].offset) {
                            full.push({ bodyIndex, local: s[3].arg, at: t.at, end: s[14].end,
                                branch: s[2], opacityOffset: s[9].offset, timerOffset: s[5].offset });
                    }
                      }
                    if (t.op === 0x20 && shape(items, i, shapes.secondGate)) {
                        const s = items.slice(i, i + 5);
                        if (s[2].value === 1) secondGates.push({ bodyIndex, local: t.arg,
                            flags: s[1].offset, at: t.at, mask: s[2], branch: s[4] });
                    }
            }
            }
            const sets = [];
            for (const g of gates) {
                for (const f of full.filter(f => f.bodyIndex === g.bodyIndex && f.local === g.local && f.at > g.end &&
                      f.branch.target !== g.branch.target && f.branch.ancestors.includes(g.branch.target))) {
                    const seconds = secondGates.filter(s => s.bodyIndex === g.bodyIndex &&
                    s.local === g.local && s.flags === g.flags && s.at > f.end && s.branch.target === g.branch.target);
                    const norms = normalizations.filter(n => n.flags === g.flags);
                    if (seconds.length === 1 && norms.length === 1) sets.push({ gate: g, full: f, second: seconds[0], norm: norms[0] });
                }
            }
            const counts = { gateAndHidden: gates.length, normalization: normalizations.length,
                fullHealth: full.length, secondGate: secondGates.length, coherentSets: sets.length };
        if (sets.length !== 1) {
                const error = Error(`Expected one coherent health renderer, found ${sets.length}.`);
                  error.discovery = counts; throw error;
            }
            return { ...sets[0], counts };
        }
        return { discover };
    })();
    // patches get queued first so offsets dont get messed up
    const HealthPatches = (() => {
        const { join, u32 } = Binary;
        const getMode = index => join(Uint8Array.of(0x23), u32(index));
        function edit(bodyIndex, start, end, bytes, feature) { return { bodyIndex, start, end, bytes, feature }; }
          const features = [
        { name: 'projectileHealthbarGates', plan(d, index) {
                return [d.gate, d.second].map(g => edit(g.bodyIndex, g.mask.at, g.mask.end, getMode(index), this.name));
            } },
            { name: 'projectileHealthValues', plan(d) {
                return [edit(d.norm.bodyIndex, d.norm.mask.at, d.norm.mask.end, Uint8Array.of(0x41, 0), this.name)];
            } },
            { name: 'hiddenHealthClasses', plan(d, index) {
            return [edit(d.gate.bodyIndex, d.gate.hiddenBranch.at, d.gate.hiddenBranch.at,
                    join(getMode(index), Uint8Array.of(0x6c)), this.name)];
            } },
              { name: 'fullHealthVisibility', plan(d, index) {
                return [edit(d.full.bodyIndex, d.full.branch.at, d.full.branch.at,
                    join(getMode(index), Uint8Array.of(0x71)), this.name)];
            } },
    ];
        function apply(bodies, plan) {
            const grouped = new Map();
            for (const entry of plan) {
                if (!grouped.has(entry.bodyIndex)) grouped.set(entry.bodyIndex, []);
                grouped.get(entry.bodyIndex).push(entry);
            }
        for (const [index, edits] of grouped) {
                edits.sort((a, b) => a.start - b.start);
                let end = -1;
                for (const entry of edits) {
                    if (entry.start < end || entry.end < entry.start || entry.end > bodies[index].length) throw Error('Overlapping or invalid patch edits.');
                    end = entry.end;
                }
            for (const entry of edits.reverse()) {
                    const b = bodies[index];
                    bodies[index] = join(b.subarray(0, entry.start), entry.bytes, b.subarray(entry.end));
                }
              }
        }
        return { features, apply };
    })();
    // formatting isnt important, core patch still works
    const HealthFormatting = {
        apply(module) {
            const matches = [];
            for (const section of module.sections.filter(s => s.id === 11)) {
                const data = section.payload;
            for (const { start, end } of WasmCodec.dataRanges(data)) {
                      for (let i = start; i + 5 < end; i++) {
                        if (data[i] === 0 && data[i + 1] === 37 && data[i + 2] === 46 &&
                            data[i + 3] === 49 && data[i + 4] === 102 && data[i + 5] === 0) matches.push({ data, at: i + 3 });
                    }
                }
            }
        if (matches.length !== 1) return { applied: false, reason: `Expected one %.1f format string, found ${matches.length}.` };
            matches[0].data[matches[0].at] = 48;
            return { applied: true };
        },
    };

    const HealthEngine = {
    build(sourceBytes) {
            const report = { engine: 'semantic-v1', moduleValid: false, applied: false, features: {} };
            try {
                const module = WasmCodec.parse(sourceBytes);
                if (WasmCodec.exportsName(module, MODE_GLOBAL_EXPORT)) {
                    if (!WASM.validate(sourceBytes)) throw Error('Previously patched WASM failed validation.');
                    return { bytes: sourceBytes, successful: true, report: { ...report, moduleValid: true, applied: true, alreadyPatched: true } };
            }
                const codeSection = module.sections.find(s => s.id === 10);
                  const exportSection = module.sections.find(s => s.id === 7);
                if (!codeSection || !exportSection) throw Error('Required WASM sections missing.');
                const bodies = WasmCodec.bodies(codeSection.payload);
                const discovery = HealthDiscovery.discover(bodies);
                report.discovery = { counts: discovery.counts, rendererBody: discovery.gate.bodyIndex,
                normalizationBody: discovery.norm.bodyIndex, healthLocal: discovery.gate.local,
                    flagsOffset: discovery.gate.flags, componentOffset: discovery.norm.componentOffset,
                    classOffset: discovery.gate.classOffset, opacityOffset: discovery.full.opacityOffset };
                let globals = module.sections.find(s => s.id === 6);
                if (!globals) {
                    globals = { id: 6, payload: Uint8Array.of(0) };
                      module.sections.splice(module.sections.indexOf(exportSection), 0, globals);
            }
                const globalIndex = WasmCodec.importedGlobals(module) + new Binary.Reader(globals.payload).uint();
                globals.payload = Binary.append(globals.payload, Uint8Array.of(0x7f, 1, 0x41, 0, 0x0b));
                const name = Uint8Array.from(MODE_GLOBAL_EXPORT, c => c.charCodeAt(0));
                exportSection.payload = Binary.append(exportSection.payload,
                    Binary.join(Binary.u32(name.length), name, Uint8Array.of(3), Binary.u32(globalIndex)));
                const plan = [];
            for (const feature of HealthPatches.features) plan.push(...feature.plan(discovery, globalIndex));
                HealthPatches.apply(bodies, plan);
                codeSection.payload = WasmCodec.code(bodies);
                  let formatting;
                try { formatting = HealthFormatting.apply(module); }
                catch (error) { formatting = { applied: false, reason: error.message }; }
                const bytes = WasmCodec.serialize(module);
            report.moduleValid = WASM.validate(bytes);
                if (!report.moduleValid) throw Error('Modified WASM failed validation.');
                report.applied = true;
                report.globalIndex = globalIndex;
                report.features.runtimeToggle = true;
                for (const feature of HealthPatches.features) report.features[feature.name] = true;
                report.features.wholeValues = formatting.applied;
            if (!formatting.applied) report.formatting = formatting.reason;
                return { bytes, successful: true, report };
            } catch (error) {
                report.error = String(error.message || error);
                if (error.discovery) report.discovery = error.discovery;
                return { bytes: sourceBytes, successful: false, report };
            }
    },
    };
    // ui stuff stays seperate from wasm junk
    const Renderer = (() => {
          const RENDERER_RETRY_MS = 500;
        let enhancedRendering = true;
        let preferredEnhancedRendering = true;
    let deathScreenActive = false;
        let deathScreenPollTimer = 0;
        let deathScreenObserver = null;
        let modeGlobal = null;
        let rendererRetryTimer = 0;
        function setBooleanConvar(input, name, enabled) {
            try {
            if (typeof input.set_convar === 'function') {
                      input.set_convar(name, enabled);
                    return true;
                }
            }
            catch {
            }
        try {
                if (typeof input.execute === 'function') {
                    input.execute(`${name} ${enabled ? 'true' : 'false'}`);
                    return true;
                }
              }
            catch {
        }
            return false;
        }
        function applyRendererSettings() {
            const input = PAGE.input;
            if (!input)
                return false;
        const healthBarsEnabled = setBooleanConvar(input, 'ren_health_bars', true);
            const rawValuesEnabled = setBooleanConvar(input, 'ren_raw_health_values', enhancedRendering);
              return healthBarsEnabled && rawValuesEnabled;
        }
        function installRendererSettings() {
            if (applyRendererSettings()) {
                if (rendererRetryTimer) {
                PAGE.clearInterval(rendererRetryTimer);
                    rendererRetryTimer = 0;
                }
                return;
            }
            if (rendererRetryTimer)
                  return;
        rendererRetryTimer = PAGE.setInterval(() => {
                if (!applyRendererSettings())
                    return;
                PAGE.clearInterval(rendererRetryTimer);
                rendererRetryTimer = 0;
            }, RENDERER_RETRY_MS);
        }
    function syncModeGlobal() {
            if (!modeGlobal)
                return;
              modeGlobal.value = enhancedRendering ? 0 : 1;
        }
        function setRenderingMode(enhanced, announce = true) {
            enhancedRendering = Boolean(enhanced);
        syncModeGlobal();
            installRendererSettings();
        }
        function setPreferredRenderingMode(enhanced, announce = true) {
            preferredEnhancedRendering = Boolean(enhanced);
            if (deathScreenActive) {
                return;
        }
            setRenderingMode(preferredEnhancedRendering, announce);
        }
        function applyDeathScreenState(active) {
            const nextActive = Boolean(active);
            if (nextActive === deathScreenActive)
                return;
        deathScreenActive = nextActive;
            if (deathScreenActive) {
                setRenderingMode(false, false);
                return;
              }
            setRenderingMode(preferredEnhancedRendering, false);
        }
    function findGameOverScreen(root = PAGE.document) {
            if (!root || typeof root.querySelector !== 'function')
                return null;
            const direct = root.querySelector('#game-over-screen');
            if (direct)
                return direct;
            for (const element of root.querySelectorAll('*')) {
            if (!element.shadowRoot)
                      continue;
                const nested = findGameOverScreen(element.shadowRoot);
                if (nested)
                    return nested;
            }
            return null;
    }
        function isGameOverScreenActive(screen) {
            if (!screen || !screen.isConnected)
                return false;
            if (screen.classList.contains('active'))
                  return true;
            if (screen.hidden || screen.getAttribute('aria-hidden') === 'true') {
            return false;
            }
            try {
                const style = PAGE.getComputedStyle(screen);
                if (style.display === 'none' ||
                    style.visibility === 'hidden' ||
                    Number(style.opacity) === 0) {
                return false;
                }
                  const rect = screen.getBoundingClientRect();
                const hasGameOverContent = Boolean(screen.querySelector('#game-over-stats-player-score, ' +
                    '#game-over-stats-player-time, .game-detail'));
                return hasGameOverContent && rect.width > 0 && rect.height > 0;
            }
        catch {
                return false;
            }
        }
        function checkDeathScreen() {
            const screen = findGameOverScreen();
              applyDeathScreenState(isGameOverScreenActive(screen));
    }
        function installDeathScreenObserver() {
            const documentObject = PAGE.document;
            const Observer = PAGE.MutationObserver;
            if (!documentObject || typeof Observer !== 'function')
                return;
            const start = () => {
            if (!documentObject.documentElement || deathScreenObserver)
                    return;
                deathScreenObserver = new Observer(checkDeathScreen);
                  deathScreenObserver.observe(documentObject.documentElement, {
                    subtree: true,
                    childList: true,
                    attributes: true,
                attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
                });
                deathScreenPollTimer = PAGE.setInterval(checkDeathScreen, 500);
                documentObject.addEventListener('visibilitychange', checkDeathScreen);
                PAGE.addEventListener('pageshow', checkDeathScreen);
                checkDeathScreen();
            };
        if (documentObject.documentElement) {
                start();
            }
            else {
                documentObject.addEventListener('DOMContentLoaded', start, {
                    once: true,
                });
        }
        }
        function installRenderingToggle() {
            PAGE.addEventListener('keydown', (event) => {
                // composedPath catches inputs in shadow dom too
                const path = event.composedPath?.() || [event.target];
                const editing = path.some(target => target?.isContentEditable ||
                ['input', 'textarea', 'select'].includes(String(target?.tagName || '').toLowerCase()) ||
                    target?.getAttribute?.('role') === 'dialog');
                if (editing ||
                    event.repeat ||
                    event.key !== '=' ||
                    event.shiftKey ||
                    event.ctrlKey ||
                event.altKey ||
                      event.metaKey) {
                    return;
                }
                event.preventDefault();
                event.stopImmediatePropagation();
                setPreferredRenderingMode(!preferredEnhancedRendering);
        }, true);
        }
        function capture(instance) {
            const value = instance?.exports?.[MODE_GLOBAL_EXPORT];
            if (typeof WASM.Global !== 'function' || !(value instanceof WASM.Global)) return false;
              try {
                value.value = enhancedRendering ? 0 : 1;
            modeGlobal = value;
                return true;
            } catch { return false; }
        }
        function install() {
            installRendererSettings();
            installRenderingToggle();
        installDeathScreenObserver();
        }
          return { capture, install };
    })();

    const Faults = (() => {
        let warned = false;
    function warn() {
            if (warned) return;
            warned = true;
            PAGE.console.warn('[Diep Health Bars] Health patches could not be loaded. Use the Master edition to diagnose this build.');
        }
        return { record(result) { if (!result.successful) warn(); }, error: warn };
      })();
    // hooks are seperate, compile paths should still work
    function createWasmHooks(observer = {}) {
        const native = {};
        function bufferBytes(source) {
            if (PAGE.ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
            if (source instanceof PAGE.ArrayBuffer || Object.prototype.toString.call(source) === '[object ArrayBuffer]') {
                return new Uint8Array(source);
        }
            return null; // compiled modules get checked later
        }
          function contains(bytes, text) {
            outer: for (let i = 0; i <= bytes.length - text.length; i++) {
                if (bytes[i] !== text.charCodeAt(0)) continue;
                for (let j = 1; j < text.length; j++) if (bytes[i + j] !== text.charCodeAt(j)) continue outer;
            return true;
            }
            return false;
        }
        function isCandidate(bytes, knownDiepResponse = false) {
            return WasmCodec.isModule(bytes) && (knownDiepResponse ||
                (contains(bytes, 'ren_health_bars') && contains(bytes, 'ren_raw_health_values')));
    }
        function patchBuffer(source, label) {
            try {
                const bytes = bufferBytes(source);
                if (!bytes || !isCandidate(bytes)) return source;
                const result = HealthEngine.build(bytes);
                observer.record?.(result, label, bytes.byteLength);
            return result.successful ? result.bytes : source;
            } catch (error) {
                observer.error?.(error, label);
                return source;
              }
        }
        function knownResponse(response) {
        try {
                const url = new PAGE.URL(response.url, PAGE.location.href);
                return /(^|\.)diep\.io$/i.test(url.hostname) && /\/diep\.wasm$/i.test(url.pathname);
            } catch { return false; }
        }
        async function patchResponse(response, label) {
            const known = knownResponse(response);
        const contentType = response?.headers?.get?.('content-type') || '';
              if (!known && !contentType.toLowerCase().includes('application/wasm')) return response;
            try {
                const bytes = new Uint8Array(await response.clone().arrayBuffer());
                if (!isCandidate(bytes, known)) return response;
                const result = HealthEngine.build(bytes);
                observer.record?.(result, label, bytes.byteLength);
            if (!result.successful) return response;
                const headers = new PAGE.Headers(response.headers);
                headers.delete('content-encoding');
                headers.delete('content-length');
                headers.set('content-type', 'application/wasm');
                  return new PAGE.Response(result.bytes, { status: response.status, statusText: response.statusText, headers });
            } catch (error) {
            observer.error?.(error, label);
                return response;
            }
        }
        function install() {
            // save originals first or wrappers can get weird
            for (const name of ['instantiate', 'instantiateStreaming', 'compile', 'compileStreaming']) native[name] = WASM[name];
        for (const name of Object.keys(native)) {
                if (typeof native[name] !== 'function') continue;
                  const streaming = name.endsWith('Streaming');
                const instantiates = name.startsWith('instantiate');
                try {
                    WASM[name] = async function healthBarsWasmLoader(source, ...args) {
                        const patched = streaming ? await patchResponse(await source, name) : patchBuffer(source, name);
                    let result;
                        try { result = await Reflect.apply(native[name], this, [patched, ...args]); }
                        catch (error) { observer.error?.(error, name); throw error; }
                        if (instantiates) {
                            const captured = Renderer.capture(result?.instance || result);
                            observer.instantiated?.(captured, name);
                          } else observer.compiled?.(name);
                    return result;
                    };
                    observer.installed?.(name, WASM[name]);
                } catch (error) { observer.error?.(error, `install ${name}`); }
            }
            // constructors go thru the same patch path too
            for (const name of ['Module', 'Instance']) {
            if (typeof WASM[name] !== 'function') continue;
                try {
                    WASM[name] = new Proxy(WASM[name], {
                          construct(target, args, newTarget) {
                            if (name === 'Module') args = [patchBuffer(args[0], 'new Module'), ...args.slice(1)];
                            let result;
                            try { result = Reflect.construct(target, args, newTarget); }
                        catch (error) { observer.error?.(error, `new ${name}`); throw error; }
                            if (name === 'Instance') {
                                const captured = Renderer.capture(result);
                                observer.instantiated?.(captured, `new ${name}`);
                            } else observer.compiled?.(`new ${name}`);
                            return result;
                        },
                });
                    observer.installed?.(name, WASM[name]);
                } catch (error) { observer.error?.(error, `install ${name}`); }
            }
        }
        return { install };
    }
    createWasmHooks(Faults).install();
    Renderer.install();
})();


    const MODE_GLOBAL_EXPORT = '__droneHealthDefaultMode';
    const INSTALL_KEY = '__diepHealthBarsModularInstalled';
    if (PAGE[INSTALL_KEY]) {
          PAGE.console.warn('[Diep Health Bars] Another modular copy is already installed. Keep one copy enabled and reload.');
        return;
    }
    PAGE[INSTALL_KEY] = SCRIPT_VERSION;

    // Discover renderer structure from the WASM module instead of relying on fixed offsets.
    const Binary = (() => {
        function join(...parts) {
            const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
            let at = 0;
            for (const part of parts) { out.set(part, at); at += part.length; }
              return out;
        }
    function u32(value) {
            const out = [];
            do { const byte = value & 127; value >>>= 7; out.push(byte | (value ? 128 : 0)); } while (value);
            return Uint8Array.from(out);
        }
        class Reader {
            constructor(bytes, at = 0) { this.bytes = bytes; this.at = at; }
        byte() { if (this.at >= this.bytes.length) throw Error('Truncated WASM.'); return this.bytes[this.at++]; }
            skip(n) { if (n < 0 || this.at + n > this.bytes.length) throw Error('Truncated WASM payload.'); this.at += n; }
              uint() {
                let value = 0;
                for (let i = 0; i < 5; i++) {
                    const byte = this.byte();
                    value += (byte & 127) * 2 ** (i * 7);
                if (!(byte & 128)) {
                        if (value > 0xffffffff) throw Error('WASM integer overflow.');
                        return value;
                    }
                }
                throw Error('Invalid WASM unsigned integer.');
              }
        sint(bits = 32) {
                let value = 0, shift = 0, byte;
                for (let i = 0; i < Math.ceil(bits / 7); i++) {
                    byte = this.byte();
                    value += (byte & 127) * 2 ** shift;
                    shift += 7;
                    if (!(byte & 128)) return value - ((byte & 64) ? 2 ** shift : 0);
            }
                throw Error('Invalid WASM signed integer.');
            }
              skipI64() {
                for (let i = 0; i < 10; i++) if (!(this.byte() & 128)) return;
                throw Error('Invalid WASM i64.');
            }
        float(size) {
                const at = this.at; this.skip(size);
                const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + at, size);
                return size === 4 ? view.getFloat32(0, true) : view.getFloat64(0, true);
            }
            name() {
                const length = this.uint(), at = this.at; this.skip(length);
            return String.fromCharCode(...this.bytes.subarray(at, this.at));
            }
            valueType() { const type = this.byte(); if (type === 0x63 || type === 0x64) this.sint(33); }
            limits() {
                const flags = this.uint();
                if (flags & ~3) throw Error('Unsupported memory/table limits.');
                this.uint(); if (flags & 1) this.uint();
        }
        }
        function append(payload, item) {
            const reader = new Reader(payload), count = reader.uint();
              return join(u32(count + 1), payload.subarray(reader.at), item);
        }
        return { join, u32, Reader, append };
    })();

    // Minimal WASM parser used for structural discovery and validation.
    const WasmCodec = (() => {
        const { Reader, join, u32 } = Binary;
        const MAGIC = [0, 97, 115, 109, 1, 0, 0, 0];
        function isModule(bytes) { return bytes.length >= 8 && MAGIC.every((b, i) => bytes[i] === b); }
    function parse(bytes) {
              if (!isModule(bytes)) throw Error('Not a WASM 1.0 module.');
            const reader = new Reader(bytes, 8), sections = [];
            while (reader.at < bytes.length) {
                const id = reader.byte(), size = reader.uint(), start = reader.at;
                reader.skip(size); sections.push({ id, payload: bytes.slice(start, reader.at) });
            }
        return { header: bytes.slice(0, 8), sections };
        }
        function serialize(module) {
            return join(module.header, ...module.sections.map(s => join(Uint8Array.of(s.id), u32(s.payload.length), s.payload)));
        }
          function bodies(payload) {
            const reader = new Reader(payload), count = reader.uint(), result = [];
        for (let i = 0; i < count; i++) {
                const size = reader.uint(), start = reader.at; reader.skip(size);
                result.push(payload.slice(start, reader.at));
            }
            if (reader.at !== payload.length) throw Error('Invalid code section length.');
            return result;
        }
    function code(bodies) { return join(u32(bodies.length), ...bodies.map(b => join(u32(b.length), b))); }
        function importedGlobals(module) {
              const section = module.sections.find(s => s.id === 2);
            if (!section) return 0;
            const reader = new Reader(section.payload), count = reader.uint();
            let globals = 0;
            for (let i = 0; i < count; i++) {
            reader.name(); reader.name();
                switch (reader.byte()) {
                    case 0: reader.uint(); break;
                    case 1: reader.valueType(); reader.limits(); break;
                    case 2: reader.limits(); break;
                    case 3: reader.valueType(); reader.byte(); globals++; break;
                      case 4: reader.byte(); reader.uint(); break;
                default: throw Error('Unsupported WASM import kind.');
                }
            }
            if (reader.at !== section.payload.length) throw Error('Invalid WASM imports.');
            return globals;
        }
        function exportsName(module, name) {
        const section = module.sections.find(s => s.id === 7);
            if (!section) return false;
            const reader = new Reader(section.payload), count = reader.uint();
              let found = false;
            for (let i = 0; i < count; i++) {
                if (reader.name() === name) found = true;
                reader.byte(); reader.uint();
        }
            return found;
        }
        function instruction(reader) {
            const item = { at: reader.at, op: reader.byte() };
            const op = item.op;
            if ([2, 3, 4].includes(op)) item.type = reader.sint(33);
        else if ([0x0c, 0x0d, 0x10, 0x12, 0x14, 0x15, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x3f, 0x40, 0xd2, 0xd5, 0xd6].includes(op)) item.arg = reader.uint();
            else if (op === 0x0e) { const count = reader.uint(); for (let i = 0; i <= count; i++) reader.uint(); }
            else if (op === 0x11 || op === 0x13) { reader.uint(); reader.uint(); }
            else if (op === 0x1c) { const count = reader.uint(); for (let i = 0; i < count; i++) reader.valueType(); }
            else if (op >= 0x28 && op <= 0x3e) {
                item.align = reader.uint();
                if (item.align > 4) throw Error('Unsupported WASM memory argument.');
            item.offset = reader.uint();
            }
            else if (op === 0x41) item.value = reader.sint();
            else if (op === 0x42) reader.skipI64();
              else if (op === 0x43 || op === 0x44) item.value = reader.float(op === 0x43 ? 4 : 8);
            else if (op === 0xd0) reader.sint(33);
            else if (op === 0xfc) {
            const sub = reader.uint(); item.sub = sub;
                if (sub <= 7) { /* no extra bytes here */ }
                else if ([8, 10, 12, 14].includes(sub)) { reader.uint(); reader.uint(); }
                else if ([9, 11, 13, 15, 16, 17].includes(sub)) reader.uint();
                else throw Error(`Unsupported WASM extended opcode ${sub}.`);
            }
            else if (!([0, 1, 5, 0x0b, 0x0f, 0x1a, 0x1b, 0xd1, 0xd3, 0xd4].includes(op) || (op >= 0x45 && op <= 0xc4))) {
            throw Error(`Unsupported WASM opcode 0x${op.toString(16)}.`);
              }
            item.end = reader.at;
            return item;
        }
        function decode(body) {
            const reader = new Reader(body), groups = reader.uint();
        for (let i = 0; i < groups; i++) { reader.uint(); reader.valueType(); }
            const items = [], blocks = [-1];
            while (reader.at < body.length) {
                const item = instruction(reader);
                if (item.op === 0x0c || item.op === 0x0d) {
                      item.target = blocks[blocks.length - 1 - item.arg];
                    if (item.target === undefined) throw Error('Invalid WASM branch depth.');
                item.ancestors = blocks.slice(0, blocks.length - item.arg);
                }
                if ([2, 3, 4].includes(item.op)) blocks.push(item.at);
                if (item.op === 0x0b) blocks.pop();
                if (item.op !== 1) items.push(item); // nops dont matter
                if (!blocks.length && reader.at !== body.length) throw Error('Unexpected function end.');
            }
        if (blocks.length) throw Error('Unterminated WASM function.');
            return items;
          }
        function dataRanges(payload) {
            const reader = new Reader(payload), count = reader.uint(), ranges = [];
            for (let i = 0; i < count; i++) {
                const flags = reader.uint();
            if (flags === 2) reader.uint();
                if (flags === 0 || flags === 2) {
                    while (instruction(reader).op !== 0x0b) { /* Initializer expression. */ }
                } else if (flags !== 1) throw Error('Unsupported data segment.');
                const size = reader.uint(), start = reader.at; reader.skip(size);
                ranges.push({ start, end: reader.at });
              }
        return ranges;
        }
        return { isModule, parse, serialize, bodies, code, importedGlobals, exportsName, decode, dataRanges };
    })();
    // Match instruction structure rather than arbitrary byte offsets.
    const HealthDiscovery = (() => {
        const shapes = {
        gate: [0x22, 0x2d, 0x41, 0x71, 0x0d, 0x20, 0x28, 0x22, 0x28, 0x0d],
            normalization: [0x20, 0x28, 0x22, 0x45, 0x0d, 0x20, 0x2d, 0x41, 0x71, 0x45, 0x0d],
            full: [0x5d, 0x45, 0x0d, 0x20, 0x20, 0x2b, 0x44, 0xa3, 0x20, 0x2a, 0xbb, 0xa0, 0x22, 0xb6, 0x38],
              secondGate: [0x20, 0x2d, 0x41, 0x71, 0x0d],
        };
        function shape(items, at, ops) { return ops.every((op, i) => items[at + i]?.op === op); }
        function discover(bodies) {
        const gates = [], normalizations = [], full = [], secondGates = [];
            for (let bodyIndex = 0; bodyIndex < bodies.length; bodyIndex++) {
                let items;
                try { items = WasmCodec.decode(bodies[bodyIndex]); }
                catch (error) { throw Error(`Function ${bodyIndex}: ${error.message}`); }
                for (let i = 0; i < items.length; i++) {
                    const t = items[i];
                if (t.op === 0x22 && shape(items, i, shapes.gate)) {
                        const s = items.slice(i, i + 10);
                        if (s[2].value === 1 && s[0].arg === s[5].arg && s[6].offset === 0 &&
                            s[4].target === s[9].target) {
                            gates.push({ bodyIndex, local: s[0].arg, flags: s[1].offset,
                                classOffset: s[8].offset, at: t.at, end: s[9].end,
                                mask: s[2], hiddenBranch: s[9], branch: s[4] });
                    }
                    }
                    if (t.op === 0x20 && shape(items, i, shapes.normalization)) {
                        const s = items.slice(i, i + 11);
                          if (s[2].arg === s[5].arg && s[7].value === 1 && s[4].target === s[10].target) {
                            normalizations.push({ bodyIndex, flags: s[6].offset,
                                componentOffset: s[1].offset, mask: s[7], at: t.at });
                    }
                    }
                    if (t.op === 0x5d && shape(items, i, shapes.full)) {
                        const s = items.slice(i, i + 15);
                        if (s[6].value === 50 && s[3].arg === s[8].arg && s[9].offset === s[14].offset) {
                            full.push({ bodyIndex, local: s[3].arg, at: t.at, end: s[14].end,
                                branch: s[2], opacityOffset: s[9].offset, timerOffset: s[5].offset });
                    }
                      }
                    if (t.op === 0x20 && shape(items, i, shapes.secondGate)) {
                        const s = items.slice(i, i + 5);
                        if (s[2].value === 1) secondGates.push({ bodyIndex, local: t.arg,
                            flags: s[1].offset, at: t.at, mask: s[2], branch: s[4] });
                    }
            }
            }
            const sets = [];
            for (const g of gates) {
                for (const f of full.filter(f => f.bodyIndex === g.bodyIndex && f.local === g.local && f.at > g.end &&
                      f.branch.target !== g.branch.target && f.branch.ancestors.includes(g.branch.target))) {
                    const seconds = secondGates.filter(s => s.bodyIndex === g.bodyIndex &&
                    s.local === g.local && s.flags === g.flags && s.at > f.end && s.branch.target === g.branch.target);
                    const norms = normalizations.filter(n => n.flags === g.flags);
                    if (seconds.length === 1 && norms.length === 1) sets.push({ gate: g, full: f, second: seconds[0], norm: norms[0] });
                }
            }
            const counts = { gateAndHidden: gates.length, normalization: normalizations.length,
                fullHealth: full.length, secondGate: secondGates.length, coherentSets: sets.length };
        if (sets.length !== 1) {
                const error = Error(`Expected one coherent health renderer, found ${sets.length}.`);
                  error.discovery = counts; throw error;
            }
            return { ...sets[0], counts };
        }
        return { discover };
    })();
    // patches get queued first so offsets dont get messed up
    const HealthPatches = (() => {
        const { join, u32 } = Binary;
        const getMode = index => join(Uint8Array.of(0x23), u32(index));
        function edit(bodyIndex, start, end, bytes, feature) { return { bodyIndex, start, end, bytes, feature }; }
          const features = [
        { name: 'projectileHealthbarGates', plan(d, index) {
                return [d.gate, d.second].map(g => edit(g.bodyIndex, g.mask.at, g.mask.end, getMode(index), this.name));
            } },
            { name: 'projectileHealthValues', plan(d) {
                return [edit(d.norm.bodyIndex, d.norm.mask.at, d.norm.mask.end, Uint8Array.of(0x41, 0), this.name)];
            } },
            { name: 'hiddenHealthClasses', plan(d, index) {
            return [edit(d.gate.bodyIndex, d.gate.hiddenBranch.at, d.gate.hiddenBranch.at,
                    join(getMode(index), Uint8Array.of(0x6c)), this.name)];
            } },
              { name: 'fullHealthVisibility', plan(d, index) {
                return [edit(d.full.bodyIndex, d.full.branch.at, d.full.branch.at,
                    join(getMode(index), Uint8Array.of(0x71)), this.name)];
            } },
    ];
        function apply(bodies, plan) {
            const grouped = new Map();
            for (const entry of plan) {
                if (!grouped.has(entry.bodyIndex)) grouped.set(entry.bodyIndex, []);
                grouped.get(entry.bodyIndex).push(entry);
            }
        for (const [index, edits] of grouped) {
                edits.sort((a, b) => a.start - b.start);
                let end = -1;
                for (const entry of edits) {
                    if (entry.start < end || entry.end < entry.start || entry.end > bodies[index].length) throw Error('Overlapping or invalid patch edits.');
                    end = entry.end;
                }
            for (const entry of edits.reverse()) {
                    const b = bodies[index];
                    bodies[index] = join(b.subarray(0, entry.start), entry.bytes, b.subarray(entry.end));
                }
              }
        }
        return { features, apply };
    })();
    // formatting isnt important, core patch still works
    const HealthFormatting = {
        apply(module) {
            const matches = [];
            for (const section of module.sections.filter(s => s.id === 11)) {
                const data = section.payload;
            for (const { start, end } of WasmCodec.dataRanges(data)) {
                      for (let i = start; i + 5 < end; i++) {
                        if (data[i] === 0 && data[i + 1] === 37 && data[i + 2] === 46 &&
                            data[i + 3] === 49 && data[i + 4] === 102 && data[i + 5] === 0) matches.push({ data, at: i + 3 });
                    }
                }
            }
        if (matches.length !== 1) return { applied: false, reason: `Expected one %.1f format string, found ${matches.length}.` };
            matches[0].data[matches[0].at] = 48;
            return { applied: true };
        },
    };

    const HealthEngine = {
    build(sourceBytes) {
            const report = { engine: 'semantic-v1', moduleValid: false, applied: false, features: {} };
            try {
                const module = WasmCodec.parse(sourceBytes);
                if (WasmCodec.exportsName(module, MODE_GLOBAL_EXPORT)) {
                    if (!WASM.validate(sourceBytes)) throw Error('Previously patched WASM failed validation.');
                    return { bytes: sourceBytes, successful: true, report: { ...report, moduleValid: true, applied: true, alreadyPatched: true } };
            }
                const codeSection = module.sections.find(s => s.id === 10);
                  const exportSection = module.sections.find(s => s.id === 7);
                if (!codeSection || !exportSection) throw Error('Required WASM sections missing.');
                const bodies = WasmCodec.bodies(codeSection.payload);
                const discovery = HealthDiscovery.discover(bodies);
                report.discovery = { counts: discovery.counts, rendererBody: discovery.gate.bodyIndex,
                normalizationBody: discovery.norm.bodyIndex, healthLocal: discovery.gate.local,
                    flagsOffset: discovery.gate.flags, componentOffset: discovery.norm.componentOffset,
                    classOffset: discovery.gate.classOffset, opacityOffset: discovery.full.opacityOffset };
                let globals = module.sections.find(s => s.id === 6);
                if (!globals) {
                    globals = { id: 6, payload: Uint8Array.of(0) };
                      module.sections.splice(module.sections.indexOf(exportSection), 0, globals);
            }
                const globalIndex = WasmCodec.importedGlobals(module) + new Binary.Reader(globals.payload).uint();
                globals.payload = Binary.append(globals.payload, Uint8Array.of(0x7f, 1, 0x41, 0, 0x0b));
                const name = Uint8Array.from(MODE_GLOBAL_EXPORT, c => c.charCodeAt(0));
                exportSection.payload = Binary.append(exportSection.payload,
                    Binary.join(Binary.u32(name.length), name, Uint8Array.of(3), Binary.u32(globalIndex)));
                const plan = [];
            for (const feature of HealthPatches.features) plan.push(...feature.plan(discovery, globalIndex));
                HealthPatches.apply(bodies, plan);
                codeSection.payload = WasmCodec.code(bodies);
                  let formatting;
                try { formatting = HealthFormatting.apply(module); }
                catch (error) { formatting = { applied: false, reason: error.message }; }
                const bytes = WasmCodec.serialize(module);
            report.moduleValid = WASM.validate(bytes);
                if (!report.moduleValid) throw Error('Modified WASM failed validation.');
                report.applied = true;
                report.globalIndex = globalIndex;
                report.features.runtimeToggle = true;
                for (const feature of HealthPatches.features) report.features[feature.name] = true;
                report.features.wholeValues = formatting.applied;
            if (!formatting.applied) report.formatting = formatting.reason;
                return { bytes, successful: true, report };
            } catch (error) {
                report.error = String(error.message || error);
                if (error.discovery) report.discovery = error.discovery;
                return { bytes: sourceBytes, successful: false, report };
            }
    },
    };
    // ui stuff stays seperate from wasm junk
    const Renderer = (() => {
          const RENDERER_RETRY_MS = 500;
        let enhancedRendering = true;
        let preferredEnhancedRendering = true;
    let deathScreenActive = false;
        let deathScreenPollTimer = 0;
        let deathScreenObserver = null;
        let modeGlobal = null;
        let rendererRetryTimer = 0;
        function setBooleanConvar(input, name, enabled) {
            try {
            if (typeof input.set_convar === 'function') {
                      input.set_convar(name, enabled);
                    return true;
                }
            }
            catch {
            }
        try {
                if (typeof input.execute === 'function') {
                    input.execute(`${name} ${enabled ? 'true' : 'false'}`);
                    return true;
                }
              }
            catch {
        }
            return false;
        }
        function applyRendererSettings() {
            const input = PAGE.input;
            if (!input)
                return false;
        const healthBarsEnabled = setBooleanConvar(input, 'ren_health_bars', true);
            const rawValuesEnabled = setBooleanConvar(input, 'ren_raw_health_values', enhancedRendering);
              return healthBarsEnabled && rawValuesEnabled;
        }
        function installRendererSettings() {
            if (applyRendererSettings()) {
                if (rendererRetryTimer) {
                PAGE.clearInterval(rendererRetryTimer);
                    rendererRetryTimer = 0;
                }
                return;
            }
            if (rendererRetryTimer)
                  return;
        rendererRetryTimer = PAGE.setInterval(() => {
                if (!applyRendererSettings())
                    return;
                PAGE.clearInterval(rendererRetryTimer);
                rendererRetryTimer = 0;
            }, RENDERER_RETRY_MS);
        }
    function syncModeGlobal() {
            if (!modeGlobal)
                return;
              modeGlobal.value = enhancedRendering ? 0 : 1;
        }
        function setRenderingMode(enhanced, announce = true) {
            enhancedRendering = Boolean(enhanced);
        syncModeGlobal();
            installRendererSettings();
        }
        function setPreferredRenderingMode(enhanced, announce = true) {
            preferredEnhancedRendering = Boolean(enhanced);
            if (deathScreenActive) {
                return;
        }
            setRenderingMode(preferredEnhancedRendering, announce);
        }
        function applyDeathScreenState(active) {
            const nextActive = Boolean(active);
            if (nextActive === deathScreenActive)
                return;
        deathScreenActive = nextActive;
            if (deathScreenActive) {
                setRenderingMode(false, false);
                return;
              }
            setRenderingMode(preferredEnhancedRendering, false);
        }
    function findGameOverScreen(root = PAGE.document) {
            if (!root || typeof root.querySelector !== 'function')
                return null;
            const direct = root.querySelector('#game-over-screen');
            if (direct)
                return direct;
            for (const element of root.querySelectorAll('*')) {
            if (!element.shadowRoot)
                      continue;
                const nested = findGameOverScreen(element.shadowRoot);
                if (nested)
                    return nested;
            }
            return null;
    }
        function isGameOverScreenActive(screen) {
            if (!screen || !screen.isConnected)
                return false;
            if (screen.classList.contains('active'))
                  return true;
            if (screen.hidden || screen.getAttribute('aria-hidden') === 'true') {
            return false;
            }
            try {
                const style = PAGE.getComputedStyle(screen);
                if (style.display === 'none' ||
                    style.visibility === 'hidden' ||
                    Number(style.opacity) === 0) {
                return false;
                }
                  const rect = screen.getBoundingClientRect();
                const hasGameOverContent = Boolean(screen.querySelector('#game-over-stats-player-score, ' +
                    '#game-over-stats-player-time, .game-detail'));
                return hasGameOverContent && rect.width > 0 && rect.height > 0;
            }
        catch {
                return false;
            }
        }
        function checkDeathScreen() {
            const screen = findGameOverScreen();
              applyDeathScreenState(isGameOverScreenActive(screen));
    }
        function installDeathScreenObserver() {
            const documentObject = PAGE.document;
            const Observer = PAGE.MutationObserver;
            if (!documentObject || typeof Observer !== 'function')
                return;
            const start = () => {
            if (!documentObject.documentElement || deathScreenObserver)
                    return;
                deathScreenObserver = new Observer(checkDeathScreen);
                  deathScreenObserver.observe(documentObject.documentElement, {
                    subtree: true,
                    childList: true,
                    attributes: true,
                attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
                });
                deathScreenPollTimer = PAGE.setInterval(checkDeathScreen, 500);
                documentObject.addEventListener('visibilitychange', checkDeathScreen);
                PAGE.addEventListener('pageshow', checkDeathScreen);
                checkDeathScreen();
            };
        if (documentObject.documentElement) {
                start();
            }
            else {
                documentObject.addEventListener('DOMContentLoaded', start, {
                    once: true,
                });
        }
        }
        function installRenderingToggle() {
            PAGE.addEventListener('keydown', (event) => {
                // composedPath catches inputs in shadow dom too
                const path = event.composedPath?.() || [event.target];
                const editing = path.some(target => target?.isContentEditable ||
                ['input', 'textarea', 'select'].includes(String(target?.tagName || '').toLowerCase()) ||
                    target?.getAttribute?.('role') === 'dialog');
                if (editing ||
                    event.repeat ||
                    event.key !== '=' ||
                    event.shiftKey ||
                    event.ctrlKey ||
                event.altKey ||
                      event.metaKey) {
                    return;
                }
                event.preventDefault();
                event.stopImmediatePropagation();
                setPreferredRenderingMode(!preferredEnhancedRendering);
        }, true);
        }
        function capture(instance) {
            const value = instance?.exports?.[MODE_GLOBAL_EXPORT];
            if (typeof WASM.Global !== 'function' || !(value instanceof WASM.Global)) return false;
              try {
                value.value = enhancedRendering ? 0 : 1;
            modeGlobal = value;
                return true;
            } catch { return false; }
        }
        function install() {
            installRendererSettings();
            installRenderingToggle();
        installDeathScreenObserver();
        }
          return { capture, install };
    })();

    const Faults = (() => {
        let warned = false;
    function warn() {
            if (warned) return;
            warned = true;
            PAGE.console.warn('[Diep Health Bars] Health patches could not be loaded. Use the Master edition to diagnose this build.');
        }
        return { record(result) { if (!result.successful) warn(); }, error: warn };
      })();
    // hooks are seperate, compile paths should still work
    function createWasmHooks(observer = {}) {
        const native = {};
        function bufferBytes(source) {
            if (PAGE.ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
            if (source instanceof PAGE.ArrayBuffer || Object.prototype.toString.call(source) === '[object ArrayBuffer]') {
                return new Uint8Array(source);
        }
            return null; // compiled modules get checked later
        }
          function contains(bytes, text) {
            outer: for (let i = 0; i <= bytes.length - text.length; i++) {
                if (bytes[i] !== text.charCodeAt(0)) continue;
                for (let j = 1; j < text.length; j++) if (bytes[i + j] !== text.charCodeAt(j)) continue outer;
            return true;
            }
            return false;
        }
        function isCandidate(bytes, knownDiepResponse = false) {
            return WasmCodec.isModule(bytes) && (knownDiepResponse ||
                (contains(bytes, 'ren_health_bars') && contains(bytes, 'ren_raw_health_values')));
    }
        function patchBuffer(source, label) {
            try {
                const bytes = bufferBytes(source);
                if (!bytes || !isCandidate(bytes)) return source;
                const result = HealthEngine.build(bytes);
                observer.record?.(result, label, bytes.byteLength);
            return result.successful ? result.bytes : source;
            } catch (error) {
                observer.error?.(error, label);
                return source;
              }
        }
        function knownResponse(response) {
        try {
                const url = new PAGE.URL(response.url, PAGE.location.href);
                return /(^|\.)diep\.io$/i.test(url.hostname) && /\/diep\.wasm$/i.test(url.pathname);
            } catch { return false; }
        }
        async function patchResponse(response, label) {
            const known = knownResponse(response);
        const contentType = response?.headers?.get?.('content-type') || '';
              if (!known && !contentType.toLowerCase().includes('application/wasm')) return response;
            try {
                const bytes = new Uint8Array(await response.clone().arrayBuffer());
                if (!isCandidate(bytes, known)) return response;
                const result = HealthEngine.build(bytes);
                observer.record?.(result, label, bytes.byteLength);
            if (!result.successful) return response;
                const headers = new PAGE.Headers(response.headers);
                headers.delete('content-encoding');
                headers.delete('content-length');
                headers.set('content-type', 'application/wasm');
                  return new PAGE.Response(result.bytes, { status: response.status, statusText: response.statusText, headers });
            } catch (error) {
            observer.error?.(error, label);
                return response;
            }
        }
        function install() {
            // Capture native methods before installing wrappers.
            for (const name of ['instantiate', 'instantiateStreaming', 'compile', 'compileStreaming']) native[name] = WASM[name];
        for (const name of Object.keys(native)) {
                if (typeof native[name] !== 'function') continue;
                  const streaming = name.endsWith('Streaming');
                const instantiates = name.startsWith('instantiate');
                try {
                    WASM[name] = async function healthBarsWasmLoader(source, ...args) {
                        const patched = streaming ? await patchResponse(await source, name) : patchBuffer(source, name);
                    let result;
                        try { result = await Reflect.apply(native[name], this, [patched, ...args]); }
                        catch (error) { observer.error?.(error, name); throw error; }
                        if (instantiates) {
                            const captured = Renderer.capture(result?.instance || result);
                            observer.instantiated?.(captured, name);
                          } else observer.compiled?.(name);
                    return result;
                    };
                    observer.installed?.(name, WASM[name]);
                } catch (error) { observer.error?.(error, `install ${name}`); }
            }
            // Route constructor-based loading through the same patch path.
            for (const name of ['Module', 'Instance']) {
            if (typeof WASM[name] !== 'function') continue;
                try {
                    WASM[name] = new Proxy(WASM[name], {
                          construct(target, args, newTarget) {
                            if (name === 'Module') args = [patchBuffer(args[0], 'new Module'), ...args.slice(1)];
                            let result;
                            try { result = Reflect.construct(target, args, newTarget); }
                        catch (error) { observer.error?.(error, `new ${name}`); throw error; }
                            if (name === 'Instance') {
                                const captured = Renderer.capture(result);
                                observer.instantiated?.(captured, `new ${name}`);
                            } else observer.compiled?.(`new ${name}`);
                            return result;
                        },
                });
                    observer.installed?.(name, WASM[name]);
                } catch (error) { observer.error?.(error, `install ${name}`); }
            }
        }
        return { install };
    }
    createWasmHooks(Faults).install();
    Renderer.install();
})();

