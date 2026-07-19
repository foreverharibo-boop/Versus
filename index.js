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
let abortRequested = false;
let currentAbort = null;
let origFetch = null;

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

// ── Connection Profile ──

function getProfileSelector() {
    return document.querySelector('#connection_profiles');
}

function getProfileList() {
    const sel = getProfileSelector();
    if (!sel) return [];
    return Array.from(sel.options)
        .filter(o => o.value)
        .map(o => ({ value: o.value, name: o.text || o.value }));
}

function getCurrentProfileValue() {
    const sel = getProfileSelector();
    return sel ? sel.value : '';
}

async function switchProfile(profileValue) {
    const sel = getProfileSelector();
    if (!sel || profileValue == null) return;
    if (sel.value === profileValue) return;
    sel.value = profileValue;
    sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 500));
    document.querySelector('#update_connection_profile')?.click();
    await new Promise(r => setTimeout(r, 500));
}

function getCurrentCharName() {
    try {
        const context = getContext();
        if (context.name2) return context.name2;
    } catch {}
    return '';
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
    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) togglePanel();
    });

    const panel = document.createElement('div');
    panel.id = 'vs-panel';
    backdrop.appendChild(panel);

    document.documentElement.appendChild(backdrop);

    renderSetup();
}

function togglePanel() {
    panelOpen = !panelOpen;
    const backdrop = document.querySelector('#vs-backdrop');
    if (!backdrop) {
        console.error('[Versus] backdrop not found!');
        return;
    }
    if (panelOpen) {
        backdrop.style.cssText = `
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            background: rgba(0,0,0,0.5) !important;
            z-index: 999999 !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            text-shadow: none !important;
        `;
        const panel = document.querySelector('#vs-panel');
        if (panel) {
            panel.style.cssText = `
                width: 92vw !important;
                max-width: 580px !important;
                max-height: 80vh !important;
                background: var(--SmartThemeBlurTintColor, #fff) !important;
                color: var(--SmartThemeBodyColor, #222) !important;
                border-radius: 14px !important;
                box-shadow: 0 6px 32px rgba(0,0,0,0.25) !important;
                overflow-y: auto !important;
                overflow-x: hidden !important;
                text-shadow: none !important;
                -webkit-overflow-scrolling: touch;
            `;
        }
        populatePresets();
    } else {
        backdrop.style.cssText = 'display: none !important;';
    }
}

