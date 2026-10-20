import { getContext, renderExtensionTemplateAsync } from '../../extensions.js';
import { oai_settings } from '../../openai.js';
import { formatMemoryContext, hasMemoryContext, insertMemoryContext } from './memory-context.js';
import { buildAutonomousExtractionPrompt, parseAutonomousExtraction } from './auto-extraction.js';
import { selected_group } from '../../group-chats.js';
import {
    characters,
    eventSource,
    event_types,
    getCurrentChatId,
    getRequestHeaders,
    generateQuietPrompt,
    saveSettingsDebounced,
    this_chid,
} from '../../../script.js';

const API_BASE = '/api/agent/tools';
const AUTONOMOUS_MEMORY_MARKER = '[SILLYAGENT_AUTONOMOUS_MEMORY_V1]';
const AUTONOMOUS_MEMORY_INSTRUCTIONS = [
    AUTONOMOUS_MEMORY_MARKER,
    'Use SillyAgent memory tools autonomously. Never ask the user to select a memory scope, approve ordinary memories, or manually trigger a memory operation.',
    'Call sillyagent_memory_search when prior facts are relevant and not already available in the injected context. Save durable information as soon as it emerges, without waiting for the user to ask. All persistent memory is isolated per active character: stable facts about the user, preferences, and long-term goals are stored inside this character’s own memory partition, alongside this character’s identity, backstory, and relationship continuity. Temporary task, debugging, or current conversation state belongs to the current chat. Never share memories or dreaming evidence across different characters.',
    'Use sillyagent_memory_propose with a concise, self-contained memory and an appropriate kind/importance. The scope is optional when unclear because the server will infer it. Avoid duplicates, one-off trivia, credentials, secrets, and unnecessary sensitive detail.',
    'Let memory operations happen in the background and continue answering the user naturally. Do not announce routine memory writes unless relevant to the conversation.',
].join(' ');
let refreshInProgress = false;
let autonomousReflectionInProgress = false;
const EXTRACTION_INTERVAL_TURNS = 4;
const DREAMING_INTERVAL_TURNS = 12;

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

function makeTextElement(tag, className, content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = String(content ?? '');
    return element;
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
        await requestApi('/memory/settings');
        const proposalResponse = await requestApi('/memory/proposals');
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
    const ids = getContextIds();
    const requests = [];

    // The panel follows the active context automatically. It never lists another
    // character's stored memories or a legacy global user pool.
    if (ids.activeCharacterId) {
        const characterParams = new URLSearchParams({
            scope: 'character',
            scopeId: ids.activeCharacterId,
            limit: '100',
        });
        requests.push(requestApi('/memory/list?' + characterParams.toString()));
    }
    if (ids.activeChatId) {
        const chatParams = new URLSearchParams({
            scope: 'chat',
            activeChatId: ids.activeChatId,
            ...(ids.activeCharacterId ? { activeCharacterId: ids.activeCharacterId } : {}),
            limit: '100',
        });
        requests.push(requestApi('/memory/list?' + chatParams.toString()));
    }

    const payloads = await Promise.all(requests);
    const memories = payloads.flatMap(payload => payload.memories || []);
    const uniqueMemories = [...new Map(memories.map(memory => [memory.id, memory])).values()];
    renderMemoryList(uniqueMemories);
}

async function deleteMemory(id) {
    if (!window.confirm('Delete this memory and all same-text copies, proposals, and source events in this scope? Raw captured chat turns remain and must be cleared separately.')) return;
    try {
        await requestApi('/memory/' + encodeURIComponent(id), { method: 'DELETE' });
        setStatus('Memory and linked records deleted. Captured chat turns remain until cleared separately.');
        await refreshPanel();
    } catch (error) {
        setStatus(error.message, true);
    }
}

