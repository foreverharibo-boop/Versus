import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, generateQuietPrompt, chat, addOneMessage, saveChatDebounced } from '../../../../script.js';

let oai_settings = null;
(async () => {
    try {
        const mod = await import('../../../openai.js');
        oai_settings = mod.oai_settings;
        console.log('[Versus] oai_settings loaded:', !!oai_settings);
    } catch (e) {
        console.log('[Versus] oai_settings import failed:', e);
    }
})();

const EXT_NAME = 'Versus';
const LABELS = ['A', 'B', 'C', 'D', 'E'];
const MAX_SLOTS = 5;
const MIN_SLOTS = 2;

const DEFAULT_SETTINGS = {
    history: [],
    slotCount: 2,
    lastSlots: [],
};

let isGenerating = false;
let panelOpen = false;
let abortRequested = false;
let currentAbort = null;
let origFetch = null;
let slotCount = 2;
const slotPromptOverrides = {}; // { 0: { 'main': true, 'jailbreak': false }, ... }

// ── Prompt Manager helpers ──

function getPromptEntriesFromSettings() {
    const entries = [];
    try {
        if (!oai_settings?.prompts) return entries;
        const promptOrder = oai_settings.prompt_order;

        // Get the active prompt order (try character-specific, then default)
        let activeOrder = null;
        if (Array.isArray(promptOrder)) {
            // Some ST versions: prompt_order is array of { character_id, order }
            const ctx = getContext();
            const charId = ctx?.characterId;
            const charEntry = promptOrder.find(p => p.character_id === charId);
            const defaultEntry = promptOrder.find(p => p.character_id === 'default');
            activeOrder = (charEntry || defaultEntry)?.order || [];
        }

        if (activeOrder && activeOrder.length > 0) {
            // Read from prompt_order (has enabled state + order)
            for (const item of activeOrder) {
                if (!item.identifier) continue;
                const prompt = oai_settings.prompts.find(p => p.identifier === item.identifier);
                entries.push({
                    id: item.identifier,
                    name: prompt?.name || item.identifier,
                    enabled: item.enabled !== false,
                    content: prompt?.content || getPromptContent(item.identifier),
                    isMarker: !!prompt?.marker,
                });
            }
        } else {
            // Fallback: just read prompts array
            for (const p of oai_settings.prompts) {
                if (p.marker) continue;
                entries.push({
                    id: p.identifier,
                    name: p.name || p.identifier,
                    enabled: true,
                    content: p.content || '',
                    isMarker: false,
                });
            }
        }
    } catch (err) {
        console.error('[Versus] Failed to read prompt entries:', err);
    }
    return entries.filter(e => !e.isMarker);
}

function getPromptEntries() {
    const entries = [];

    // Get enabled states from oai_settings.prompt_order
    const enabledMap = {};
    if (oai_settings?.prompt_order) {
        try {
            // Get DOM identifiers to find the best matching prompt_order entry
            const domIds = new Set(
                Array.from(document.querySelectorAll('[data-pm-identifier]'))
                    .map(el => el.dataset.pmIdentifier).filter(Boolean)
            );

            // Find the prompt_order entry that best matches current DOM
            let bestEntry = null;
            let bestCount = 0;
            for (const entry of oai_settings.prompt_order) {
                if (!Array.isArray(entry.order)) continue;
                const count = entry.order.filter(o => domIds.has(o.identifier)).length;
                if (count > bestCount) {
                    bestCount = count;
                    bestEntry = entry;
                }
            }

            if (bestEntry) {
                console.log(`[Versus] Using prompt_order char_id=${bestEntry.character_id}, items=${bestEntry.order.length}`);
                bestEntry.order.forEach(o => { enabledMap[o.identifier] = o.enabled !== false; });
            }
        } catch (e) {
            console.error('[Versus] prompt_order read error:', e);
        }
    }

    document.querySelectorAll('[data-pm-identifier]').forEach(item => {
        const id = item.dataset.pmIdentifier;
        if (!id) return;
        const nameEl = item.querySelector('.completion_prompt_manager_prompt_name')
            || item.querySelector('.prompt_manager_prompt_name')
            || item.querySelector('[data-pm-name]');
        const name = nameEl?.textContent?.trim() || id;
        const enabled = enabledMap.hasOwnProperty(id) ? enabledMap[id] : true;
        const content = getPromptContent(id);
        entries.push({ id, name, enabled, content });
    });

    const disabledCount = entries.filter(e => !e.enabled).length;
    console.log(`[Versus] Loaded ${entries.length} entries, ${disabledCount} disabled`);
    return entries;
}

