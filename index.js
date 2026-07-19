import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, generateQuietPrompt } from '../../../../script.js';

const EXT_NAME = 'Versus';
const DEFAULT_SETTINGS = {
    history: [],
    lastPresetA: '',
    lastPresetB: '',
};

let isGenerating = false;
let panelOpen = false;

function getSettings() {
    if (!extension_settings[EXT_NAME]) {
        extension_settings[EXT_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    return extension_settings[EXT_NAME];
}

function getPresetSelector() {
    return document.querySelector('#settings_preset_openai')
        || document.querySelector('#settings_preset');
}

function getPresetList() {
    const sel = getPresetSelector();
    if (!sel) return [];
    return Array.from(sel.options)
        .filter(o => o.value)
        .map(o => ({ value: o.value, name: o.text || o.value }));
}

function getCurrentPresetValue() {
    const sel = getPresetSelector();
    return sel ? sel.value : '';
}

async function switchPreset(presetValue) {
    const sel = getPresetSelector();
    if (!sel || sel.value === presetValue) return;
    sel.value = presetValue;
    sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 600));
}

function getCurrentCharName() {
    try {
        const context = getContext();
        if (context.name2) return context.name2;
    } catch {}
    return '';
}

async function generateWithUsage(userInput) {
    let usage = null;
    const origFetch = window.fetch;

    window.fetch = async function (...args) {
        const res = await origFetch.apply(this, args);
        try {
            const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
            if (url.includes('/generate') || url.includes('/chat/completions') || url.includes('/v1/') || url.includes('/api/')) {
                const clone = res.clone();
                const text = await clone.text();
                const matches = [...text.matchAll(/"prompt_tokens"\s*:\s*(\d+)/g)];
                const compMatches = [...text.matchAll(/"completion_tokens"\s*:\s*(\d+)/g)];
                if (matches.length > 0 && compMatches.length > 0) {
                    usage = {
                        prompt: parseInt(matches[matches.length - 1][1]),
                        completion: parseInt(compMatches[compMatches.length - 1][1]),
                    };
                }
            }
        } catch {}
        return res;
    };

    try {
        const response = await generateQuietPrompt(userInput, false, false);
        const fallbackTokens = getTokenCount(response);
        return { text: response, usage, fallbackTokens };
    } finally {
        window.fetch = origFetch;
    }
}

function getTokenCount(text) {
    try {
        const context = getContext();
        if (typeof context.getTokenCount === 'function') {
            return context.getTokenCount(text);
        }
    } catch {}
    return Math.ceil(text.length / 3);
}

function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

function truncate(str, len) {
    return str.length > len ? str.slice(0, len) + '…' : str;
}