async function clearCapturedHistory() {
    const ids = getContextIds();
    if (!ids.activeChatId) {
        setStatus('Open a chat before clearing captured history.', true);
        return;
    }
    const confirmed = window.confirm(
        'Clear captured raw turns for this chat? Accepted memories are kept.',
    );
    if (!confirmed) return;
    const button = document.getElementById('sa_memory_clear_captured');
    if (button) button.disabled = true;
    try {
        const result = await requestApi('/memory/capture-history/clear', {
            method: 'POST',
            body: JSON.stringify({
                activeChatId: ids.activeChatId,
                activeCharacterId: ids.activeCharacterId,
            }),
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
        const result = await requestApi('/capture-turn', {
            method: 'POST',
            body: JSON.stringify({
                activeChatId: ids.activeChatId,
                activeCharacterId: ids.activeCharacterId,
                role,
                content,
                messageKey: String(index) + ':' + role,
            }),
        });

        // Background extraction runs automatically after each small batch of captured
        // turns. Every third batch performs a wider, same-character dreaming pass.
        // Neither path requires a tool call, save instruction, or UI action from the user.
        if (role === 'assistant' && result.captured && !result.duplicate
            && Number.isInteger(result.capturedCount)
            && result.capturedCount % EXTRACTION_INTERVAL_TURNS === 0) {
            const mode = result.capturedCount % DREAMING_INTERVAL_TURNS === 0 ? 'dream' : 'extract';
            void runAutonomousMemoryPass(mode);
        }
    } catch (error) {
        console.debug('[SillyAgent memory] Automatic capture skipped:', error);
    }
}

/**
 * Use the current SillyTavern model for silent background extraction/consolidation.
 * This is deliberately independent of native function calling so memory can be
 * autonomous even when the model never chooses a memory tool.
 * @param {'extract'|'dream'} mode Reflection depth.
 * @returns {Promise<void>}
 */
async function runAutonomousMemoryPass(mode = 'extract') {
    if (autonomousReflectionInProgress) return;
    const ids = getContextIds();
    if (!ids.activeChatId) return;

    autonomousReflectionInProgress = true;
    try {
        const context = await requestApi('/memory/reflection-context', {
            method: 'POST',
            body: JSON.stringify({
                activeChatId: ids.activeChatId,
                activeCharacterId: ids.activeCharacterId,
            }),
        });
        const activeChatTurns = (context.turns || []).filter(turn => turn.chatId === context.activeChatId);
        const turns = mode === 'dream' ? (context.turns || []) : activeChatTurns.slice(-10);
        if (!turns.length) return;

        const prompt = buildAutonomousExtractionPrompt(turns, context.memories || [], { mode });
        const responseText = await generateQuietPrompt({
            quietPrompt: prompt,
            skipWIAN: true,
            responseLength: mode === 'dream' ? 700 : 500,
        });
        const candidates = parseAutonomousExtraction(responseText, context.memories || [], { mode });
        let saved = 0;

        for (const candidate of candidates) {
            const result = await requestApi('/execute', {
                method: 'POST',
                body: JSON.stringify({
                    name: 'memory_propose',
                    activeChatId: ids.activeChatId,
                    activeCharacterId: ids.activeCharacterId,
                    arguments: {
                        content: candidate.content,
                        kind: candidate.kind,
                        importance: candidate.importance,
                        scope: candidate.scope,
                    },
                }),
            });
            if (result.ok && result.result?.memory) saved++;
        }

        if (saved > 0) {
            console.debug('[SillyAgent memory] Autonomous ' + mode + ' saved ' + saved + ' memory record(s).');
            await refreshPanel();
        } else {
            console.debug('[SillyAgent memory] Autonomous ' + mode + ' completed with no new durable memories.');
        }
    } catch (error) {
        console.debug('[SillyAgent memory] Autonomous ' + mode + ' skipped:', error);
    } finally {
        autonomousReflectionInProgress = false;
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
    if (typeof query !== 'string' || !query.trim()) return [];
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

function enableAutomaticToolCalling() {
    if (!oai_settings) return;
    let changed = false;

    if (!oai_settings.function_calling) {
        oai_settings.function_calling = true;
        changed = true;
    }

    // SillyTavern prompt post-processors that rewrite/drop tool calls break the
    // native tool loop. Automatically select a compatible mode instead of
    // requiring the user to find and change another setting manually.
    const toolCompatibleModes = new Set(['none', 'merge_tools', 'semi_tools', 'strict_tools']);
    if (!toolCompatibleModes.has(oai_settings.custom_prompt_post_processing)) {
        oai_settings.custom_prompt_post_processing = 'none';
        changed = true;
    }

    if (changed) saveSettingsDebounced();
}

function insertAutonomousMemoryInstructions(chat) {
    if (!Array.isArray(chat) || chat.some(message =>
        typeof message?.content === 'string' && message.content.includes(AUTONOMOUS_MEMORY_MARKER))) return;

    const systemMessage = chat.find(message => message?.role === 'system' && typeof message.content === 'string');
    if (systemMessage) {
        systemMessage.content += '\n\n' + AUTONOMOUS_MEMORY_INSTRUCTIONS;
    } else {
        chat.unshift({ role: 'system', content: AUTONOMOUS_MEMORY_INSTRUCTIONS });
    }
}

async function onChatCompletionPromptReady(eventData) {
    if (eventData?.dryRun || !Array.isArray(eventData?.chat)) return;
    enableAutomaticToolCalling();
    insertAutonomousMemoryInstructions(eventData.chat);
    if (hasMemoryContext(eventData.chat)) return;
    const memories = await retrieveContext(getLastUserQuery());
    insertMemoryContext(eventData.chat, memories);
}

async function onTextPromptReady(eventData) {
    if (eventData?.dryRun || typeof eventData?.prompt !== 'string') return;
    if (hasMemoryContext(eventData.prompt)) return;
    const memories = await retrieveContext(getLastUserQuery());
    if (!memories.length) return;
    eventData.prompt += '\n\n' + formatMemoryContext(memories);
}

export async function init() {
    const html = await renderExtensionTemplateAsync('sillyagent-memory', 'settings', {});
    document.getElementById('extensions_settings')?.append(document.createRange().createContextualFragment(html));

    document.getElementById('sa_memory_refresh')?.addEventListener('click', refreshPanel);
    document.getElementById('sa_memory_clear_captured')?.addEventListener('click', clearCapturedHistory);
    document.getElementById('sa_memory_search')?.addEventListener('keydown', event => {
        if (event.key === 'Enter') refreshPanel();
    });

    eventSource.on(event_types.MESSAGE_SENT, index => {
        void captureTurn(index, 'user');
    });
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (index, type) => {
        void captureTurn(index, 'assistant', type);
    });
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
    eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, onTextPromptReady);

    enableAutomaticToolCalling();
    try {
        await requestApi('/memory/settings');
        await refreshPanel();
    } catch (error) {
        setStatus(error.message, true);
    }
}