function getPromptContent(identifier) {
    // Try oai_settings.prompts first
    if (oai_settings?.prompts) {
        const p = oai_settings.prompts.find(p => p.identifier === identifier);
        if (p?.content) return p.content;
    }
    // Try character card fields
    try {
        const ctx = getContext();
        const char = ctx.characters?.[ctx.characterId];
        if (char) {
            const map = {
                charDescription: char.description,
                charPersonality: char.personality,
                scenario: char.scenario,
                persona: char.persona,
                mesExamples: char.mes_example,
            };
            if (map[identifier]) return map[identifier];
        }
    } catch {}
    return '';
}

function capturePromptStates() {
    const states = {};
    document.querySelectorAll('[data-pm-identifier]').forEach(item => {
        const id = item.dataset.pmIdentifier;
        const toggle = item.querySelector('input[type="checkbox"]')
            || item.querySelector('.prompt-toggle')
            || item.querySelector('input');
        if (id && toggle) states[id] = toggle.checked;
    });
    return states;
}

function applyPromptOverrides(overrides) {
    if (!overrides) return;
    for (const [id, enabled] of Object.entries(overrides)) {
        const item = document.querySelector(`[data-pm-identifier="${id}"]`);
        if (!item) { console.log(`[Versus] prompt item not found: ${id}`); continue; }

        // Try multiple selectors for the toggle
        const toggle = item.querySelector('input[type="checkbox"]')
            || item.querySelector('.prompt-toggle')
            || item.querySelector('input');

        if (toggle && toggle.checked !== enabled) {
            toggle.click();
            console.log(`[Versus] toggled ${id}: ${!enabled} → ${enabled}`);
        } else if (!toggle) {
            console.log(`[Versus] no toggle found for ${id}`);
        }
    }
}

function startFetchIntercept() {
    currentAbort = new AbortController();
    origFetch = window.fetch;
    window.fetch = function (url, opts = {}) {
        return origFetch.call(this, url, { ...opts, signal: currentAbort.signal });
    };
}
function stopFetchIntercept() {
    if (origFetch) { window.fetch = origFetch; origFetch = null; }
    currentAbort = null;
}
function abortGeneration() {
    abortRequested = true;
    currentAbort?.abort();
}

function getSettings() {
    if (!extension_settings[EXT_NAME]) {
        extension_settings[EXT_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    return extension_settings[EXT_NAME];
}

// ── ST selectors ──

function getPresetSelector() {
    return document.querySelector('#settings_preset_openai') || document.querySelector('#settings_preset');
}
function getPresetList() {
    const sel = getPresetSelector();
    if (!sel) return [];
    return Array.from(sel.options).filter(o => o.value).map(o => ({ value: o.value, name: o.text || o.value }));
}
function getCurrentPresetValue() {
    const sel = getPresetSelector();
    return sel ? sel.value : '';
}
async function switchPreset(v) {
    const sel = getPresetSelector();
    if (!sel || sel.value === v) return;
    sel.value = v;
    sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 600));
}