function formatDate(d) {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${pad(d.getMonth()+1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatUsage(usage, fallback) {
    if (usage && usage.prompt != null && usage.completion != null) {
        const total = usage.prompt + usage.completion;
        return `<span title="입력 ${usage.prompt} + 출력 ${usage.completion}">${total} tok</span>`;
    }
    if (fallback != null) {
        return `<span title="출력 토큰 (추정)">~${fallback} tok</span>`;
    }
    return '<span>— tok</span>';
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
    // Wand menu item
    const menuItem = document.createElement('div');
    menuItem.id = 'vs-wand-btn';
    menuItem.classList.add('list-group-item', 'flex-container', 'flexGap5');
    menuItem.title = 'Versus — 프리셋 A/B 비교';
    menuItem.innerHTML = '<span class="vs-wand-icon">VS</span><span>Versus</span>';
    menuItem.addEventListener('click', () => {
        togglePanel();
        document.querySelector('#extensionsMenu')?.classList.remove('show');
    });
    const wand = document.querySelector('#extensionsMenu');
    if (wand) {
        wand.appendChild(menuItem);
    }

    const backdrop = document.createElement('div');
    backdrop.id = 'vs-backdrop';
    backdrop.addEventListener('click', togglePanel);
    document.documentElement.appendChild(backdrop);

    const panel = document.createElement('div');
    panel.id = 'vs-panel';
    document.documentElement.appendChild(panel);

    renderSetup();
}

function togglePanel() {
    panelOpen = !panelOpen;
    const panel = document.querySelector('#vs-panel');
    const backdrop = document.querySelector('#vs-backdrop');
    if (panelOpen) {
        panel?.classList.add('open');
        backdrop?.classList.add('open');
        populatePresets();
    } else {
        panel?.classList.remove('open');
        backdrop?.classList.remove('open');
    }
}

function populatePresets() {
    const presets = getPresetList();
    const settings = getSettings();
    ['#vs-sel-a', '#vs-sel-b'].forEach(id => {
        const sel = document.querySelector(id);
        if (!sel) return;
        sel.innerHTML = '<option value="">선택</option>';
        presets.forEach(p => {
            const o = document.createElement('option');
            o.value = p.value;
            o.textContent = p.name;
            sel.appendChild(o);
        });
    });
    const a = document.querySelector('#vs-sel-a');
    const b = document.querySelector('#vs-sel-b');
    if (a && settings.lastPresetA) a.value = settings.lastPresetA;
    if (b && settings.lastPresetB) b.value = settings.lastPresetB;
}

// ── Views ──

function renderSetup() {
    const panel = document.querySelector('#vs-panel');
    if (!panel) return;
    panel.innerHTML = `
        <div class="vs-head">
            <span class="vs-head-title">Versus</span>
            <span class="vs-head-close" id="vs-close">✕</span>
        </div>
        <div class="vs-content">
            <div class="vs-row">
                <div class="vs-preset-slot">
                    <span class="vs-slot-label">A</span>
                    <select id="vs-sel-a" class="vs-sel"></select>
                </div>
                <div class="vs-preset-slot">
                    <span class="vs-slot-label">B</span>
                    <select id="vs-sel-b" class="vs-sel"></select>
                </div>
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
}

function renderResult(data) {
    const panel = document.querySelector('#vs-panel');
    if (!panel) return;
    panel.innerHTML = `
        <div class="vs-head">
            <span class="vs-head-title">비교 결과</span>
            <span class="vs-head-close" id="vs-close">✕</span>
        </div>
        <div class="vs-content">
            <div class="vs-input-echo">${esc(data.userInput)}</div>
            <div class="vs-compare">
                <div class="vs-card">
                    <div class="vs-card-head">
                        <span class="vs-slot-label">A</span>
                        <span class="vs-card-name">${esc(data.presetAName)}</span>
                    </div>
                    <div class="vs-card-body">${esc(data.responseA)}</div>
                    <div class="vs-card-meta">
                        ${formatUsage(data.usageA, data.fallbackTokensA)}
                        <span>${data.timeA}s</span>
                    </div>
                </div>
                <div class="vs-card">
                    <div class="vs-card-head">
                        <span class="vs-slot-label">B</span>
                        <span class="vs-card-name">${esc(data.presetBName)}</span>
                    </div>
                    <div class="vs-card-body">${esc(data.responseBText)}</div>
                    <div class="vs-card-meta">
                        ${formatUsage(data.usageB, data.fallbackTokensB)}
                        <span>${data.timeB}s</span>
                    </div>
                </div>
            </div>
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
            return `
            <div class="vs-history-row" data-idx="${realIdx}">
                <div class="vs-history-top">
                    <span class="vs-history-date">${item.date || ''}</span>
                    <span class="vs-history-char">${esc(item.charName || '')}</span>
                </div>
                <div class="vs-history-presets">
                    <span class="vs-history-tag">${esc(item.presetAName || '')}</span>
                    <span class="vs-history-vs">vs</span>
                    <span class="vs-history-tag">${esc(item.presetBName || '')}</span>
                </div>
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

    const selectA = document.querySelector('#vs-sel-a');
    const selectB = document.querySelector('#vs-sel-b');
    const inputEl = document.querySelector('#vs-input');

    const presetAValue = selectA?.value;
    const presetBValue = selectB?.value;
    let userInput = inputEl?.value?.trim();

    if (!presetAValue || !presetBValue) { showToast('프리셋을 모두 선택해주세요.'); return; }
    if (presetAValue === presetBValue) { showToast('서로 다른 프리셋을 선택해주세요.'); return; }
    if (!userInput) {
        userInput = '(ooc : keep going)';
        if (inputEl) inputEl.value = userInput;
    }

    const presetAName = selectA.options[selectA.selectedIndex]?.text || presetAValue;
    const presetBName = selectB.options[selectB.selectedIndex]?.text || presetBValue;

    const settings = getSettings();
    settings.lastPresetA = presetAValue;
    settings.lastPresetB = presetBValue;
    saveSettingsDebounced();

    isGenerating = true;
    const btn = document.querySelector('#vs-start');
    if (btn) { btn.disabled = true; btn.textContent = 'A 생성 중…'; }

    const originalPreset = getCurrentPresetValue();

    try {
        await switchPreset(presetAValue);
        const t0 = performance.now();
        const resultA = await generateWithUsage(userInput);
        const timeA = ((performance.now() - t0) / 1000).toFixed(1);

        if (btn) btn.textContent = 'B 생성 중…';

        await switchPreset(presetBValue);
        const t1 = performance.now();
        const resultB = await generateWithUsage(userInput);
        const timeB = ((performance.now() - t1) / 1000).toFixed(1);

        await switchPreset(originalPreset);

        renderResult({
            userInput, presetAValue, presetAName, presetBValue, presetBName,
            responseA: resultA.text, responseBText: resultB.text,
            timeA, timeB,
            usageA: resultA.usage, usageB: resultB.usage,
            fallbackTokensA: resultA.fallbackTokens, fallbackTokensB: resultB.fallbackTokens,
            charName: getCurrentCharName(),
            date: formatDate(new Date()),
        });
    } catch (err) {
        console.error('[Versus]', err);
        showToast('생성 오류: ' + (err.message || err));
        await switchPreset(originalPreset);
        renderSetup();
    } finally {
        isGenerating = false;
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