function populatePresets() {
    const presets = getPresetList();
    const profiles = getProfileList();
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

    ['#vs-profile-a', '#vs-profile-b'].forEach(id => {
        const sel = document.querySelector(id);
        if (!sel) return;
        sel.innerHTML = '<option value="">현재 프로필 유지</option>';
        profiles.forEach(p => {
            const o = document.createElement('option');
            o.value = p.value;
            o.textContent = p.name;
            sel.appendChild(o);
        });
    });

    const a = document.querySelector('#vs-sel-a');
    const b = document.querySelector('#vs-sel-b');
    const pa = document.querySelector('#vs-profile-a');
    const pb = document.querySelector('#vs-profile-b');
    if (a && settings.lastPresetA) a.value = settings.lastPresetA;
    if (b && settings.lastPresetB) b.value = settings.lastPresetB;
    if (pa && settings.lastProfileA) pa.value = settings.lastProfileA;
    if (pb && settings.lastProfileB) pb.value = settings.lastProfileB;
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
                    <select id="vs-profile-a" class="vs-sel vs-sel-profile"></select>
                </div>
                <div class="vs-preset-slot">
                    <span class="vs-slot-label">B</span>
                    <select id="vs-sel-b" class="vs-sel"></select>
                    <select id="vs-profile-b" class="vs-sel vs-sel-profile"></select>
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
                    <div class="vs-card-body" id="vs-body-a">${esc(data.responseA)}</div>
                    <div class="vs-card-foot">
                        <div class="vs-card-meta">
                            <span>${data.tokensA} tok</span>
                            <span>${data.timeA}s</span>
                        </div>
                        <button class="vs-btn-tiny vs-translate" data-target="a">번역</button>
                    </div>
                </div>
                <div class="vs-card">
                    <div class="vs-card-head">
                        <span class="vs-slot-label">B</span>
                        <span class="vs-card-name">${esc(data.presetBName)}</span>
                    </div>
                    <div class="vs-card-body" id="vs-body-b">${esc(data.responseBText)}</div>
                    <div class="vs-card-foot">
                        <div class="vs-card-meta">
                            <span>${data.tokensB} tok</span>
                            <span>${data.timeB}s</span>
                        </div>
                        <button class="vs-btn-tiny vs-translate" data-target="b">번역</button>
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

    // Translate buttons
    const originals = { a: data.responseA, b: data.responseBText };
    const translations = { a: null, b: null };
    const showing = { a: 'original', b: 'original' };

    panel.querySelectorAll('.vs-translate').forEach(btn => {
        btn.addEventListener('click', async () => {
            const t = btn.dataset.target;
            const bodyEl = panel.querySelector(`#vs-body-${t}`);
            if (!bodyEl) return;

            if (showing[t] === 'translated' && translations[t]) {
                bodyEl.textContent = originals[t];
                btn.textContent = '번역';
                showing[t] = 'original';
                return;
            }

            if (translations[t]) {
                bodyEl.textContent = translations[t];
                btn.textContent = '원문';
                showing[t] = 'translated';
                return;
            }

            btn.textContent = '번역 중…';
            btn.disabled = true;
            try {
                const translated = await generateQuietPrompt(
                    `Translate the following text. If it's in Korean, translate to English. If it's in English or another language, translate to Korean. Output ONLY the translation, nothing else:\n\n${originals[t]}`,
                    false, false
                );
                translations[t] = translated;
                bodyEl.textContent = translated;
                btn.textContent = '원문';
                btn.disabled = false;
                showing[t] = 'translated';
            } catch (err) {
                btn.textContent = '번역';
                btn.disabled = false;
                showToast('번역 실패: ' + (err.message || err));
            }
        });
    });
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
    const profileA = document.querySelector('#vs-profile-a');
    const profileB = document.querySelector('#vs-profile-b');
    const inputEl = document.querySelector('#vs-input');

    const presetAValue = selectA?.value;
    const presetBValue = selectB?.value;
    const profileAValue = profileA?.value || '';
    const profileBValue = profileB?.value || '';
    let userInput = inputEl?.value?.trim();

    if (!presetAValue || !presetBValue) { showToast('프리셋을 모두 선택해주세요.'); return; }
    if (presetAValue === presetBValue && profileAValue === profileBValue) {
        showToast('프리셋이나 프로필 중 하나는 다르게 선택해주세요.');
        return;
    }
    if (!userInput) {
        userInput = '(ooc : keep going)';
        if (inputEl) inputEl.value = userInput;
    }

    const presetAName = selectA.options[selectA.selectedIndex]?.text || presetAValue;
    const presetBName = selectB.options[selectB.selectedIndex]?.text || presetBValue;
    const profileAName = profileA?.options[profileA.selectedIndex]?.text || '';
    const profileBName = profileB?.options[profileB.selectedIndex]?.text || '';

    const settings = getSettings();
    settings.lastPresetA = presetAValue;
    settings.lastPresetB = presetBValue;
    settings.lastProfileA = profileAValue;
    settings.lastProfileB = profileBValue;
    saveSettingsDebounced();

    isGenerating = true;
    abortRequested = false;

    const btn = document.querySelector('#vs-start');
    if (btn) {
        btn.textContent = 'A 생성 중…';
        btn.classList.add('vs-btn-generating');
        btn.disabled = true;
    }

    let stopBtn = document.querySelector('#vs-stop');
    if (!stopBtn) {
        stopBtn = document.createElement('button');
        stopBtn.id = 'vs-stop';
        stopBtn.className = 'vs-btn vs-btn-stop vs-btn-full';
        stopBtn.textContent = '중지';
        btn?.parentNode?.insertBefore(stopBtn, btn.nextSibling);
    }
    stopBtn.style.display = '';
    stopBtn.disabled = false;
    stopBtn.textContent = '중지';
    stopBtn.onclick = () => {
        abortGeneration();
        stopBtn.textContent = '중지 중…';
        stopBtn.disabled = true;
    };

    const originalPreset = getCurrentPresetValue();
    const originalProfile = getCurrentProfileValue();

    try {
        // Generate A
        if (profileAValue) await switchProfile(profileAValue);
        await switchPreset(presetAValue);
        startFetchIntercept();
        const t0 = performance.now();
        const responseA = await generateQuietPrompt(userInput, false, false);
        stopFetchIntercept();
        const timeA = ((performance.now() - t0) / 1000).toFixed(1);
        const tokensA = getTokenCount(responseA);

        if (abortRequested) {
            await switchPreset(originalPreset);
            await switchProfile(originalProfile);
            showToast('비교가 중지되었습니다.');
            renderSetup();
            return;
        }

        // Generate B
        if (btn) btn.textContent = 'B 생성 중…';
        if (profileBValue) await switchProfile(profileBValue);
        await switchPreset(presetBValue);
        startFetchIntercept();
        const t1 = performance.now();
        const responseB = await generateQuietPrompt(userInput, false, false);
        stopFetchIntercept();
        const timeB = ((performance.now() - t1) / 1000).toFixed(1);
        const tokensB = getTokenCount(responseB);

        if (abortRequested) {
            await switchPreset(originalPreset);
            await switchProfile(originalProfile);
            showToast('비교가 중지되었습니다.');
            renderSetup();
            return;
        }

        // Restore
        await switchPreset(originalPreset);
        await switchProfile(originalProfile);

        const labelA = profileAName ? `${presetAName} · ${profileAName}` : presetAName;
        const labelB = profileBName ? `${presetBName} · ${profileBName}` : presetBName;

        renderResult({
            userInput, presetAValue, presetAName: labelA, presetBValue, presetBName: labelB,
            profileAValue, profileBValue,
            responseA, responseBText: responseB,
            timeA, timeB, tokensA, tokensB,
            charName: getCurrentCharName(),
            date: formatDate(new Date()),
        });
    } catch (err) {
        stopFetchIntercept();
        if (abortRequested) {
            showToast('비교가 중지되었습니다.');
        } else {
            console.error('[Versus]', err);
            showToast('생성 오류: ' + (err.message || err));
        }
        await switchPreset(originalPreset);
        await switchProfile(originalProfile);
        renderSetup();
    } finally {
        stopFetchIntercept();
        isGenerating = false;
        abortRequested = false;
        const s = document.querySelector('#vs-stop');
        if (s) s.style.display = 'none';
        if (btn) {
            btn.disabled = false;
            btn.textContent = '비교';
            btn.classList.remove('vs-btn-generating');
        }
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