function getProfileSelector() {
    return document.querySelector('#connection_profiles');
}
function getProfileList() {
    const sel = getProfileSelector();
    if (!sel) return [];
    return Array.from(sel.options).filter(o => o.value).map(o => ({ value: o.value, name: o.text || o.value }));
}
function getCurrentProfileValue() {
    const sel = getProfileSelector();
    return sel ? sel.value : '';
}
async function switchProfile(v) {
    const sel = getProfileSelector();
    if (!sel || v == null) return;
    if (sel.value === v) return;
    sel.value = v;
    sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 500));
    document.querySelector('#update_connection_profile')?.click();
    await new Promise(r => setTimeout(r, 500));
}

function getTokenCount(text) {
    try {
        const ctx = getContext();
        if (typeof ctx.getTokenCount === 'function') return ctx.getTokenCount(text);
    } catch {}
    return Math.ceil(text.length / 3);
}
function getCurrentCharName() {
    try { return getContext().name2 || ''; } catch {} return '';
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function truncate(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }
function formatDate(d) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${p(d.getMonth()+1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function showToast(msg) {
    document.querySelector('.vs-toast')?.remove();
    const t = document.createElement('div');
    t.className = 'vs-toast';
    t.textContent = msg;
    document.documentElement.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2500);
}

// ── UI ──

function buildUI() {
    const menuItem = document.createElement('div');
    menuItem.id = 'vs-wand-btn';
    menuItem.classList.add('list-group-item', 'flex-container', 'flexGap5');
    menuItem.title = 'Versus — 프리셋 A/B 비교';
    menuItem.innerHTML = '<span class="vs-wand-icon">VS</span><span>Versus</span>';
    menuItem.addEventListener('click', () => {
        togglePanel();
        document.querySelector('#extensionsMenu')?.classList.remove('show');
    });
    document.querySelector('#extensionsMenu')?.appendChild(menuItem);

    const backdrop = document.createElement('div');
    backdrop.id = 'vs-backdrop';
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) togglePanel(); });
    const panel = document.createElement('div');
    panel.id = 'vs-panel';
    backdrop.appendChild(panel);
    document.documentElement.appendChild(backdrop);

    const settings = getSettings();
    slotCount = settings.slotCount || 2;
    renderSetup();
}

function togglePanel() {
    panelOpen = !panelOpen;
    const backdrop = document.querySelector('#vs-backdrop');
    if (!backdrop) return;
    if (panelOpen) {
        backdrop.style.cssText = `
            position: fixed !important; top: 0 !important; left: 0 !important;
            width: 100vw !important; height: 100vh !important;
            background: rgba(0,0,0,0.5) !important; z-index: 999999 !important;
            display: flex !important; align-items: center !important; justify-content: center !important;
        `;
        const panel = document.querySelector('#vs-panel');
        if (panel) panel.style.cssText = `
            width: 92vw !important; max-width: 600px !important; max-height: 80vh !important;
            background: var(--SmartThemeBlurTintColor, #fff) !important;
            color: var(--SmartThemeBodyColor, #222) !important;
            border-radius: 14px !important; box-shadow: 0 6px 32px rgba(0,0,0,0.25) !important;
            overflow-y: auto !important; overflow-x: hidden !important; text-shadow: none !important;
        `;
        populatePresets();
    } else {
        backdrop.style.cssText = 'display: none !important;';
    }
}

function populatePresets() {
    const presets = getPresetList();
    const profiles = getProfileList();
    const settings = getSettings();
    const lastSlots = settings.lastSlots || [];

    for (let i = 0; i < slotCount; i++) {
        const sel = document.querySelector(`#vs-sel-${i}`);
        if (sel) {
            sel.innerHTML = '<option value="">선택</option>';
            presets.forEach(p => { const o = document.createElement('option'); o.value = p.value; o.textContent = p.name; sel.appendChild(o); });
            if (lastSlots[i]?.preset) sel.value = lastSlots[i].preset;
        }
        const prof = document.querySelector(`#vs-profile-${i}`);
        if (prof) {
            prof.innerHTML = '<option value="">현재 프로필 유지</option>';
            profiles.forEach(p => { const o = document.createElement('option'); o.value = p.value; o.textContent = p.name; prof.appendChild(o); });
            if (lastSlots[i]?.profile) prof.value = lastSlots[i].profile;
        }
    }
}

