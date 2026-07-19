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
let currentView = 'setup'; // 'setup' | 'result' | 'history'

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

function getTokenCount(text) {
    try {
        const context = getContext();
        if (typeof context.getTokenCount === 'function') {
            return context.getTokenCount(text);
        }
    } catch {}
    return Math.ceil(text.length / 3);
}

function getCurrentCharName() {
    try {
        const context = getContext();
        if (context.name2) return context.name2;
        if (context.characters && context.characterId !== undefined) {
            const char = context.characters[context.characterId];
            if (char) return char.name || '';
        }
    } catch {}
    return '';
}

function getLastUserMessage() {
    try {
        const context = getContext();
        const chat = context.chat;
        if (!chat || !chat.length) return '';
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i].is_user) return chat[i].mes || '';
        }
    } catch {}
    return '';
}

function buildUI() {
    // FAB button
    const fab = document.createElement('div');
    fab.id = 'versus-fab';
    fab.innerHTML = 'VS';
    fab.title = 'Versus — 프리셋 A/B 비교';
    fab.addEventListener('click', togglePanel);

    const leftSend = document.querySelector('#leftSendForm');
    if (leftSend) {
        leftSend.appendChild(fab);
    } else {
        document.body.appendChild(fab);
    }

    // Panel
    const panel = document.createElement('div');
    panel.id = 'versus-panel';
    panel.innerHTML = buildSetupHTML();
    document.documentElement.appendChild(panel);

    // Backdrop
    const backdrop = document.createElement('div');
    backdrop.id = 'versus-backdrop';
    backdrop.addEventListener('click', togglePanel);
    document.documentElement.appendChild(backdrop);
}

function buildSetupHTML() {
    const settings = getSettings();
    return `
        <div class="versus-header">
            <span class="versus-title">
                <span class="versus-logo">VS</span>
                Versus
            </span>
            <div class="versus-close" id="versus-close">✕</div>
        </div>
        <div class="versus-body" id="versus-body">
            <div class="versus-setup" id="versus-setup">
                <div class="versus-preset-box versus-a">
                    <div class="versus-preset-label">
                        <span class="versus-badge versus-badge-a">A</span>
                        프리셋 선택
                    </div>
                    <select id="versus-select-a" class="versus-select"></select>
                </div>
                <div class="versus-vs-divider">VS</div>
                <div class="versus-preset-box versus-b">
                    <div class="versus-preset-label">
                        <span class="versus-badge versus-badge-b">B</span>
                        프리셋 선택
                    </div>
                    <select id="versus-select-b" class="versus-select"></select>
                </div>
                <div class="versus-input-section">
                    <div class="versus-input-row">
                        <textarea id="versus-input" class="versus-textarea" placeholder="비교할 메시지를 입력하세요..." rows="3"></textarea>
                    </div>
                    <button class="versus-btn-lastmsg" id="versus-use-last">마지막 메시지 가져오기</button>
                </div>
                <button class="versus-btn-start" id="versus-start">
                    ▶ 맞짱 시작
                </button>
                <button class="versus-btn-history" id="versus-show-history">
                    📋 비교 히스토리
                </button>
            </div>
            <div class="versus-result" id="versus-result" style="display:none;"></div>
            <div class="versus-history" id="versus-history" style="display:none;"></div>
        </div>
    `;
}

function populatePresets() {
    const presets = getPresetList();
    const selectA = document.querySelector('#versus-select-a');
    const selectB = document.querySelector('#versus-select-b');
    if (!selectA || !selectB) return;

    const settings = getSettings();

    [selectA, selectB].forEach(sel => {
        sel.innerHTML = '<option value="">-- 선택 --</option>';
        presets.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.value;
            opt.textContent = p.name;
            sel.appendChild(opt);
        });
    });

    if (settings.lastPresetA) selectA.value = settings.lastPresetA;
    if (settings.lastPresetB) selectB.value = settings.lastPresetB;
}

function togglePanel() {
    panelOpen = !panelOpen;
    const panel = document.querySelector('#versus-panel');
    const backdrop = document.querySelector('#versus-backdrop');
    if (!panel || !backdrop) return;

    if (panelOpen) {
        panel.classList.add('open');
        backdrop.classList.add('open');
        populatePresets();
        showSetup();
    } else {
        panel.classList.remove('open');
        backdrop.classList.remove('open');
    }
}

function showSetup() {
    currentView = 'setup';
    const setup = document.querySelector('#versus-setup');
    const result = document.querySelector('#versus-result');
    const history = document.querySelector('#versus-history');
    if (setup) setup.style.display = '';
    if (result) result.style.display = 'none';
    if (history) history.style.display = 'none';
}

