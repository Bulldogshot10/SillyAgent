const STOP_WORDS = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'had', 'are', 'was', 'were',
    'you', 'your', 'yours', 'they', 'them', 'their', 'there', 'then', 'than', 'into', 'about', 'just',
    'not', 'but', 'can', 'could', 'would', 'should', 'will', 'what', 'when', 'where', 'which', 'who',
    'how', 'why', 'all', 'any', 'some', 'only', 'very', 'more', 'most', 'much', 'many', 'also', 'its',
    'our', 'out', 'use', 'using', 'used', 'make', 'made', 'get', 'got', 'she', 'her', 'his', 'him',
    'aku', 'gue', 'gw', 'gua', 'saya', 'kamu', 'lu', 'lo', 'dia', 'mereka', 'kita', 'kami', 'yang',
    'dan', 'atau', 'dari', 'untuk', 'dengan', 'ini', 'itu', 'ada', 'jadi', 'udah', 'sudah', 'akan',
    'bisa', 'gak', 'enggak', 'tidak', 'bukan', 'juga', 'lebih', 'banget', 'karena', 'kalau', 'kalo',
    'dalam', 'pada', 'oleh', 'sebagai', 'serta', 'saat', 'buat', 'punya', 'nya', 'sih', 'deh', 'dong',
    'です', 'ます', 'する', 'した', 'して', 'いる', 'ある', 'こと', 'それ', 'これ', 'ため', 'から', 'まで',
    'よう', 'なる', 'ない', 'でも', 'は', 'が', 'を', 'に', 'と', 'で', 'の', 'も',
]);

function tokenize(text) {
    const matches = text.normalize('NFKC').toLocaleLowerCase().match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,}|[\p{L}\p{N}][\p{L}\p{N}'’-]{2,}/gu) ?? [];
    return matches.filter(token => token.length >= 2 && !STOP_WORDS.has(token));
}

function getPhrases(text) {
    const tokens = tokenize(text);
    const phrases = new Set();
    for (let index = 0; index < tokens.length; index++) {
        phrases.add(tokens[index]);
        if (index + 1 < tokens.length) phrases.add(tokens[index] + ' ' + tokens[index + 1]);
        if (index + 2 < tokens.length) phrases.add(tokens[index] + ' ' + tokens[index + 1] + ' ' + tokens[index + 2]);
    }
    return phrases;
}

function getCharacterId(event) {
    const id = event?.metadata?.characterId;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
}

function inferDreamScope(evidence, activeChatId) {
    const chatIds = new Set(evidence.map(event => event.scopeId).filter(Boolean));
    if (chatIds.size <= 1) {
        return { scope: 'chat', scopeId: [...chatIds][0] || activeChatId, chatCount: chatIds.size };
    }

    const characterIds = evidence.map(getCharacterId);
    const distinctCharacters = new Set(characterIds.filter(Boolean));
    const allEvidenceFromSameCharacter = characterIds.length > 0
        && characterIds.every(id => id && id === [...distinctCharacters][0])
        && distinctCharacters.size === 1;

    if (allEvidenceFromSameCharacter) {
        return { scope: 'character', scopeId: [...distinctCharacters][0], chatCount: chatIds.size };
    }

    return { scope: 'user', scopeId: '', chatCount: chatIds.size };
}

/**
 * Autonomous v2 dreaming. It detects repeated topics in the active chat and
 * across recently captured chats, then picks chat, character, or user scope
 * from the evidence. It needs no manual scope selection or manual trigger.
 */
export class DreamingEngine {
    #store;

    constructor(store) {
        if (!store) throw new TypeError('DreamingEngine requires a memory store.');
        this.#store = store;
    }