// ── Views ──

function renderSetup() {
    const panel = document.querySelector('#vs-panel');
    if (!panel) return;

    let slotsHTML = '';
    for (let i = 0; i < slotCount; i++) {
        const hasOverrides = slotPromptOverrides[i] && Object.keys(slotPromptOverrides[i]).length > 0;
        slotsHTML += `
            <div class="vs-preset-slot">
                <div class="vs-slot-top">
                    <span class="vs-slot-label">${LABELS[i]}</span>
                    <button class="vs-btn-tiny vs-prompt-cfg ${hasOverrides ? 'vs-has-overrides' : ''}" data-slot="${i}" title="프롬프트 설정">⚙</button>
                </div>
                <select id="vs-sel-${i}" class="vs-sel"></select>
                <select id="vs-profile-${i}" class="vs-sel vs-sel-profile"></select>
            </div>`;
    }

    panel.innerHTML = `
        <div class="vs-head">
            <span class="vs-head-title">Versus</span>
            <span class="vs-head-close" id="vs-close">✕</span>
        </div>
        <div class="vs-content">
            <div class="vs-slots">${slotsHTML}</div>
            <div class="vs-slot-controls">
                ${slotCount < MAX_SLOTS ? '<button class="vs-btn-tiny" id="vs-add-slot">+ 추가</button>' : ''}
                ${slotCount > MIN_SLOTS ? '<button class="vs-btn-tiny" id="vs-remove-slot">- 삭제</button>' : ''}
            </div>
            <textarea id="vs-input" class="vs-input" rows="3" placeholder="비워두면 (ooc : keep going) 자동 입력"></textarea>
            <button class="vs-btn vs-btn-primary vs-btn-full" id="vs-start">비교</button>
            <button class="vs-btn vs-btn-ghost" id="vs-show-history">히스토리</button>
        </div>
    `;
    populatePresets();
    panel.querySelector('#vs-close')?.addEventListener('click', togglePanel);
    panel.querySelector('#vs-start')?.addEventListener('click', startComparison);
    panel.querySelector('#vs-show-history')?.addEventListener('click', renderHistory);
    panel.querySelector('#vs-add-slot')?.addEventListener('click', () => {
        if (slotCount < MAX_SLOTS) { slotCount++; saveSlotCount(); renderSetup(); }
    });
    panel.querySelector('#vs-remove-slot')?.addEventListener('click', () => {
        if (slotCount > MIN_SLOTS) { slotCount--; delete slotPromptOverrides[slotCount]; saveSlotCount(); renderSetup(); }
    });
    panel.querySelectorAll('.vs-prompt-cfg').forEach(btn => {
        btn.addEventListener('click', async () => {
            const slotIdx = parseInt(btn.dataset.slot);
            const sel = document.querySelector(`#vs-sel-${slotIdx}`);
            if (!sel?.value) { showToast('먼저 프리셋을 선택해주세요.'); return; }
            await renderPromptConfig(slotIdx, sel.value, sel.options[sel.selectedIndex]?.text || '');
        });
    });
}

function saveSlotCount() {
    const settings = getSettings();
    settings.slotCount = slotCount;
    saveSettingsDebounced();
}

