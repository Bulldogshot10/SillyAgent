(() => {
    'use strict';

    const VIEW_LABELS = {
        chats: ['Chats', 'Choose a conversation from your character list.'],
        agent: ['Agent tools', 'A live inventory of tools available to chat generation.'],
        memory: ['Memory', 'Review proposals and manage the memories SillyAgent keeps.'],
    };

    let contactsPlaceholder = null;
    let memoryPlaceholder = null;
    let memoryObserver = null;
    let toolsLoaded = false;
    let toolsLoading = false;

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
            node('span', 'sa-line-contacts-subtitle', 'Your character inbox'),
        );
        contactsHeader.append(titleWrap, node('span', '', ''));
        contactsHeader.lastElementChild.id = 'sa-line-contact-count';

        const contactsSlot = node('div', '');
        contactsSlot.id = 'sa-line-contacts-slot';
        contacts.append(contactsHeader, contactsSlot);

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

    function findCharacterList() {
        return byId('rm_characters_block');
    }

    function mountContacts() {
        const block = findCharacterList();
        const host = byId('sa-line-contacts-slot');
        if (!block || !host) return;

        if (!contactsPlaceholder && block.parentNode !== host) {
            contactsPlaceholder = document.createComment('SillyAgent chat-list mount point');
            block.parentNode.insertBefore(contactsPlaceholder, block);
        }
        if (block.parentNode !== host) host.append(block);
        block.classList.add('sa-line-contact-list');
        syncActiveContact();
    }

    function restoreContacts() {
        const block = findCharacterList();
        if (block && contactsPlaceholder && contactsPlaceholder.parentNode) {
            contactsPlaceholder.parentNode.insertBefore(block, contactsPlaceholder);
            contactsPlaceholder.remove();
            contactsPlaceholder = null;
        }
        block?.classList.remove('sa-line-contact-list');
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

    function updateContactCount() {
        const countNode = byId('sa-line-contact-count');
        const list = byId('rm_print_characters_block');
        if (!countNode || !list) return;
        const count = list.querySelectorAll('.character_select').length;
        countNode.textContent = count ? String(count) : '';
        countNode.setAttribute('aria-label', count + ' characters');
    }

    function syncActiveContact() {
        const heading = byId('rm_button_selected_ch')?.querySelector('h2');
        const name = (heading?.textContent || '').trim();
        const titleNode = byId('sa-line-chat-name');
        const subtitleNode = byId('sa-line-chat-subtitle');
        const imageNode = byId('sa-line-chat-avatar-image');
        const fallbackNode = byId('sa-line-chat-avatar-fallback');
        const rowList = byId('rm_print_characters_block');
        let activeRow = null;

        if (rowList) {
            rowList.querySelectorAll('.character_select').forEach(row => {
                const rowName = (row.querySelector('.ch_name')?.textContent || '').trim();
                const matched = !!name && rowName === name;
                row.classList.toggle('sa-current-chat', matched);
                if (matched) activeRow = row;
            });
        }

        if (titleNode) titleNode.textContent = name || 'Choose a character';
        if (subtitleNode) subtitleNode.textContent = name ? 'Conversation' : 'Select someone from Chats to begin';
        if (imageNode) {
            const avatar = activeRow?.querySelector('.avatar img');
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
        updateContactCount();
    }

    function showWorkspace(view) {
        restoreContacts();
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
            restoreContacts();
            closeNativeDrawers();
            document.body.dataset.saView = 'chats';
            document.body.dataset.saMobileScreen = isMobile() ? 'list' : 'chat';
            mountContacts();
            setActiveNavigation('chats');
            syncActiveContact();
            return;
        }

        if (view === 'characters') {
            restoreMemoryPanel();
            restoreContacts();
            closeNativeDrawers();
            document.body.dataset.saView = 'characters';
            setActiveNavigation('characters');
            openDrawer('#rightNavDrawerIcon');
            return;
        }

        if (view === 'settings') {
            restoreMemoryPanel();
            restoreContacts();
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
        if (!document.body || !byId('sheld') || !byId('right-nav-panel')) return;
        buildShell();
        document.body.classList.add('sa-line-ui');
        document.body.dataset.saView = 'chats';
        document.body.dataset.saMobileScreen = isMobile() ? 'list' : 'chat';

        mountContacts();
        setActiveNavigation('chats');
        syncActiveContact();
        observeMemoryExtension();

        byId('sa-line-rail')?.addEventListener('click', handleNavigationClick);

        byId('sa-line-contacts-slot')?.addEventListener('click', event => {
            if (!event.target.closest('.character_select')) return;
            window.setTimeout(() => {
                syncActiveContact();
                if (isMobile()) document.body.dataset.saMobileScreen = 'chat';
            }, 180);
        });

        const selectedCharacter = byId('rm_button_selected_ch');
        if (selectedCharacter) {
            new MutationObserver(() => window.setTimeout(syncActiveContact, 0))
                .observe(selectedCharacter, { childList: true, subtree: true, characterData: true });
        }
        const characterList = byId('rm_print_characters_block');
        if (characterList) {
            new MutationObserver(() => {
                window.setTimeout(syncActiveContact, 0);
            }).observe(characterList, { childList: true, subtree: true });
        }
        window.addEventListener('resize', () => {
            if (document.body.dataset.saView === 'chats' && !isMobile()) {
                document.body.dataset.saMobileScreen = 'chat';
            }
        }, { passive: true });

        console.info('[SillyAgent UI] Chat-first interface ready.');
    }

    if (document.readyState === 'complete') {
        init();
    } else {
        window.addEventListener('load', init, { once: true });
    }
})();