    /**
     * Consolidate recent captured conversation history into durable memories.
     * @param {object} options Scope and reflection bounds.
     * @returns {object} Dreaming report.
     */
    run({ scope = 'chat', scopeId, limit = 100, minMentions = 3, maxProposals = 5, requireApproval = false } = {}) {
        if (scope !== 'chat') throw new TypeError('Dreaming is triggered from an active chat.');
        if (typeof scopeId !== 'string' || !scopeId.trim()) throw new TypeError('Dreaming requires an active chat ID.');

        const eventLimit = Math.max(10, Math.min(200, Number.isInteger(limit) ? limit : 100));
        const mentionsRequired = Math.max(2, Math.min(10, Number.isInteger(minMentions) ? minMentions : 3));
        const proposalLimit = Math.max(1, Math.min(10, Number.isInteger(maxProposals) ? maxProposals : 5));
        const eventTypes = ['chat.user_turn', 'chat.assistant_turn'];
        const currentEvents = this.#store.listEvents({
            scope: 'chat',
            scopeId,
            eventTypes,
            limit: eventLimit,
        });
        if (!currentEvents.length) {
            return {
                scope: 'chat',
                eventsReviewed: 0,
                globalEventsReviewed: 0,
                candidatesCreated: 0,
                topics: [],
                message: 'No captured turns are available to dream over yet.',
            };
        }

        // Keep a bounded global window for cross-chat learning, while always including
        // the active chat's full analysis window even when its events fall outside it.
        const globalEvents = this.#store.listCapturedTurnsAcrossChats({ limit: Math.max(500, eventLimit) });
        const eventById = new Map([...globalEvents, ...currentEvents].map(event => [event.id, event]));
        const historyEvents = [...eventById.values()].sort((left, right) => left.createdAt - right.createdAt);
        const evidenceByPhrase = new Map();

        for (const event of historyEvents) {
            for (const phrase of getPhrases(event.content)) {
                if (!evidenceByPhrase.has(phrase)) evidenceByPhrase.set(phrase, new Map());
                evidenceByPhrase.get(phrase).set(event.id, event);
            }
        }

        const candidates = [...evidenceByPhrase.entries()]
            .filter(([phrase, evidence]) => evidence.size >= mentionsRequired && phrase.length >= 4)
            .map(([phrase, evidence]) => ({ phrase, evidence: [...evidence.values()] }))
            .sort((left, right) => {
                return right.evidence.length - left.evidence.length
                    || right.phrase.split(' ').length - left.phrase.split(' ').length
                    || left.phrase.localeCompare(right.phrase);
            });

        const selected = [];
        for (const candidate of candidates) {
            if (selected.some(item => item.phrase.includes(candidate.phrase) || candidate.phrase.includes(item.phrase))) continue;
            selected.push(candidate);
            if (selected.length >= proposalLimit) break;
        }

        const proposals = [];
        for (const candidate of selected) {
            const target = inferDreamScope(candidate.evidence, scopeId);
            const content = target.scope === 'chat'
                ? 'Recurring topic in this chat: ' + candidate.phrase + '.'
                : target.scope === 'character'
                    ? 'Recurring topic associated with this character across conversations: ' + candidate.phrase + '.'
                    : 'Recurring topic across conversations: ' + candidate.phrase + '.';

            if (this.#store.hasMemoryOrPending({
                scope: target.scope,
                scopeId: target.scopeId,
                kind: 'event',
                content,
            })) continue;

            proposals.push(this.#store.proposeMemory({
                scope: target.scope,
                scopeId: target.scopeId,
                kind: 'event',
                content,
                importance: target.scope === 'chat' ? 2 : 3,
                requireApproval,
                metadata: {
                    origin: 'dreaming',
                    method: 'recurring-topic-v2',
                    confidence: Math.min(0.99, candidate.evidence.length / historyEvents.length),
                    evidenceEventIds: candidate.evidence.slice(-30).map(event => event.id),
                    evidenceCount: candidate.evidence.length,
                    evidenceChatCount: new Set(candidate.evidence.map(event => event.scopeId)).size,
                    targetScope: target.scope,
                },
            }));
        }

        this.#store.recordEvent({
            scope: 'chat',
            scopeId,
            eventType: 'dream.completed',
            content: 'Dreaming reviewed ' + currentEvents.length + ' active-chat turns and ' + historyEvents.length + ' captured turns across chats; created ' + proposals.length + ' memory candidates.',
            metadata: {
                method: 'recurring-topic-v2',
                eventsReviewed: currentEvents.length,
                globalEventsReviewed: historyEvents.length,
                candidatesCreated: proposals.length,
            },
        });

        const memoriesAccepted = proposals.filter(proposal => proposal.status === 'approved').length;
        const proposalsPending = proposals.filter(proposal => proposal.status === 'pending').length;

        return {
            scope: 'chat',
            eventsReviewed: currentEvents.length,
            globalEventsReviewed: historyEvents.length,
            candidatesCreated: proposals.length,
            memoriesAccepted,
            proposalsPending,
            topics: proposals.map(proposal => proposal.content),
            message: proposals.length
                ? proposalsPending
                    ? memoriesAccepted + ' recurring-topic memories were saved automatically; ' + proposalsPending + ' proposal(s) await review.'
                    : memoriesAccepted + ' recurring-topic memories were saved automatically.'
                : 'No new recurring topics were strong enough to store.',
        };
    }
}