async function renderPromptConfig(slotIdx, presetValue, presetName) {
    const panel = document.querySelector('#vs-panel');
    if (!panel) return;

    // Show loading
    panel.innerHTML = `
        <div class="vs-head"><span class="vs-head-title">${LABELS[slotIdx]} 프롬프트 설정</span><span class="vs-head-close" id="vs-close">✕</span></div>
        <div class="vs-content"><div class="vs-empty">프롬프트 로딩 중…</div></div>
    `;
    panel.querySelector('#vs-close')?.addEventListener('click', togglePanel);

    // Switch to target preset to load its prompt config
    const originalPreset = getCurrentPresetValue();
    const needSwitch = originalPreset !== presetValue;

    if (needSwitch) {
        console.log(`[Versus] Switching ${originalPreset} → ${presetValue} to read prompts`);
        await switchPreset(presetValue);
        await new Promise(r => setTimeout(r, 1200));
    }

    // Read entries (from DOM + oai_settings.prompt_order)
    const entries = getPromptEntries();

    // Switch back immediately
    if (needSwitch) {
        console.log(`[Versus] Switching back to ${originalPreset}`);
        await switchPreset(originalPreset);
    }

    if (entries.length === 0) {
        showToast('프롬프트 항목을 찾을 수 없습니다.');
        renderSetup();
        return;
    }

    // Merge with existing overrides
    const overrides = slotPromptOverrides[slotIdx] || {};

    const itemsHTML = entries.map(e => {
        const checked = overrides.hasOwnProperty(e.id) ? overrides[e.id] : e.enabled;
        const isOverridden = overrides.hasOwnProperty(e.id) && overrides[e.id] !== e.enabled;
        const hasContent = e.content && e.content.trim().length > 0;
        const preview = hasContent ? esc(e.content.trim().slice(0, 200)) + (e.content.length > 200 ? '…' : '') : '';
        return `
            <div class="vs-prompt-item ${isOverridden ? 'vs-overridden' : ''}">
                <label class="vs-prompt-item-top">
                    <input type="checkbox" data-pm-id="${esc(e.id)}" ${checked ? 'checked' : ''}>
                    <span class="vs-prompt-name">${esc(e.name)}</span>
                    ${hasContent ? '<button class="vs-btn-tiny vs-prompt-expand" data-id="' + esc(e.id) + '">▼</button>' : ''}
                </label>
                ${hasContent ? '<div class="vs-prompt-preview" id="vs-preview-' + esc(e.id) + '" style="display:none;">' + preview + '</div>' : ''}
            </div>`;
    }).join('');

    panel.innerHTML = `
        <div class="vs-head">
            <span class="vs-head-title">${LABELS[slotIdx]} 프롬프트 설정</span>
            <span class="vs-head-close" id="vs-close">✕</span>
        </div>
        <div class="vs-content">
            <div class="vs-prompt-preset-name">${esc(presetName)}</div>
            <div class="vs-prompt-list">${itemsHTML}</div>
            <div class="vs-actions">
                <button class="vs-btn vs-btn-sub" id="vs-prompt-reset">초기화</button>
                <button class="vs-btn vs-btn-primary" id="vs-prompt-save">적용</button>
            </div>
            <button class="vs-btn vs-btn-ghost" id="vs-back">← 돌아가기</button>
        </div>
    `;

    panel.querySelector('#vs-close')?.addEventListener('click', togglePanel);
    panel.querySelector('#vs-back')?.addEventListener('click', renderSetup);
    panel.querySelector('#vs-prompt-reset')?.addEventListener('click', () => {
        delete slotPromptOverrides[slotIdx];
        showToast('초기화되었습니다.');
        renderSetup();
    });
    panel.querySelector('#vs-prompt-save')?.addEventListener('click', () => {
        const newOverrides = {};
        panel.querySelectorAll('.vs-prompt-item input[type="checkbox"]').forEach(cb => {
            const id = cb.dataset.pmId;
            const checked = cb.checked;
            const original = entries.find(e => e.id === id);
            if (original && checked !== original.enabled) {
                newOverrides[id] = checked;
            }
        });
        if (Object.keys(newOverrides).length > 0) {
            slotPromptOverrides[slotIdx] = newOverrides;
        } else {
            delete slotPromptOverrides[slotIdx];
        }
        showToast('적용되었습니다.');
        renderSetup();
    });

    // Expand/collapse content preview
    panel.querySelectorAll('.vs-prompt-expand').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const id = btn.dataset.id;
            const preview = panel.querySelector(`#vs-preview-${id}`);
            if (preview) {
                const showing = preview.style.display !== 'none';
                preview.style.display = showing ? 'none' : 'block';
                btn.textContent = showing ? '▼' : '▲';
            }
        });
    });
}