function showResult(data) {
    currentView = 'result';
    const setup = document.querySelector('#versus-setup');
    const result = document.querySelector('#versus-result');
    const history = document.querySelector('#versus-history');
    if (setup) setup.style.display = 'none';
    if (history) history.style.display = 'none';
    if (!result) return;

    result.style.display = '';
    result.innerHTML = `
        <div class="versus-result-header">비교 결과</div>
        <div class="versus-result-input">
            <span class="versus-result-input-label">입력:</span>
            <span class="versus-result-input-text">${escapeHtml(data.userInput)}</span>
        </div>
        <div class="versus-result-card versus-a">
            <div class="versus-result-card-header">
                <span class="versus-badge versus-badge-a">A</span>
                <span class="versus-result-preset-name">${escapeHtml(data.presetAName)}</span>
            </div>
            <div class="versus-result-card-body">${escapeHtml(data.responseA)}</div>
            <div class="versus-result-meta">
                <span class="versus-meta-item versus-meta-a">📊 ${data.tokensA} 토큰</span>
                <span class="versus-meta-item versus-meta-a">⏱ ${data.timeA}초</span>
            </div>
        </div>
        <div class="versus-result-card versus-b">
            <div class="versus-result-card-header">
                <span class="versus-badge versus-badge-b">B</span>
                <span class="versus-result-preset-name">${escapeHtml(data.presetBName)}</span>
            </div>
            <div class="versus-result-card-body">${escapeHtml(data.responseBText)}</div>
            <div class="versus-result-meta">
                <span class="versus-meta-item versus-meta-b">📊 ${data.tokensB} 토큰</span>
                <span class="versus-meta-item versus-meta-b">⏱ ${data.timeB}초</span>
            </div>
        </div>
        <div class="versus-result-actions">
            <button class="versus-btn-action" id="versus-retry">🔄 다시 돌리기</button>
            <button class="versus-btn-action" id="versus-save-result">💾 히스토리 저장</button>
        </div>
        <button class="versus-btn-back" id="versus-back-setup">← 돌아가기</button>
    `;

    document.querySelector('#versus-retry')?.addEventListener('click', () => {
        showSetup();
        startComparison();
    });
    document.querySelector('#versus-save-result')?.addEventListener('click', () => {
        saveToHistory(data);
        const btn = document.querySelector('#versus-save-result');
        if (btn) {
            btn.textContent = '✅ 저장 완료';
            btn.disabled = true;
        }
    });
    document.querySelector('#versus-back-setup')?.addEventListener('click', showSetup);
}

function showHistory() {
    currentView = 'history';
    const setup = document.querySelector('#versus-setup');
    const result = document.querySelector('#versus-result');
    const history = document.querySelector('#versus-history');
    if (setup) setup.style.display = 'none';
    if (result) result.style.display = 'none';
    if (!history) return;

    const settings = getSettings();
    const items = settings.history || [];

    history.style.display = '';

    if (items.length === 0) {
        history.innerHTML = `
            <div class="versus-result-header">비교 히스토리</div>
            <div class="versus-history-empty">저장된 비교가 없습니다.</div>
            <button class="versus-btn-back" id="versus-back-from-history">← 돌아가기</button>
        `;
    } else {
        const itemsHTML = items.slice().reverse().map((item, idx) => `
            <div class="versus-history-item" data-idx="${items.length - 1 - idx}">
                <div class="versus-history-item-top">
                    <span class="versus-history-date">${item.date || ''}</span>
                    <span class="versus-history-char">${escapeHtml(item.charName || '')}</span>
                </div>
                <div class="versus-history-item-presets">
                    <span class="versus-history-preset-tag versus-tag-a">${escapeHtml(item.presetAName || '')}</span>
                    <span class="versus-history-vs">vs</span>
                    <span class="versus-history-preset-tag versus-tag-b">${escapeHtml(item.presetBName || '')}</span>
                </div>
                <div class="versus-history-input">${escapeHtml(truncate(item.userInput || '', 60))}</div>
                <div class="versus-history-actions">
                    <button class="versus-btn-view-detail" data-idx="${items.length - 1 - idx}">자세히 보기</button>
                    <button class="versus-btn-delete-item" data-idx="${items.length - 1 - idx}">삭제</button>
                </div>
            </div>
        `).join('');

        history.innerHTML = `
            <div class="versus-result-header">비교 히스토리</div>
            <div class="versus-history-list">${itemsHTML}</div>
            <button class="versus-btn-back" id="versus-back-from-history">← 돌아가기</button>
        `;

        history.querySelectorAll('.versus-btn-view-detail').forEach(btn => {
            btn.addEventListener('click', () => {
                const i = parseInt(btn.dataset.idx);
                const item = settings.history[i];
                if (item) showResult(item);
            });
        });

        history.querySelectorAll('.versus-btn-delete-item').forEach(btn => {
            btn.addEventListener('click', () => {
                const i = parseInt(btn.dataset.idx);
                settings.history.splice(i, 1);
                saveSettingsDebounced();
                showHistory();
            });
        });
    }

    document.querySelector('#versus-back-from-history')?.addEventListener('click', showSetup);
}

