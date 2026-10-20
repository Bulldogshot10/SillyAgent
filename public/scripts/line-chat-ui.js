(() => {
    'use strict';

    const VIEW_LABELS = {
        chats: ['Chats', 'Pick up where the conversation left off.'],
        agent: ['Agent tools', 'A live inventory of tools available to chat generation.'],
        memory: ['Memory', 'Review proposals and manage the memories SillyAgent keeps.'],
    };

    let memoryPlaceholder = null;
    let memoryObserver = null;
    let recentChats = [];
    let recentChatsLoaded = false;
    let recentChatsPromise = null;
    let recentRefreshTimer = null;
    let toolsLoaded = false;
    let toolsLoading = false;
    let appReady = false;
    let uiInitialized = false;

    // Load the core modules dynamically so a failed app bootstrap doesn't suppress the shell.
    let eventSource = null;
    let event_types = null;
    let getCurrentChatId = () => null;
    let getRecentChats = async () => [];
    let openRecentCharacterChat = async () => {};
    let openRecentGroupChat = async () => {};
    let getGroupAvatar = () => null;
    let groups = [];
    let groupChatsModule = null;

    const getSelectedGroup = () => groupChatsModule?.selected_group || null;
    const byId = id => document.getElementById(id);
    const isMobile = () => window.matchMedia('(max-width: 760px)').matches;

    function node(tag, className, text) {
        const item = document.createElement(tag);
        if (className) item.className = className;
        if (text !== undefined && text !== null) item.textContent = String(text);
        return item;
    }

    function iconButton(view, icon, label) {
        const button = node('button', 'sa-line-nav-item');
        button.type = 'button';
        button.dataset.saView = view;
        button.setAttribute('aria-label', label);
        button.title = label;
        const glyph = node('i', 'fa-solid ' + icon);
        glyph.setAttribute('aria-hidden', 'true');
        button.append(glyph, node('span', '', label));
        return button;
    }

    function buildShell() {
        if (byId('sa-line-rail')) return;

        const rail = node('nav', '');
        rail.id = 'sa-line-rail';
        rail.setAttribute('aria-label', 'SillyAgent navigation');

        const brand = node('div', 'sa-line-brand', 'sa');
        brand.setAttribute('aria-label', 'SillyAgent');
        brand.title = 'SillyAgent';

        const spacer = node('div', 'sa-line-nav-spacer');
        spacer.setAttribute('aria-hidden', 'true');

        rail.append(
            brand,
            iconButton('chats', 'fa-comments', 'Chats'),
            iconButton('characters', 'fa-address-book', 'Cast'),
            spacer,
            iconButton('agent', 'fa-screwdriver-wrench', 'Agent'),
            iconButton('memory', 'fa-brain', 'Memory'),
            iconButton('settings', 'fa-sliders', 'Settings'),
        );

        const contacts = node('aside', '');
        contacts.id = 'sa-line-contacts';
        contacts.setAttribute('aria-label', 'Chats and characters');

        const contactsHeader = node('header', 'sa-line-contacts-header');
        const titleWrap = node('div', '');
        titleWrap.append(
            node('h1', 'sa-line-contacts-title', 'Chats'),
            node('span', 'sa-line-contacts-subtitle', 'Recent conversations'),
        );

        const headerActions = node('div', 'sa-line-inbox-actions');
        const count = node('span', '', '');
        count.id = 'sa-line-contact-count';
        count.setAttribute('aria-label', 'Recent conversations');
        const refresh = node('button', 'sa-line-icon-button');
        refresh.type = 'button';
        refresh.title = 'Refresh recent chats';
        refresh.setAttribute('aria-label', 'Refresh recent chats');
        refresh.append(node('i', 'fa-solid fa-rotate'));
        refresh.addEventListener('click', () => void loadRecentChats(true));

        const browse = node('button', 'sa-line-icon-button');
        browse.type = 'button';
        browse.title = 'Browse characters';
        browse.setAttribute('aria-label', 'Browse characters');
        browse.append(node('i', 'fa-solid fa-user-plus'));
        browse.addEventListener('click', () => navigate('characters'));
        headerActions.append(count, refresh, browse);
        contactsHeader.append(titleWrap, headerActions);

        const searchWrap = node('label', 'sa-line-inbox-search');
        searchWrap.append(node('i', 'fa-solid fa-magnifying-glass'));
        const search = node('input', '');
        search.id = 'sa-line-chat-search';
        search.type = 'search';
        search.autocomplete = 'off';
        search.placeholder = 'Search conversations';
        search.setAttribute('aria-label', 'Search conversations');
        search.addEventListener('input', renderRecentChats);
        searchWrap.append(search);

        const contactsSlot = node('div', '');
        contactsSlot.id = 'sa-line-contacts-slot';
        contacts.append(contactsHeader, searchWrap, contactsSlot);

        const workspace = node('section', '');
        workspace.id = 'sa-line-workspace';
        workspace.setAttribute('aria-live', 'polite');

        const pageHeader = node('header', 'sa-line-page-header');
        const pageHeaderText = node('div', '');
        pageHeaderText.id = 'sa-line-page-heading';
        const pageBody = node('div', 'sa-line-page-body');
        pageBody.id = 'sa-line-page-body';
        pageHeader.append(pageHeaderText);
        workspace.append(pageHeader, pageBody);

        document.body.append(rail, contacts, workspace);

        const sheld = byId('sheld');
        const chat = byId('chat');
        if (sheld && chat && !byId('sa-line-chat-header')) {
            const header = node('header', '');
            header.id = 'sa-line-chat-header';

            const back = node('button', 'sa-line-back-button');
            back.type = 'button';
            back.id = 'sa-line-back-to-chats';
            back.setAttribute('aria-label', 'Back to chats');
            back.title = 'Back to chats';
            back.append(node('i', 'fa-solid fa-arrow-left'));
            back.addEventListener('click', () => {
                document.body.dataset.saMobileScreen = 'list';
            });

            const avatar = node('div', 'sa-line-chat-avatar');
            avatar.id = 'sa-line-current-avatar';
            const image = node('img', '');
            image.id = 'sa-line-chat-avatar-image';
            image.alt = '';
            image.hidden = true;
            const fallback = node('i', 'fa-solid fa-user');
            fallback.id = 'sa-line-chat-avatar-fallback';
            fallback.setAttribute('aria-hidden', 'true');
            avatar.append(image, fallback);

            const identity = node('div', 'sa-line-chat-identity');
            identity.append(
                node('strong', '', 'Choose a character'),
                node('small', '', 'Conversation'),
            );
            identity.children[0].id = 'sa-line-chat-name';
            identity.children[1].id = 'sa-line-chat-subtitle';

            const details = node('button', 'sa-line-header-action');
            details.type = 'button';
            details.id = 'sa-line-character-details';
            details.title = 'Character details';
            details.setAttribute('aria-label', 'Character details');
            details.append(node('i', 'fa-solid fa-circle-info'));
            details.addEventListener('click', () => {
                const drawerIcon = byId('rightNavDrawerIcon');
                if (drawerIcon && drawerIcon.classList.contains('closedIcon')) drawerIcon.click();
                else if (drawerIcon) drawerIcon.click();
            });

            header.append(back, avatar, identity, details);
            sheld.insertBefore(header, chat);
        }
    }

    function mountContacts() {
        void loadRecentChats();
    }

    function formatRecentPreview(value) {
        if (typeof value !== 'string' || !value.trim()) return 'No messages yet';
        return value
            .replace(/<[^>]{1,500}>/g, ' ')
            .replace(/!\[[^\]]*\]\([^)]*\)/g, '[image]')
            .replace(/https?:\/\/\S+/g, 'link')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 112);
    }

    function getRecentChatPresentation(chat) {
        const characterName = chat.char_name || 'Conversation';
        const chatName = (chat.chat_name || characterName).trim();
        const defaultPrefix = characterName + ' - ';

        if (chatName === characterName) {
            return { title: characterName, subtitle: chat.is_group ? 'Group chat' : 'Conversation' };
        }
        if (chatName.startsWith(defaultPrefix)) {
            return { title: characterName, subtitle: chatName.slice(defaultPrefix.length) || 'Conversation' };
        }
        return { title: chatName, subtitle: characterName };
    }

    function createRecentChatRow(chat) {
        const row = node('button', 'sa-line-recent-row');
        row.type = 'button';
        row.dataset.chatId = chat.chat_name || '';
        row.dataset.avatar = chat.avatar || '';
        row.dataset.group = chat.group || '';
        row.title = chat.chat_name || chat.char_name || 'Open conversation';
        row.setAttribute('aria-label', 'Open conversation: ' + (chat.chat_name || chat.char_name || 'Untitled'));

        const avatar = node('span', 'sa-line-recent-avatar');
        avatar.setAttribute('aria-hidden', 'true');
        const fallback = node('i', 'fa-solid ' + (chat.is_group ? 'fa-users' : 'fa-user'));
        const image = node('img', '');
        image.alt = '';
        image.hidden = true;

        if (chat.group) {
            const group = groups.find(item => item.id === chat.group);
            const groupAvatar = getGroupAvatar(group);
            const groupAvatarElement = groupAvatar?.[0];
            if (groupAvatarElement instanceof HTMLElement) {
                avatar.append(groupAvatarElement.cloneNode(true));
            } else {
                avatar.append(fallback);
            }
        } else if (typeof chat.char_thumbnail === 'string' && chat.char_thumbnail) {
            image.src = chat.char_thumbnail;
            image.hidden = false;
            image.addEventListener('error', () => {
                image.hidden = true;
                if (!avatar.contains(fallback)) avatar.append(fallback);
            }, { once: true });
            avatar.append(image, fallback);
            fallback.hidden = true;
        } else {
            avatar.append(fallback);
        }

        const body = node('span', 'sa-line-recent-copy');
        const top = node('span', 'sa-line-recent-topline');
        const presentation = getRecentChatPresentation(chat);
        top.append(node('strong', 'sa-line-recent-title', presentation.title));

        const meta = node('span', 'sa-line-recent-meta');
        if (chat.pinned) {
            const pin = node('i', 'fa-solid fa-thumbtack');
            pin.title = 'Pinned conversation';
            pin.setAttribute('aria-label', 'Pinned');
            meta.append(pin);
        }
        meta.append(node('time', 'sa-line-recent-date', chat.date_short || ''));
        top.append(meta);

        const subline = node('span', 'sa-line-recent-subtitle', presentation.subtitle);
        const preview = node('span', 'sa-line-recent-preview', formatRecentPreview(chat.mes));
        body.append(top, subline, preview);
        row.append(avatar, body);

        row.addEventListener('click', async () => {
            if (row.disabled) return;
            row.disabled = true;
            row.classList.add('is-opening');
            try {
                if (chat.group) {
                    await openRecentGroupChat(chat.group, chat.chat_name);
                } else if (chat.avatar) {
                    await openRecentCharacterChat(chat.avatar, chat.chat_name);
                }
                if (isMobile()) document.body.dataset.saMobileScreen = 'chat';
                syncActiveContact();
                queueRecentChatsRefresh();
            } finally {
                row.disabled = false;
                row.classList.remove('is-opening');
            }
        });

        return row;
    }

    function renderRecentChats() {
        const list = byId('sa-line-contacts-slot');
        const search = byId('sa-line-chat-search');
        if (!list) return;

        const query = (search?.value || '').trim().toLocaleLowerCase();
        const filtered = recentChats.filter(chat => {
            const haystack = [chat.chat_name, chat.char_name, chat.mes]
                .filter(value => typeof value === 'string')
                .join(' ')
                .toLocaleLowerCase();
            return !query || haystack.includes(query);
        });

        list.replaceChildren();
        if (!recentChatsLoaded) {
            list.append(node('p', 'sa-line-inbox-status', 'Loading recent chats…'));
            return;
        }
        if (!filtered.length) {
            const empty = node('div', 'sa-line-empty sa-line-inbox-empty');
            empty.append(node('p', '', query
                ? 'No conversations match that search.'
                : 'No recent conversations yet. Start one from your character library.'));
            if (!query) {
                const button = node('button', 'menu_button', 'Browse characters');
                button.type = 'button';
                button.addEventListener('click', () => navigate('characters'));
                empty.append(button);
            }
            list.append(empty);
            updateContactCount(filtered.length);
            return;
        }

        const fragment = document.createDocumentFragment();
        filtered.forEach(chat => {
            const row = createRecentChatRow(chat);
            const selectedGroup = getSelectedGroup();
            const isActive = chat.chat_name === getCurrentChatId()
                && (chat.group ? chat.group === selectedGroup : !selectedGroup);
            row.classList.toggle('is-active', isActive);
            if (isActive) row.setAttribute('aria-current', 'true');
            fragment.append(row);
        });
        list.append(fragment);
        updateContactCount(filtered.length);
    }

    function updateContactCount(count = recentChats.length) {
        const countNode = byId('sa-line-contact-count');
        if (!countNode) return;
        countNode.textContent = count ? String(count) : '';
        countNode.setAttribute('aria-label', count + ' recent conversations');
        countNode.title = count + ' recent conversations';
    }

    async function loadRecentChats(force = false) {
        const list = byId('sa-line-contacts-slot');
        if (!appReady) {
            list?.replaceChildren(node('p', 'sa-line-inbox-status', 'Loading recent chats…'));
            return;
        }
        if (recentChatsPromise) {
            if (!force) return recentChatsPromise;
            await recentChatsPromise;
            return loadRecentChats(true);
        }
        if (recentChatsLoaded && !force) {
            renderRecentChats();
            return;
        }

        list?.replaceChildren(node('p', 'sa-line-inbox-status', 'Loading recent chats…'));

        recentChatsPromise = (async () => {
            try {
                const result = await getRecentChats();
                recentChats = Array.isArray(result) ? result : [];
                recentChatsLoaded = true;
                renderRecentChats();
                syncActiveContact();
            } catch (error) {
                console.error('[SillyAgent UI] Could not load recent chats.', error);
                recentChatsLoaded = false;
                if (list) {
                    list.replaceChildren();
                    const message = node('p', 'sa-line-workspace-status error', 'Could not load recent chats.');
                    const retry = node('button', 'menu_button', 'Retry');
                    retry.type = 'button';
                    retry.addEventListener('click', () => void loadRecentChats(true));
                    list.append(message, retry);
                }
            } finally {
                recentChatsPromise = null;
            }
        })();

        return recentChatsPromise;
    }

    function queueRecentChatsRefresh() {
        window.clearTimeout(recentRefreshTimer);
        recentRefreshTimer = window.setTimeout(() => {
            void loadRecentChats(true);
        }, 280);
    }

    function closeNativeDrawers() {
        document.querySelectorAll('.drawer-icon.openIcon').forEach(icon => {
            if (icon.isConnected) icon.click();
        });
    }

    function openDrawer(selector) {
        const icon = document.querySelector(selector);
        if (!icon) return;
        icon.click();
    }

    function restoreMemoryPanel() {
        const panel = byId('sillyagent_memory_settings');
        if (panel && memoryPlaceholder && memoryPlaceholder.parentNode) {
            memoryPlaceholder.parentNode.insertBefore(panel, memoryPlaceholder);
            memoryPlaceholder.remove();
            memoryPlaceholder = null;
        }
        panel?.classList.remove('sa-line-memory-popout');
    }

    function mountMemoryPanel() {
        const slot = byId('sa-line-page-body');
        const panel = byId('sillyagent_memory_settings');
        if (!slot || document.body.dataset.saView !== 'memory') return;
        if (panel && panel.parentNode === slot) return;

        slot.replaceChildren();
        if (!panel) {
            const message = node('div', 'sa-line-empty');
            message.append(
                node('p', '', 'SillyAgent Memory is not loaded. Open Extensions and enable the memory extension, then return here.'),
            );
            const button = node('button', 'menu_button', 'Open Extensions');
            button.type = 'button';
            button.addEventListener('click', () => openDrawer('#extensions-settings-button .drawer-icon'));
            message.append(button);
            slot.append(message);
            return;
        }

        if (!memoryPlaceholder && panel.parentNode !== slot) {
            memoryPlaceholder = document.createComment('SillyAgent Memory settings mount point');
            panel.parentNode.insertBefore(memoryPlaceholder, panel);
        }
        if (panel.parentNode !== slot) slot.append(panel);
        panel.classList.add('sa-line-memory-popout');
    }

    function setPageHeading(view) {
        const host = byId('sa-line-page-heading');
        const body = byId('sa-line-page-body');
        if (!host || !body) return;
        host.replaceChildren();

        const title = VIEW_LABELS[view]?.[0] || 'SillyAgent';
        const description = VIEW_LABELS[view]?.[1] || '';
        host.append(node('h1', 'sa-line-page-title', title));
        if (description) host.append(node('p', 'sa-line-page-description', description));
    }

    function setActiveNavigation(view) {
        document.querySelectorAll('#sa-line-rail [data-sa-view]').forEach(button => {
            if (button.dataset.saView === view) {
                button.setAttribute('aria-current', 'page');
            } else {
                button.removeAttribute('aria-current');
            }
        });
    }

    function syncActiveContact() {
        const heading = byId('rm_button_selected_ch')?.querySelector('h2');
        const selectedName = (heading?.textContent || '').trim();
        const currentChatId = getCurrentChatId();
        const currentGroupId = getSelectedGroup() || '';
        const titleNode = byId('sa-line-chat-name');
        const subtitleNode = byId('sa-line-chat-subtitle');
        const imageNode = byId('sa-line-chat-avatar-image');
        const fallbackNode = byId('sa-line-chat-avatar-fallback');
        const rowList = byId('sa-line-contacts-slot');
        let activeRow = null;
        let activeChat = null;

        rowList?.querySelectorAll('.sa-line-recent-row').forEach(row => {
            const matched = !!currentChatId
                && row.dataset.chatId === currentChatId
                && (currentGroupId ? row.dataset.group === currentGroupId : !row.dataset.group);
            row.classList.toggle('is-active', matched);
            if (matched) {
                row.setAttribute('aria-current', 'true');
                activeRow = row;
                activeChat = recentChats.find(chat => chat.chat_name === currentChatId
                    && (currentGroupId ? chat.group === currentGroupId : !chat.group));
            } else {
                row.removeAttribute('aria-current');
            }
        });

        if (titleNode) titleNode.textContent = selectedName || 'Choose a conversation';
        if (subtitleNode) {
            const chatName = activeChat?.chat_name || currentChatId || '';
            subtitleNode.textContent = activeChat && chatName !== selectedName
                ? chatName
                : selectedName ? 'Conversation' : 'Select a recent chat to begin';
        }

        if (imageNode) {
            const avatar = activeRow?.querySelector('.sa-line-recent-avatar img');
            const src = avatar?.getAttribute('src') || '';
            if (src && src !== 'data:,') {
                imageNode.src = src;
                imageNode.hidden = false;
                if (fallbackNode) fallbackNode.hidden = true;
            } else {
                imageNode.removeAttribute('src');
                imageNode.hidden = true;
                if (fallbackNode) fallbackNode.hidden = false;
            }
        }
    }

    function showWorkspace(view) {
        restoreMemoryPanel();
        closeNativeDrawers();

        document.body.dataset.saView = view;
        setActiveNavigation(view);
        setPageHeading(view);

        if (view === 'agent') loadTools();
        if (view === 'memory') mountMemoryPanel();
    }

    async function loadTools(force = false) {
        const body = byId('sa-line-page-body');
        if (!body || document.body.dataset.saView !== 'agent') return;
        if (toolsLoading || (toolsLoaded && !force)) return;

        toolsLoading = true;
        body.replaceChildren(node('p', 'sa-line-workspace-status', 'Loading registered tools…'));
        try {
            const response = await fetch('/api/agent/tools', { headers: { 'Accept': 'application/json' } });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(payload?.error?.message || 'Could not load the tool registry (' + response.status + ').');
            }

            const tools = Array.isArray(payload.tools) ? payload.tools : [];
            body.replaceChildren();

            const sectionHeader = node('div', 'sa-line-section-heading');
            sectionHeader.append(node('span', '', 'Available to chat generation'), node('span', '', tools.length + ' tools'));
            body.append(sectionHeader);

            if (!tools.length) {
                body.append(node('p', 'sa-line-empty', 'No tools are currently registered for the chat agent.'));
                toolsLoaded = true;
                return;
            }

            const list = node('div', 'sa-line-tool-list');
            for (const item of tools) {
                const definition = item?.function || item || {};
                const card = node('article', 'sa-line-tool-item');
                card.append(
                    node('code', 'sa-line-tool-name', definition.name || 'Unnamed tool'),
                    node('p', 'sa-line-tool-description', definition.description || 'No description available.'),
                );

                const details = node('details', 'sa-line-tool-schema');
                details.append(node('summary', '', 'Input schema'));
                const schema = node('pre', '');
                schema.textContent = JSON.stringify(definition.parameters || {}, null, 2);
                details.append(schema);
                card.append(details);
                list.append(card);
            }
            body.append(list);
            toolsLoaded = true;
        } catch (error) {
            body.replaceChildren();
            const message = node('p', 'sa-line-workspace-status error', error.message || 'Could not load the tool registry.');
            const retry = node('button', 'menu_button', 'Retry');
            retry.type = 'button';
            retry.addEventListener('click', () => loadTools(true));
            body.append(message, retry);
        } finally {
            toolsLoading = false;
        }
    }

    function navigate(view) {
        if (view === 'chats') {
            restoreMemoryPanel();
            closeNativeDrawers();
            document.body.dataset.saView = 'chats';
            document.body.dataset.saMobileScreen = isMobile() && !getCurrentChatId() ? 'list' : 'chat';
            mountContacts();
            setActiveNavigation('chats');
            syncActiveContact();
            return;
        }

        if (view === 'characters') {
            restoreMemoryPanel();
            closeNativeDrawers();
            document.body.dataset.saView = 'characters';
            setActiveNavigation('characters');
            openDrawer('#rightNavDrawerIcon');
            return;
        }

        if (view === 'settings') {
            restoreMemoryPanel();
            closeNativeDrawers();
            document.body.dataset.saView = 'settings';
            setActiveNavigation('settings');
            openDrawer('#user-settings-button .drawer-icon');
            return;
        }

        showWorkspace(view);
    }

    function handleNavigationClick(event) {
        const button = event.target.closest('[data-sa-view]');
        if (!button || !byId('sa-line-rail')?.contains(button)) return;
        event.preventDefault();
        const view = button.dataset.saView;
        if (view === 'chats' && document.body.dataset.saView === 'chats' && isMobile()) {
            document.body.dataset.saMobileScreen = 'list';
            return;
        }
        navigate(view);
    }

    function observeMemoryExtension() {
        if (memoryObserver) memoryObserver.disconnect();
        memoryObserver = new MutationObserver(() => {
            if (document.body.dataset.saView === 'memory' && byId('sillyagent_memory_settings')) {
                mountMemoryPanel();
            }
        });
        memoryObserver.observe(document.body, { childList: true, subtree: true });
    }

    function init() {
        if (uiInitialized || !document.body || !byId('sheld') || !byId('right-nav-panel')) return;
        uiInitialized = true;
        buildShell();
        document.body.classList.add('sa-line-ui');
        document.body.dataset.saView = 'chats';
        document.body.dataset.saMobileScreen = isMobile() && !getCurrentChatId() ? 'list' : 'chat';

        mountContacts();
        setActiveNavigation('chats');
        syncActiveContact();
        observeMemoryExtension();

        byId('sa-line-rail')?.addEventListener('click', handleNavigationClick);

        const selectedCharacter = byId('rm_button_selected_ch');
        if (selectedCharacter) {
            new MutationObserver(() => window.setTimeout(syncActiveContact, 0))
                .observe(selectedCharacter, { childList: true, subtree: true, characterData: true });
        }
        window.addEventListener('resize', () => {
            if (document.body.dataset.saView === 'chats' && !isMobile()) {
                document.body.dataset.saMobileScreen = 'chat';
            }
        }, { passive: true });

        console.info('[SillyAgent UI] Chat-first interface ready.');
    }

    function showCoreInitializationError(error) {
        appReady = false;
        const list = byId('sa-line-contacts-slot');
        if (list) {
            const message = node('div', 'sa-line-empty');
            message.append(
                node('p', '', 'SillyTavern could not finish initializing, so chat data is unavailable.'),
                node('p', 'sa-line-workspace-status error', error?.message || 'Core initialization failed.'),
                node('p', 'sa-line-inbox-status', 'Check the Termux log for the first error above this message.'),
            );
            list.replaceChildren(message);
        }
        console.error('[SillyAgent UI] Core initialization failed; LINE shell remains available.', error);
    }

    async function connectCore() {
        try {
            const [core, welcome, groupModule] = await Promise.all([
                import('../script.js'),
                import('./welcome-screen.js'),
                import('./group-chats.js'),
            ]);

            eventSource = core.eventSource;
            event_types = core.event_types;
            getCurrentChatId = core.getCurrentChatId;
            getRecentChats = welcome.getRecentChats;
            openRecentCharacterChat = welcome.openRecentCharacterChat;
            openRecentGroupChat = welcome.openRecentGroupChat;
            getGroupAvatar = groupModule.getGroupAvatar;
            groups = groupModule.groups;
            groupChatsModule = groupModule;

            appReady = true;
            eventSource.on(event_types.CHAT_CHANGED, () => {
                window.setTimeout(() => {
                    if (isMobile() && document.body.dataset.saView === 'chats' && getCurrentChatId()) {
                        document.body.dataset.saMobileScreen = 'chat';
                    }
                    syncActiveContact();
                    queueRecentChatsRefresh();
                }, 80);
            });
            eventSource.on(event_types.CHAT_RENAMED, queueRecentChatsRefresh);
            eventSource.on(event_types.CHAT_DELETED, queueRecentChatsRefresh);
            eventSource.on(event_types.APP_READY, () => {
                appReady = true;
                void loadRecentChats(true);
            });

            document.body.dataset.saMobileScreen = isMobile() && !getCurrentChatId() ? 'list' : 'chat';
            syncActiveContact();
            void loadRecentChats(true);
        } catch (error) {
            showCoreInitializationError(error);
        }
    }

    // Mount the shell independently of the main app module so initialization failures
    // are visible rather than leaving the whole page blank.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            init();
            void connectCore();
        }, { once: true });
    } else {
        init();
        void connectCore();
    }
})();