function renderResult(data) {
    const panel = document.querySelector('#vs-panel');
    if (!panel) return;

    const cardsHTML = data.results.map((r, i) => `
        <div class="vs-card">
            <div class="vs-card-head">
                <span class="vs-slot-label">${esc(r.label)}</span>
                <span class="vs-card-name">${esc(r.displayName)}</span>
            </div>
            <div class="vs-card-body" id="vs-body-${i}">${esc(r.response)}</div>
            <div class="vs-card-foot">
                <div class="vs-card-meta">
                    <span>${r.tokens} tok</span>
                    <span>${r.time}s</span>
                </div>
                <div class="vs-card-btns">
                    <button class="vs-btn-tiny vs-translate" data-idx="${i}">번역</button>
                    <button class="vs-btn-tiny vs-insert" data-idx="${i}">삽입</button>
                </div>
            </div>
        </div>
    `).join('');

    panel.innerHTML = `
        <div class="vs-head">
            <span class="vs-head-title">비교 결과</span>
            <span class="vs-head-close" id="vs-close">✕</span>
        </div>
        <div class="vs-content">
            <div class="vs-input-echo">${esc(data.userInput)}</div>
            <div class="vs-compare">${cardsHTML}</div>
            <div class="vs-actions">
                <button class="vs-btn vs-btn-sub" id="vs-retry">다시 비교</button>
                <button class="vs-btn vs-btn-primary" id="vs-save">저장</button>
            </div>
            <button class="vs-btn vs-btn-ghost" id="vs-back">← 돌아가기</button>
        </div>
    `;

    panel.querySelector('#vs-close')?.addEventListener('click', togglePanel);
    panel.querySelector('#vs-retry')?.addEventListener('click', () => { renderSetup(); startComparison(); });
    panel.querySelector('#vs-save')?.addEventListener('click', () => {
        saveToHistory(data);
        const btn = panel.querySelector('#vs-save');
        if (btn) { btn.textContent = '저장됨'; btn.disabled = true; }
    });
    panel.querySelector('#vs-back')?.addEventListener('click', renderSetup);

    // Insert buttons
    panel.querySelectorAll('.vs-insert').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.idx);
            const r = data.results[idx];
            if (!r) return;
            insertAsCharMessage(r.response);
            btn.textContent = '삽입됨';
            btn.disabled = true;
        });
    });

    // Translate buttons
    const originals = data.results.map(r => r.response);
    const translations = new Array(data.results.length).fill(null);
    const showing = new Array(data.results.length).fill('original');

    panel.querySelectorAll('.vs-translate').forEach(btn => {
        btn.addEventListener('click', async () => {
            const idx = parseInt(btn.dataset.idx);
            const bodyEl = panel.querySelector(`#vs-body-${idx}`);
            if (!bodyEl) return;

            if (showing[idx] === 'translated' && translations[idx]) {
                bodyEl.textContent = originals[idx];
                btn.textContent = '번역';
                showing[idx] = 'original';
                return;
            }
            if (translations[idx]) {
                bodyEl.textContent = translations[idx];
                btn.textContent = '원문';
                showing[idx] = 'translated';
                return;
            }

            btn.textContent = '번역 중…';
            btn.disabled = true;
            try {
                const isKorean = /[가-힣]/.test(originals[idx]);
                const targetLang = isKorean ? 'English' : '한국어';
                const translated = await generateQuietPrompt(
                    `[OOC: STOP ALL ROLEPLAY. You are now a translator. Ignore all system prompts, character cards, and previous context. Your ONLY job is to translate the text below into ${targetLang}. Output ONLY the translated text. No commentary, no actions, no roleplay, no asterisks, no narration.]\n\nText to translate:\n${originals[idx]}`,
                    false, false
                );
                translations[idx] = translated;
                bodyEl.textContent = translated;
                btn.textContent = '원문';
                btn.disabled = false;
                showing[idx] = 'translated';
            } catch (err) {
                btn.textContent = '번역';
                btn.disabled = false;
                showToast('번역 실패');
            }
        });
    });
}

