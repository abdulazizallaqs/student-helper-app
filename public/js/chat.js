// Telegram-style messaging UI for chat.html: a conversation list on the
// left (people already messaged, plus everyone else you can start a new
// conversation with) and the active thread on the right. Polls for new
// messages while a thread is open so replies show up without a refresh.

(() => {
  /** Translate at render time; English fallback if i18n.js has not loaded. */
  const t = (key, fallback) =>
    (typeof window.t === 'function' ? window.t(key, fallback) : fallback);

  let currentUser = null; // { id, username }
  let allUsers = [];
  let conversations = [];
  let activeUserId = null;
  let pollTimer = null;

  const chatShell = document.getElementById('chat-shell');
  const chatList = document.getElementById('chat-list');
  const chatSearch = document.getElementById('chat-search');
  const chatMainEmpty = document.getElementById('chat-main-empty');
  const chatMainActive = document.getElementById('chat-main-active');
  const chatThread = document.getElementById('chat-thread');
  const chatPartnerName = document.getElementById('chat-partner-name');
  const chatPartnerAvatar = document.getElementById('chat-partner-avatar');
  const chatSendForm = document.getElementById('chat-send-form');
  const chatInput = document.getElementById('chat-input');
  const chatBackBtn = document.getElementById('chat-back-btn');

  function initials(name) {
    if (!name) return '?';
    return name.trim().charAt(0).toUpperCase();
  }

  function formatTime(dateStr) {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  async function loadCurrentUser() {
    const res = await fetch('/api/session/me');
    if (!res.ok) throw new Error('Not logged in');
    currentUser = await res.json();
  }

  async function loadConversations() {
    const res = await fetch('/messages/conversations');
    if (!res.ok) throw new Error('Failed to load conversations');
    conversations = await res.json();
  }

  async function loadAllUsers() {
    const res = await fetch('/msg');
    if (!res.ok) throw new Error('Failed to load users');
    allUsers = await res.json();
  }

  function buildListEntries(filterText) {
    const filter = (filterText || '').trim().toLowerCase();
    const convoIds = new Set(conversations.map((c) => c.userId));

    const others = allUsers
      .filter((u) => u.userId !== currentUser.id && !convoIds.has(u.userId))
      .sort((a, b) => (a.username || '').localeCompare(b.username || ''));

    const entries = [
      ...conversations.map((c) => ({
        userId: c.userId,
        username: c.username,
        name: c.name,
        lastMessage: c.lastMessage,
        lastMessageAt: c.lastMessageAt,
        isNew: false
      })),
      ...others.map((u) => ({
        userId: u.userId,
        username: u.username,
        name: u.name,
        lastMessage: null,
        lastMessageAt: null,
        isNew: true
      }))
    ];

    if (!filter) return entries;
    return entries.filter((e) =>
      (e.username || '').toLowerCase().includes(filter) ||
      (e.name || '').toLowerCase().includes(filter)
    );
  }

  function renderList() {
    const entries = buildListEntries(chatSearch.value);

    if (entries.length === 0) {
      chatList.innerHTML = `<div class="chat-list-empty">${escapeHtml(t('chat.noMatch', 'No one matches your search.'))}</div>`;
      return;
    }

    chatList.innerHTML = '';
    entries.forEach((entry) => {
      const item = document.createElement('div');
      item.className = 'chat-list-item' + (entry.userId === activeUserId ? ' is-active' : '');
      item.dataset.userId = String(entry.userId);

      const preview = entry.isNew
        ? `<span style="color: var(--sh-accent);">${escapeHtml(t('chat.sayHello', 'Say hello'))} 👋</span>`
        : escapeHtml(entry.lastMessage || '');

      item.innerHTML = `
        <div class="chat-list-avatar">${initials(entry.name || entry.username)}</div>
        <div class="chat-list-body">
          <div class="chat-list-top">
            <span class="chat-list-name">${escapeHtml(entry.name || entry.username)}</span>
            <span class="chat-list-time">${entry.lastMessageAt ? formatTime(entry.lastMessageAt) : ''}</span>
          </div>
          <div class="chat-list-preview">${preview}</div>
        </div>
      `;
      item.addEventListener('click', () => openThread(entry.userId, entry.name || entry.username));
      chatList.appendChild(item);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  // Signature of the rendered thread, so a poll that returns nothing new
  // does not rebuild the DOM (which reset the scroll position every few
  // seconds while you were reading back through a conversation).
  let renderedSignature = null;

  function renderThread(messages, force) {
    const signature = messages.map((m) => `${m.id}:${m.content.length}`).join('|');
    if (!force && signature === renderedSignature) return;
    renderedSignature = signature;

    // Only stick to the bottom if the user was already there.
    const wasAtBottom =
      chatThread.scrollHeight - chatThread.scrollTop - chatThread.clientHeight < 60;

    chatThread.innerHTML = '';
    if (messages.length === 0) {
      chatThread.innerHTML = `<div class="chat-list-empty">${escapeHtml(t('chat.noMessages', 'No messages yet - say hello!'))}</div>`;
      return;
    }
    messages.forEach((m) => {
      const row = document.createElement('div');
      row.className = `msg-bubble-row ${m.direction === 'sent' ? 'is-sent' : 'is-received'}`;

      const bubble = document.createElement('div');
      bubble.className = 'msg-bubble';
      bubble.textContent = m.content;

      const time = document.createElement('span');
      time.className = 'msg-bubble-time';
      time.textContent = formatTime(m.sentAt);
      bubble.appendChild(time);

      row.appendChild(bubble);
      chatThread.appendChild(row);
    });
    if (wasAtBottom || force) chatThread.scrollTop = chatThread.scrollHeight;
  }

  async function openThread(userId, displayName) {
    activeUserId = userId;
    chatShell.classList.add('is-thread-open');
    chatMainEmpty.style.display = 'none';
    chatMainActive.style.display = 'flex';
    chatPartnerName.textContent = displayName;
    chatPartnerAvatar.textContent = initials(displayName);
    chatThread.innerHTML = `<div class="chat-list-empty">${escapeHtml(t('common.loading', 'Loading...'))}</div>`;
    renderedSignature = null;

    renderList();

    try {
      const res = await fetch(`/messages/thread/${userId}`);
      if (!res.ok) throw new Error('Failed to load thread');
      const messages = await res.json();
      if (activeUserId === userId) renderThread(messages, true);
    } catch (error) {
      console.error('Error loading thread:', error);
      notifyChat(t('chat.threadError', 'Could not load that conversation'), 'error');
    }

    startPolling();
  }

  function closeThread() {
    activeUserId = null;
    chatShell.classList.remove('is-thread-open');
    chatMainEmpty.style.display = 'flex';
    chatMainActive.style.display = 'none';
    stopPolling();
  }

  // Poll interval.
  //
  // This was 4 seconds, which is 900 requests an hour from a single open tab.
  // The app-wide rate limiter allowed 300 requests per 15 minutes and counted
  // static assets too, so a chat left open exhausted the budget and then
  // EVERY request - including sending a message - came back 429. The limiter
  // is fixed (middleware/rateLimiters.js) and this is gentler as well.
  const POLL_INTERVAL_MS = 7000;

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
  }

  async function pollOnce() {
    // Nothing open, or the tab is in the background: skip the round trip.
    if (!activeUserId || document.hidden) return;
    const pollingFor = activeUserId;
    try {
      const res = await fetch(`/messages/thread/${pollingFor}`);
      if (!res.ok) return;
      const messages = await res.json();
      // The user may have switched conversations while this was in flight.
      if (activeUserId === pollingFor) renderThread(messages);
    } catch (error) {
      // Silent - a missed poll tick isn't worth interrupting the user.
    }
  }

  // Catch up immediately when the tab comes back to the foreground, instead
  // of waiting out a full interval.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pollOnce();
  });

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function refreshSidebar() {
    try {
      await loadConversations();
      renderList();
    } catch (error) {
      console.error('Error refreshing conversations:', error);
    }
  }

  function notifyChat(message, type) {
    if (typeof showToast === 'function') showToast(message, type);
    else alert(message);
  }

  /**
   * Turn a failed response into something the user can act on.
   *
   * Every failure here used to end up as `console.error` plus a generic
   * "Message failed to send" toast, or nothing at all - so the three
   * different real causes (session expired, rate limited, validation
   * rejected the message) were indistinguishable, and the symptom people
   * reported was just "I send a message and nothing happens".
   */
  async function describeFailure(res) {
    if (res.status === 401) return t('common.sessionExpired', 'Your session has expired. Please log in again.');
    if (res.status === 429) return t('chat.tooFast', 'You are sending messages too quickly - wait a moment and try again.');
    if (res.status === 403) return t('chat.blocked', 'That request was blocked. Reload the page and try again.');

    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (body && body.message) return body.message;
    if (body && body.error) return body.error;
    return `${t('chat.blocked', 'That request was blocked.')} (${res.status})`;
  }

  chatSendForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const content = chatInput.value.trim();

    if (!content) return;
    if (!activeUserId) {
      notifyChat(t('chat.pickFirst', 'Pick someone from the list first.'), 'warning');
      return;
    }

    const sendButton = chatSendForm.querySelector('button[type=submit]');
    if (sendButton) sendButton.disabled = true;
    // Keep the text until the send actually succeeds. Clearing it first meant
    // a failed send silently destroyed what the user had typed.
    const previousValue = chatInput.value;
    chatInput.value = '';

    try {
      const res = await fetch('/add-msg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // receiver must be a number: express-validator's isInt() check on the
        // server rejects it otherwise, and the id can arrive as a string when
        // it came from a DOM dataset.
        body: JSON.stringify({ receiver: Number(activeUserId), content })
      });

      if (!res.ok) {
        chatInput.value = previousValue;
        const reason = await describeFailure(res);
        notifyChat(reason, 'error');
        if (res.status === 401) setTimeout(() => { window.location.href = '/login'; }, 1500);
        return;
      }

      const res2 = await fetch(`/messages/thread/${activeUserId}`);
      if (res2.ok) {
        renderThread(await res2.json(), true);
      } else {
        notifyChat(t('chat.sendFailedRefresh', 'Message sent, but the conversation could not be refreshed.'), 'warning');
      }

      refreshSidebar();
    } catch (error) {
      console.error('Error sending message:', error);
      chatInput.value = previousValue;
      notifyChat(t('chat.noServer', 'Could not reach the server. Check your connection.'), 'error');
    } finally {
      if (sendButton) sendButton.disabled = false;
      chatInput.focus();
    }
  });

  chatSearch.addEventListener('input', () => renderList());

  // The list and the open thread are built in JavaScript, so `data-i18n`
  // markup cannot reach them - redraw both when the language is switched.
  window.addEventListener('sh:langchange', async () => {
    if (currentUser) renderList();
    if (activeUserId) {
      try {
        const res = await fetch(`/messages/thread/${activeUserId}`);
        if (res.ok) renderThread(await res.json(), true);
      } catch { /* the next poll will catch up */ }
    }
  });
  chatBackBtn.addEventListener('click', closeThread);

  window.addEventListener('beforeunload', stopPolling);

  (async function init() {
    try {
      await loadCurrentUser();
    } catch (error) {
      console.error('Chat: not signed in.', error);
      chatList.innerHTML = `<div class="chat-list-empty">${escapeHtml(t('chat.pleaseLogin', 'Please log in to view your messages.'))}</div>`;
      setTimeout(() => { window.location.href = '/login'; }, 1500);
      return;
    }

    try {
      await Promise.all([loadConversations(), loadAllUsers()]);
      renderList();
    } catch (error) {
      // Signed in, but the data would not load - a different problem, and it
      // used to be reported with the same "please log in" message, which sent
      // people to re-enter a password that was never the issue.
      console.error('Error loading messages:', error);
      chatList.innerHTML =
        `<div class="chat-list-empty">${escapeHtml(t('chat.loadError', 'Could not load your messages. Please refresh the page.'))}</div>`;
      notifyChat(t('chat.loadError', 'Could not load your messages.'), 'error');
    }
  })();
})();
