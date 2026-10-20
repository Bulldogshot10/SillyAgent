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
    }
    return phrases;
}

/**
 * Deterministic v1 dreaming engine. It discovers recurring topics from captured turns
 * and creates reviewable proposals; it never auto-approves an inference.
 */
export class DreamingEngine {
    #store;

    constructor(store) {
        if (!store) throw new TypeError('DreamingEngine requires a memory store.');
        this.#store = store;
    }

    /**
     * Review an active chat's captured history for recurring topics.
     * @param {object} options Scope and reflection bounds.
     * @returns {object} Dreaming report.
     */
    run({ scope = 'chat', scopeId, limit = 100, minMentions = 3, maxProposals = 5, requireApproval } = {}) {
        if (scope !== 'chat') throw new TypeError('Dreaming v1 only supports the active chat scope.');
        if (typeof scopeId !== 'string' || !scopeId.trim()) throw new TypeError('Dreaming requires an active chat ID.');
        const eventLimit = Math.max(10, Math.min(200, Number.isInteger(limit) ? limit : 100));
        const mentionsRequired = Math.max(2, Math.min(10, Number.isInteger(minMentions) ? minMentions : 3));
        const proposalLimit = Math.max(1, Math.min(10, Number.isInteger(maxProposals) ? maxProposals : 5));
        const events = this.#store.listEvents({
            scope: 'chat',
            scopeId,
            eventTypes: ['chat.user_turn', 'chat.assistant_turn'],
            limit: eventLimit,
        });
        if (!events.length) {
            return { scope: 'chat', eventsReviewed: 0, candidatesCreated: 0, topics: [], message: 'No captured turns are available to dream over yet.' };
        }

        const evidenceByPhrase = new Map();
        for (const event of events) {
            for (const phrase of getPhrases(event.content)) {
                if (!evidenceByPhrase.has(phrase)) evidenceByPhrase.set(phrase, new Set());
                evidenceByPhrase.get(phrase).add(event.id);
            }
        }
        const candidates = [...evidenceByPhrase.entries()]
            .filter(([phrase, evidence]) => evidence.size >= mentionsRequired && phrase.length >= 4)
            .map(([phrase, evidence]) => ({ phrase, evidence: [...evidence] }))
            .sort((left, right) => {
                const leftWords = left.phrase.split(' ').length;
                const rightWords = right.phrase.split(' ').length;
                return right.evidence.length - left.evidence.length
                    || rightWords - leftWords
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
            const content = 'Recurring topic in this chat: ' + candidate.phrase + '.';
            if (this.#store.hasMemoryOrPending({ scope: 'chat', scopeId, kind: 'event', content })) continue;
            proposals.push(this.#store.proposeMemory({
                scope: 'chat',
                scopeId,
                kind: 'event',
                content,
                importance: 2,
                requireApproval,
                metadata: {
                    origin: 'dreaming',
                    method: 'recurring-topic-v1',
                    confidence: Math.min(0.99, candidate.evidence.length / events.length),
                    evidenceEventIds: candidate.evidence.slice(0, 30),
                    evidenceCount: candidate.evidence.length,
                },
            }));
        }

        this.#store.recordEvent({
            scope: 'chat',
            scopeId,
            eventType: 'dream.completed',
            content: 'Dreaming reviewed ' + events.length + ' captured turns and created ' + proposals.length + ' memory candidates.',
            metadata: { method: 'recurring-topic-v1', eventsReviewed: events.length, candidatesCreated: proposals.length },
        });

        const memoriesAccepted = proposals.filter(proposal => proposal.status === 'approved').length;
        const proposalsPending = proposals.filter(proposal => proposal.status === 'pending').length;

        return {
            scope: 'chat',
            eventsReviewed: events.length,
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