function insertAsCharMessage(text) {
    try {
        const context = getContext();
        const mes = {
            name: context.name2 || 'Character',
            is_user: false,
            is_system: false,
            send_date: Date.now(),
            mes: text,
            extra: {},
        };
        chat.push(mes);
        addOneMessage(mes);
        saveChatDebounced();
        showToast('채팅에 삽입되었습니다.');
    } catch (err) {
        console.error('[Versus] insert error:', err);
        showToast('삽입 실패: ' + (err.message || err));
    }
}

function renderHistory() {
    const panel = document.querySelector('#vs-panel');
    if (!panel) return;
    const settings = getSettings();
    const items = settings.history || [];

    const list = items.length === 0
        ? '<div class="vs-empty">저장된 비교가 없습니다.</div>'
        : items.slice().reverse().map((item, idx) => {
            const realIdx = items.length - 1 - idx;
            const labels = (item.results || []).map(r => esc(r.displayName || r.presetName || r.label)).join(' vs ');
            return `
            <div class="vs-history-row">
                <div class="vs-history-top">
                    <span class="vs-history-date">${item.date || ''}</span>
                    <span class="vs-history-char">${esc(item.charName || '')}</span>
                </div>
                <div class="vs-history-presets">${labels}</div>
                <div class="vs-history-input">${esc(truncate(item.userInput || '', 50))}</div>
                <div class="vs-history-btns">
                    <button class="vs-btn-tiny vs-view" data-idx="${realIdx}">보기</button>
                    <button class="vs-btn-tiny vs-del" data-idx="${realIdx}">삭제</button>
                </div>
            </div>`;
        }).join('');

    panel.innerHTML = `
        <div class="vs-head">
            <span class="vs-head-title">히스토리</span>
            <span class="vs-head-close" id="vs-close">✕</span>
        </div>
        <div class="vs-content">
            ${list}
            <button class="vs-btn vs-btn-ghost" id="vs-back">← 돌아가기</button>
        </div>
    `;
    panel.querySelector('#vs-close')?.addEventListener('click', togglePanel);
    panel.querySelector('#vs-back')?.addEventListener('click', renderSetup);
    panel.querySelectorAll('.vs-view').forEach(b => b.addEventListener('click', () => {
        const item = settings.history[parseInt(b.dataset.idx)];
        if (item) renderResult(item);
    }));
    panel.querySelectorAll('.vs-del').forEach(b => b.addEventListener('click', () => {
        settings.history.splice(parseInt(b.dataset.idx), 1);
        saveSettingsDebounced();
        renderHistory();
    }));
}

// ── Core ──