async function startComparison() {
    if (isGenerating) return;

    const selectA = document.querySelector('#versus-select-a');
    const selectB = document.querySelector('#versus-select-b');
    const inputEl = document.querySelector('#versus-input');

    const presetAValue = selectA?.value;
    const presetBValue = selectB?.value;
    const userInput = inputEl?.value?.trim();

    if (!presetAValue || !presetBValue) {
        showToast('프리셋 A와 B를 모두 선택해주세요.');
        return;
    }
    if (presetAValue === presetBValue) {
        showToast('서로 다른 프리셋을 선택해주세요.');
        return;
    }
    if (!userInput) {
        showToast('비교할 메시지를 입력해주세요.');
        return;
    }

    const presetAName = selectA.options[selectA.selectedIndex]?.text || presetAValue;
    const presetBName = selectB.options[selectB.selectedIndex]?.text || presetBValue;

    // Save last used
    const settings = getSettings();
    settings.lastPresetA = presetAValue;
    settings.lastPresetB = presetBValue;
    saveSettingsDebounced();

    isGenerating = true;
    const startBtn = document.querySelector('#versus-start');
    if (startBtn) {
        startBtn.disabled = true;
        startBtn.textContent = '⏳ A 생성 중...';
    }

    const originalPreset = getCurrentPresetValue();

    try {
        // Generate with Preset A
        await switchPreset(presetAValue);
        const startA = performance.now();
        const responseA = await generateQuietPrompt(userInput, false, false);
        const timeA = ((performance.now() - startA) / 1000).toFixed(1);
        const tokensA = getTokenCount(responseA);

        if (startBtn) startBtn.textContent = '⏳ B 생성 중...';

        // Generate with Preset B
        await switchPreset(presetBValue);
        const startB = performance.now();
        const responseB = await generateQuietPrompt(userInput, false, false);
        const timeB = ((performance.now() - startB) / 1000).toFixed(1);
        const tokensB = getTokenCount(responseB);

        // Restore original preset
        await switchPreset(originalPreset);

        const data = {
            userInput,
            presetAValue, presetAName,
            presetBValue, presetBName,
            responseA, responseBText: responseB,
            timeA, timeB,
            tokensA, tokensB,
            charName: getCurrentCharName(),
            date: formatDate(new Date()),
        };

        showResult(data);

    } catch (err) {
        console.error('[Versus] Generation error:', err);
        showToast('생성 중 오류가 발생했습니다: ' + (err.message || err));
        await switchPreset(originalPreset);
        showSetup();
    } finally {
        isGenerating = false;
        if (startBtn) {
            startBtn.disabled = false;
            startBtn.textContent = '▶ 맞짱 시작';
        }
    }
}

function saveToHistory(data) {
    const settings = getSettings();
    if (!settings.history) settings.history = [];
    settings.history.push({
        userInput: data.userInput,
        presetAName: data.presetAName,
        presetBName: data.presetBName,
        presetAValue: data.presetAValue,
        presetBValue: data.presetBValue,
        responseA: data.responseA,
        responseBText: data.responseBText,
        tokensA: data.tokensA,
        tokensB: data.tokensB,
        timeA: data.timeA,
        timeB: data.timeB,
        charName: data.charName,
        date: data.date,
    });
    // Keep max 50
    if (settings.history.length > 50) {
        settings.history = settings.history.slice(-50);
    }
    saveSettingsDebounced();
}

function showToast(msg) {
    const existing = document.querySelector('.versus-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'versus-toast';
    toast.textContent = msg;
    document.documentElement.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 2500);
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function truncate(str, len) {
    return str.length > len ? str.slice(0, len) + '...' : str;
}

function formatDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${y}.${m}.${day} ${h}:${min}`;
}

function bindEvents() {
    document.addEventListener('click', (e) => {
        if (e.target.id === 'versus-close') {
            togglePanel();
        }
        if (e.target.id === 'versus-start') {
            startComparison();
        }
        if (e.target.id === 'versus-use-last') {
            const last = getLastUserMessage();
            const input = document.querySelector('#versus-input');
            if (input && last) {
                input.value = last;
            } else if (!last) {
                showToast('마지막 유저 메시지를 찾을 수 없습니다.');
            }
        }
        if (e.target.id === 'versus-show-history') {
            showHistory();
        }
    });
}

jQuery(async () => {
    const settings = getSettings();
    buildUI();
    bindEvents();
    console.log('[Versus] Extension loaded.');
});
