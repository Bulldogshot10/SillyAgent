import { getContext, renderExtensionTemplateAsync } from '../../extensions.js';
import { formatMemoryContext, hasMemoryContext, insertMemoryContext } from './memory-context.js';
import { selected_group } from '../../group-chats.js';
import {
    characters,
    eventSource,
    event_types,
    getCurrentChatId,
    getRequestHeaders,
    this_chid,
} from '../../../script.js';

const API_BASE = '/api/agent/tools';
const DEFAULT_SETTINGS = {
    autoRetrieveEnabled: true,
    autoCaptureEnabled: false,
    autoDreamEnabled: false,
};
let settings = { ...DEFAULT_SETTINGS };
let refreshInProgress = false;

function getContextIds() {
    const chatId = getCurrentChatId();
    return {
        activeChatId: typeof chatId === 'string' && chatId ? chatId : null,
        activeCharacterId: selected_group ? null : (characters[this_chid]?.avatar || null),
    };
}

async function requestApi(path, options = {}) {
    const headers = getRequestHeaders();
    const response = await fetch(API_BASE + path, {
        ...options,
        headers: {
            ...(headers || {}),
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        throw new Error(payload?.error?.message || 'SillyAgent memory request failed (' + response.status + ').');
    }
    return payload || {};
}

function setStatus(message, isError = false) {
    const status = document.getElementById('sillyagent_memory_status');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('error', isError);
}

function setSettingsControls() {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        const input = document.getElementById('sa_' + key);
        if (input) input.checked = Boolean(settings[key]);
    }
}

async function saveSetting(key, value) {
    const previous = settings[key];
    settings[key] = Boolean(value);
    try {
        const response = await requestApi('/memory/settings', {
            method: 'POST',
            body: JSON.stringify({ [key]: settings[key] }),
        });
        settings = { ...DEFAULT_SETTINGS, ...(response.settings || {}) };
        setSettingsControls();
        setStatus('Memory settings saved.');
    } catch (error) {
        settings[key] = previous;
        setSettingsControls();
        setStatus(error.message, true);
    }
}

function makeTextElement(tag, className, content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = String(content ?? '');
    return element;
}

function getSelectedMemoryScope() {
    const scope = document.getElementById('sa_memory_scope')?.value || 'user';
    const ids = getContextIds();
    if (scope === 'chat') return { scope, scopeId: ids.activeChatId };
    if (scope === 'character') return { scope, scopeId: ids.activeCharacterId };
    return { scope: 'user', scopeId: '' };
}

function renderProposalList(proposals) {
    const root = document.getElementById('sa_memory_proposals');
    if (!root) return;
    root.replaceChildren();
    const needle = (document.getElementById('sa_memory_search')?.value || '').trim().toLocaleLowerCase();
    const filtered = proposals.filter(item => !needle
        || item.content.toLocaleLowerCase().includes(needle)
        || item.scope.toLocaleLowerCase().includes(needle)
        || item.kind.toLocaleLowerCase().includes(needle));
    if (!filtered.length) {
        root.append(makeTextElement('p', 'sa-empty', 'No pending proposals match this filter.'));
        return;
    }

    for (const proposal of filtered) {
        const row = makeTextElement('div', 'sa-memory-row', '');
        row.append(makeTextElement('div', 'sa-memory-content', proposal.content));
        const origin = proposal.metadata?.origin ? ' · ' + proposal.metadata.origin : '';
        const evidence = Number.isInteger(proposal.metadata?.evidenceCount) ? ' · evidence ' + proposal.metadata.evidenceCount : '';
        row.append(makeTextElement('small', 'sa-memory-meta',
            proposal.scope + ' · ' + proposal.kind + ' · importance ' + proposal.importance + origin + evidence));
        const actions = makeTextElement('div', 'sa-memory-actions', '');
        const approve = makeTextElement('button', 'menu_button', 'Approve');
        approve.type = 'button';
        approve.addEventListener('click', () => reviewProposal(proposal.id, 'approve'));
        const reject = makeTextElement('button', 'menu_button', 'Reject');
        reject.type = 'button';
        reject.addEventListener('click', () => reviewProposal(proposal.id, 'reject'));
        actions.append(approve, reject);
        row.append(actions);
        root.append(row);
    }
}

function renderMemoryList(memories) {
    const root = document.getElementById('sa_memory_accepted');
    if (!root) return;
    root.replaceChildren();
    const needle = (document.getElementById('sa_memory_search')?.value || '').trim().toLocaleLowerCase();
    const filtered = memories.filter(item => !needle
        || item.content.toLocaleLowerCase().includes(needle)
        || item.scope.toLocaleLowerCase().includes(needle)
        || item.kind.toLocaleLowerCase().includes(needle));
    if (!filtered.length) {
        root.append(makeTextElement('p', 'sa-empty', 'No accepted memories match this filter.'));
        return;
    }

    for (const memory of filtered) {
        const row = makeTextElement('div', 'sa-memory-row', '');
        row.append(makeTextElement('div', 'sa-memory-content', memory.content));
        row.append(makeTextElement('small', 'sa-memory-meta',
            memory.scope + ' · ' + memory.kind + ' · importance ' + memory.importance));
        const actions = makeTextElement('div', 'sa-memory-actions', '');
        const remove = makeTextElement('button', 'menu_button', 'Delete memory');
        remove.type = 'button';
        remove.addEventListener('click', () => deleteMemory(memory.id));
        actions.append(remove);
        row.append(actions);
        root.append(row);
    }
}

async function refreshPanel() {
    if (refreshInProgress) return;
    refreshInProgress = true;
    try {
        const [settingsResponse, proposalResponse] = await Promise.all([
            requestApi('/memory/settings'),
            requestApi('/memory/proposals'),
        ]);
        settings = { ...DEFAULT_SETTINGS, ...(settingsResponse.settings || {}) };
        setSettingsControls();
        renderProposalList(proposalResponse.proposals || []);
        const summary = proposalResponse.summary || {};
        const stats = document.getElementById('sa_memory_summary');
        if (stats) {
            stats.textContent = 'accepted ' + (summary.acceptedMemories ?? 0)
                + ' · pending ' + (summary.pendingProposals ?? 0)
                + ' · events ' + (summary.events ?? 0);
        }
        await loadAcceptedMemories();
        setStatus('Memory state refreshed.');
    } catch (error) {
        setStatus(error.message, true);
    } finally {
        refreshInProgress = false;
    }
}

async function loadAcceptedMemories() {
    const scope = getSelectedMemoryScope();
    if (scope.scope !== 'user' && !scope.scopeId) {
        renderMemoryList([]);
        setStatus('Open a chat or select an active character to manage that scope.');
        return;
    }
    const params = new URLSearchParams({
        scope: scope.scope,
        limit: '100',
    });
    if (scope.scopeId) params.set('scopeId', scope.scopeId);
    const payload = await requestApi('/memory/list?' + params.toString());
    renderMemoryList(payload.memories || []);
}

async function reviewProposal(id, decision) {
    try {
        await requestApi('/memory/proposals/' + encodeURIComponent(id) + '/review', {
            method: 'POST',
            body: JSON.stringify({ decision }),
        });
        setStatus('Proposal ' + (decision === 'approve' ? 'approved.' : 'rejected.'));
        await refreshPanel();
    } catch (error) {
        setStatus(error.message, true);
    }
}

async function deleteMemory(id) {
    if (!window.confirm('Delete this accepted memory? It will no longer be retrieved.')) return;
    try {
        await requestApi('/memory/' + encodeURIComponent(id), { method: 'DELETE' });
        setStatus('Memory deleted.');
        await refreshPanel();
    } catch (error) {
        setStatus(error.message, true);
    }
}

async function runDreaming() {
    const ids = getContextIds();
    if (!ids.activeChatId) {
        setStatus('Open a chat before running dreaming.', true);
        return;
    }
    const button = document.getElementById('sa_memory_dream');
    if (button) button.disabled = true;
    try {
        const payload = await requestApi('/dream', {
            method: 'POST',
            body: JSON.stringify({ activeChatId: ids.activeChatId }),
        });
        setStatus(payload.message || 'Dreaming completed. Review the new proposals below.');
        await refreshPanel();
    } catch (error) {
        setStatus(error.message, true);
    } finally {
        if (button) button.disabled = false;
    }
}

async function clearCapturedHistory() {
    const ids = getContextIds();
    if (!ids.activeChatId) {
        setStatus('Open a chat before clearing captured history.', true);
        return;
    }
    const confirmed = window.confirm(
        'Clear captured raw turns for this chat? Approved memories and existing proposals will remain until you remove them separately.',
    );
    if (!confirmed) return;
    const button = document.getElementById('sa_memory_clear_captured');
    if (button) button.disabled = true;
    try {
        const result = await requestApi('/memory/capture-history/clear', {
            method: 'POST',
            body: JSON.stringify({ activeChatId: ids.activeChatId }),
        });
        setStatus('Cleared ' + result.clearedTurns + ' captured turns. Existing memories and proposals were kept.');
        await refreshPanel();
    } catch (error) {
        setStatus(error.message, true);
    } finally {
        if (button) button.disabled = false;
    }
}

function extractMessageText(message) {
    if (!message || typeof message.mes !== 'string') return '';
    return message.mes.trim().slice(0, 12000);
}

async function captureTurn(messageIndex, role, messageType = '') {
    if (!settings.autoCaptureEnabled) return;
    if (['swipe', 'continue', 'append', 'appendFinal', 'impersonate'].includes(messageType)) return;
    const context = getContext();
    const currentChat = context?.chat;
    if (!Array.isArray(currentChat) || !currentChat.length) return;
    const index = Number.isInteger(messageIndex) ? messageIndex : currentChat.length - 1;
    const message = currentChat[index];
    if (!message || message.is_system) return;
    if (role === 'user' && !message.is_user) return;
    if (role === 'assistant' && (message.is_user || message.is_system)) return;
    const content = extractMessageText(message);
    if (!content) return;
    const ids = getContextIds();
    if (!ids.activeChatId) return;
    try {
        await requestApi('/capture-turn', {
            method: 'POST',
            body: JSON.stringify({
                activeChatId: ids.activeChatId,
                activeCharacterId: ids.activeCharacterId,
                role,
                content,
                messageKey: String(index) + ':' + role,
            }),
        });
    } catch (error) {
        console.debug('[SillyAgent memory] Automatic capture skipped:', error);
    }
}

function getLastUserQuery() {
    const context = getContext();
    if (!Array.isArray(context?.chat)) return '';
    for (let index = context.chat.length - 1; index >= 0; index--) {
        const message = context.chat[index];
        if (!message || !message.is_user || message.is_system || typeof message.mes !== 'string') continue;
        return message.mes.trim().slice(-300);
    }
    return '';
}

async function retrieveContext(query) {
    if (!settings.autoRetrieveEnabled || typeof query !== 'string' || !query.trim()) return [];
    const ids = getContextIds();
    try {
        const payload = await requestApi('/retrieve-context', {
            method: 'POST',
            body: JSON.stringify({
                query: query.slice(-300),
                activeChatId: ids.activeChatId,
                activeCharacterId: ids.activeCharacterId,
                limit: 3,
            }),
        });
        return payload.enabled ? (payload.memories || []) : [];
    } catch (error) {
        console.debug('[SillyAgent memory] Automatic retrieval skipped:', error);
        return [];
    }
}

async function onChatCompletionPromptReady(eventData) {
    if (!settings.autoRetrieveEnabled || eventData?.dryRun || !Array.isArray(eventData?.chat)) return;
    if (hasMemoryContext(eventData.chat)) return;
    const memories = await retrieveContext(getLastUserQuery());
    insertMemoryContext(eventData.chat, memories);
}

async function onTextPromptReady(eventData) {
    if (!settings.autoRetrieveEnabled || eventData?.dryRun || typeof eventData?.prompt !== 'string') return;
    if (eventData.prompt.includes(MEMORY_MARKER)) return;
    const memories = await retrieveContext(getLastUserQuery());
    if (!memories.length) return;
    eventData.prompt += '\n\n' + formatMemoryContext(memories);
}

export async function init() {
    const html = await renderExtensionTemplateAsync('sillyagent-memory', 'settings', {});
    document.getElementById('extensions_settings')?.append(document.createRange().createContextualFragment(html));

    document.getElementById('sa_memory_refresh')?.addEventListener('click', refreshPanel);
    document.getElementById('sa_memory_dream')?.addEventListener('click', runDreaming);
    document.getElementById('sa_memory_clear_captured')?.addEventListener('click', clearCapturedHistory);
    document.getElementById('sa_memory_scope')?.addEventListener('change', () => loadAcceptedMemories().catch(error => setStatus(error.message, true)));
    document.getElementById('sa_memory_search')?.addEventListener('keydown', event => {
        if (event.key === 'Enter') refreshPanel();
    });
    document.getElementById('sa_autoRetrieveEnabled')?.addEventListener('change', event => saveSetting('autoRetrieveEnabled', event.target.checked));
    document.getElementById('sa_autoCaptureEnabled')?.addEventListener('change', event => saveSetting('autoCaptureEnabled', event.target.checked));
    document.getElementById('sa_autoDreamEnabled')?.addEventListener('change', event => saveSetting('autoDreamEnabled', event.target.checked));

    eventSource.on(event_types.MESSAGE_SENT, index => {
        void captureTurn(index, 'user');
    });
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (index, type) => {
        void captureTurn(index, 'assistant', type);
    });
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
    eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, onTextPromptReady);

    try {
        const response = await requestApi('/memory/settings');
        settings = { ...DEFAULT_SETTINGS, ...(response.settings || {}) };
        setSettingsControls();
        await refreshPanel();
    } catch (error) {
        setStatus(error.message, true);
    }
}