async function startComparison() {
    if (isGenerating) return;

    const inputEl = document.querySelector('#vs-input');
    let userInput = inputEl?.value?.trim();

    // Collect slots
    const slots = [];
    for (let i = 0; i < slotCount; i++) {
        const sel = document.querySelector(`#vs-sel-${i}`);
        const prof = document.querySelector(`#vs-profile-${i}`);
        if (!sel?.value) { showToast(`${LABELS[i]} 프리셋을 선택해주세요.`); return; }
        const presetName = sel.options[sel.selectedIndex]?.text || sel.value;
        const profileName = prof?.options[prof.selectedIndex]?.text || '';
        slots.push({
            label: LABELS[i],
            presetValue: sel.value,
            presetName,
            profileValue: prof?.value || '',
            profileName,
            displayName: prof?.value ? `${presetName} · ${profileName}` : presetName,
        });
    }

    if (!userInput) {
        userInput = '(ooc : keep going)';
        if (inputEl) inputEl.value = userInput;
    }

    // Save last used
    const settings = getSettings();
    settings.lastSlots = slots.map(s => ({ preset: s.presetValue, profile: s.profileValue }));
    saveSettingsDebounced();

    isGenerating = true;
    abortRequested = false;

    const btn = document.querySelector('#vs-start');
    if (btn) { btn.textContent = `${LABELS[0]} 생성 중…`; btn.disabled = true; }

    let stopBtn = document.querySelector('#vs-stop');
    if (!stopBtn) {
        stopBtn = document.createElement('button');
        stopBtn.id = 'vs-stop';
        stopBtn.className = 'vs-btn vs-btn-stop vs-btn-full';
        btn?.parentNode?.insertBefore(stopBtn, btn.nextSibling);
    }
    stopBtn.style.display = '';
    stopBtn.disabled = false;
    stopBtn.textContent = '중지';
    stopBtn.onclick = () => { abortGeneration(); stopBtn.textContent = '중지 중…'; stopBtn.disabled = true; };

    const originalPreset = getCurrentPresetValue();
    const originalProfile = getCurrentProfileValue();
    const results = [];

    try {
        for (let i = 0; i < slots.length; i++) {
            if (abortRequested) break;
            if (btn) btn.textContent = `${slots[i].label} 생성 중…`;

            if (slots[i].profileValue) await switchProfile(slots[i].profileValue);
            await switchPreset(slots[i].presetValue);

            // Apply prompt overrides for this slot
            const savedStates = capturePromptStates();
            if (slotPromptOverrides[i]) {
                console.log(`[Versus] Slot ${LABELS[i]} applying overrides:`, slotPromptOverrides[i]);
                console.log(`[Versus] Saved states before override:`, savedStates);
            }
            applyPromptOverrides(slotPromptOverrides[i]);

            startFetchIntercept();
            const t = performance.now();
            const response = await generateQuietPrompt(userInput, false, false);
            stopFetchIntercept();

            // Restore prompt states
            applyPromptOverrides(savedStates);

            results.push({
                ...slots[i],
                response,
                time: ((performance.now() - t) / 1000).toFixed(1),
                tokens: getTokenCount(response),
            });
        }

        await switchPreset(originalPreset);
        await switchProfile(originalProfile);

        if (abortRequested) {
            showToast('비교가 중지되었습니다.');
            renderSetup();
        } else {
            renderResult({
                userInput,
                results,
                charName: getCurrentCharName(),
                date: formatDate(new Date()),
            });
        }
    } catch (err) {
        stopFetchIntercept();
        await switchPreset(originalPreset);
        await switchProfile(originalProfile);
        if (abortRequested) {
            showToast('비교가 중지되었습니다.');
        } else {
            console.error('[Versus]', err);
            showToast('생성 오류: ' + (err.message || err));
        }
        renderSetup();
    } finally {
        stopFetchIntercept();
        isGenerating = false;
        abortRequested = false;
        const s = document.querySelector('#vs-stop');
        if (s) s.style.display = 'none';
        if (btn) { btn.disabled = false; btn.textContent = '비교'; }
    }
}

function saveToHistory(data) {
    const settings = getSettings();
    if (!settings.history) settings.history = [];
    settings.history.push({ ...data });
    if (settings.history.length > 50) settings.history = settings.history.slice(-50);
    saveSettingsDebounced();
}

jQuery(() => {
    getSettings();
    buildUI();
    console.log('[Versus] loaded');
});
