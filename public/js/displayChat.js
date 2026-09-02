// Escapes a value for safe insertion into innerHTML. Comment authors and
// comment text are both user-supplied (any logged-in user can post a
// comment on any file), so without this a comment like
// `<img src=x onerror=...>` would run in the browser of every other user
// who opens that file's comments - a classic stored-XSS vector.
/** Translate at render time; English fallback if i18n.js has not loaded. */
function shT(key, fallback) {
    return (typeof window.t === 'function' ? window.t(key, fallback) : fallback);
}

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value === null || value === undefined ? '' : String(value);
    return div.innerHTML;
}

/** Turn a failed response into a message worth showing the user. */
async function describeCommentFailure(response) {
    if (response.status === 401) return shT('common.sessionExpired', 'Your session has expired. Please log in again.');
    if (response.status === 429) return shT('chat.tooFast', 'Too many requests - wait a moment and try again.');
    let body = null;
    try { body = await response.json(); } catch { /* not JSON */ }
    return (body && (body.message || body.error)) || `The server answered ${response.status}.`;
}

function openChat(fileId) {
    const chatHistory = document.getElementById('chatHistory');
    if (chatHistory) chatHistory.innerHTML = `<p class="chat-date">${escapeHtml(shT('display.loadingComments', 'Loading comments...'))}</p>`;

    fetch(`/file-chats/${fileId}`)
        .then(async response => {
            if (!response.ok) {
                throw new Error(await describeCommentFailure(response));
            }
            return response.json();
        })
        .then(data => {
            chatHistory.innerHTML = ''; // Clear previous chats

            if (data.length === 0) {
                chatHistory.innerHTML = `<p class="chat-date">${escapeHtml(shT('display.noComments', 'No comments yet - be the first.'))}</p>`;
                return;
            }

            data.forEach(chat => {
                const chatItem = `
        <div class="chat-item">
          <p><strong>${escapeHtml(chat.username)}:</strong> ${escapeHtml(chat.content)}</p>
          <p class="chat-date">${new Date(chat.chatDate).toLocaleString()}</p>
        </div>
      `;
                chatHistory.innerHTML += chatItem;
            });

            // Save fileId for adding chats
            // modal.dataset.fileId = fileId;
        })
        .catch(error => {
            // This used to fail entirely silently: the comment panel just
            // stayed empty, whether the request had failed, the session had
            // expired, or there genuinely were no comments.
            console.error('Error fetching chats:', error);
            if (chatHistory) {
                chatHistory.innerHTML = `<p class="chat-date">${escapeHtml(shT('display.commentsError', 'Could not load the comments.'))}</p>`;
            }
            if (typeof showToast === 'function') showToast(error.message, 'error');
        });
}


function closeChat() {
    const modal = document.getElementById('chatModal');
    modal.style.display = 'none';
}

function addChat() {
    const input = document.getElementById('newChatText');
    const chatText = input.value.trim();

    const urlParams = new URLSearchParams(window.location.search);
    const fileId = urlParams.get('id');

    if (!chatText) {
        if (typeof showToast === 'function') {
            showToast(shT('display.commentEmpty', 'Write something before posting.'), 'warning');
        }
        return;
    }

    fetch('/add-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // fileId comes out of the URL as a string; the server validates it
        // with isInt(), which accepts a numeric string, but sending a real
        // number removes any doubt.
        body: JSON.stringify({ fileId: Number(fileId), chatText }),
    })
        .then(async response => {
            if (!response.ok) {
                const message = await describeCommentFailure(response);
                if (response.status === 401) {
                    setTimeout(() => { window.location.href = '/login'; }, 1500);
                }
                throw new Error(message);
            }
            return response.json();
        })
        .then(() => {
            input.value = ''; // Clear input only once it actually posted
            openChat(fileId); // Refresh the list so the new comment shows
        })
        .catch(error => {
            // Posting a comment used to fail with nothing but a console line:
            // the box kept its text, the list did not change, and there was
            // no indication anything had gone wrong.
            console.error('Error adding chat:', error);
            if (typeof showToast === 'function') showToast(error.message, 'error');
        });
}
function searchChats() {
    const searchTerm = document
        .getElementById('searchInput')
        .value.trim()
        .toLowerCase();

    const chatItems = document.querySelectorAll('.chat-item');

    chatItems.forEach(chatItem => {
        const chatText = chatItem.querySelector('p').innerText.toLowerCase();
        if (chatText.includes(searchTerm)) {
            chatItem.style.display = 'block'; // Show matching chat
        } else {
            chatItem.style.display = 'none'; // Hide non-matching chat
        }
    });
}

/////////////////////////////////////////////////

function addToFavorites(fileId) {
    fetch('/add-to-favorites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId }),
    })
        .then(async response => {
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.message || 'Failed to add to favorites.');
            }
            return data;
        })
        .then(data => {
            // Display.html has a dedicated inline confirmation message; every other
            // page (file cards) doesn't have that element, so fall back to the
            // shared toast helper there.
            const inlineMessage = document.getElementById('addFavorit');
            if (inlineMessage) {
                inlineMessage.style.display = 'inline';
                setTimeout(() => {
                    inlineMessage.style.display = 'none';
                }, 3000);
            } else if (typeof showToast === 'function') {
                showToast(data.message || 'Added to favorites.', data.alreadyExists ? 'info' : 'success');
            }
        })
        .catch(error => {
            console.error('Error adding to favorites:', error);
            if (typeof showToast === 'function') {
                showToast(error.message || 'Failed to add to favorites.', 'error');
            }
        });
}

////////////////////////////
function showCustomModal({ title, message, confirmText, cancelText, onConfirm, onCancel }) {
    const modal = document.getElementById('deleteConfirmationModal');
    const modalTitle = document.getElementById('modalTitle');
    const modalMessage = document.getElementById('modalMessage');
    const confirmButton = document.getElementById('confirmDeleteBtn');
    const cancelButton = document.getElementById('cancelDeleteBtn');

    // Set the title and message
    modalTitle.textContent = title;
    modalMessage.textContent = message;

    // Set the button text
    confirmButton.textContent = confirmText;
    cancelButton.textContent = cancelText;

    // Set up event listeners
    confirmButton.onclick = function () {
        onConfirm();
        modal.style.display = 'none'; // Close the modal
    };

    cancelButton.onclick = function () {
        if (onCancel) {
            onCancel();
        }
        modal.style.display = 'none'; // Close the modal
    };

    // Show the modal
    modal.style.display = 'block';
}

function deleteFavorite(favoritId) {
    fetch(`/favorite/${favoritId}`, {
        method: 'DELETE',
    })
        .then(response => {
            if (!response.ok) {
                throw new Error('Failed to delete favorite.');
            }
            return response.json();
        })
        .then(data => {
            // Show success toast
            if (typeof showToast === 'function') {
                showToast(shT('files.removeFavorite', 'Removed from favourites'), 'success');
            }

            // Remove the card from DOM using data attribute
            const card = document.querySelector(`[data-favorite-id="${favoritId}"]`);
            if (card) {
                card.style.transition = 'opacity 0.3s ease';
                card.style.opacity = '0';
                setTimeout(() => card.remove(), 300);
            }
        })
        .catch(error => {
            console.error('Error deleting favorite:', error);
            if (typeof showToast === 'function') {
                showToast('Failed to remove favorite', 'error');
            }
        });
}


function confirmDeletion(favoritId) {
    showCustomModal({
        title: shT('edit.confirmTitle', 'Confirm Deletion'),
        message: shT('edit.confirmFavorite', 'Are you sure you want to remove this from your favourites?'),
        confirmText: shT('edit.confirmYes', 'Yes, Delete'),
        cancelText: shT('edit.confirmNo', 'Cancel'),
        onConfirm: () => deleteFavorite(favoritId),
        onCancel: () => console.log('Deletion canceled.'),
    });
}


// delete file
function deleteFile(fileId) {
    showCustomModal({
        title: shT('edit.confirmTitle', 'Confirm Deletion'),
        message: shT('edit.confirmFile', 'Are you sure you want to delete this file?'),
        confirmText: shT('edit.confirmYes', 'Yes, Delete'),
        cancelText: shT('edit.confirmNo', 'Cancel'),
        onConfirm: () => removeFile(fileId),
        onCancel: () => console.log('Deletion canceled.'),
    });
}

function removeFile(fileId) {
    const userId = window.currentUserId;
    fetch(`/file-page-myfile/${fileId}`, {
        method: 'DELETE',
    })
        .then(response => {
            if (!response.ok) {
                throw new Error('Failed to delete file.');
            }
            return response.json();
        })
        .then(data => {
            if (typeof showToast === 'function') {
                showToast('File deleted successfully!', 'success');
            }
            setTimeout(() => location.reload(), 1000);
        })
        .catch(error => {
            console.error('Error deleting file:', error);
            if (typeof showToast === 'function') {
                showToast('Failed to delete file', 'error');
            }
        });
}



// modify file
function modify(fileId) {
    const modal = document.getElementById('updateModal');
    modal.style.display = 'block';

    // Was `/get-file/${fileId}` - a route that does not exist anywhere in the
    // app. The 404 handler answers with valid JSON, so `.then(file => ...)`
    // still ran, every field came back undefined, and the form was populated
    // with the literal string "undefined" - which then got SAVED over the
    // file's real title and description on submit. The real endpoint is
    // `/file/:id` (fileRoutes -> fileController.getFileById).
    fetch(`/file/${fileId}`)
        .then(response => {
            if (!response.ok) throw new Error(`Could not load file ${fileId} (${response.status})`);
            return response.json();
        })
        .then(file => {
            // Populate form fields with file data
            document.querySelector('#fileId').value = file.id;
            document.querySelector('#title').value = file.title;
            document.querySelector('#description').value = file.description;

            // Populate categories dropdown
            fetch('/categories') // Adjust this to your categories endpoint
                .then(response => response.json())
                .then(categories => {
                    const categorySelect = document.querySelector('#categoryFile');
                    categorySelect.innerHTML = `<option value="" disabled>${escapeHtml(shT('edit.chooseCategory', 'Choose a category'))}</option>`;
                    categories.forEach(category => {
                        categorySelect.innerHTML += `
            <option value="${category.id}" ${category.id === file.categoryID ? 'selected' : ''}>
              ${escapeHtml(category.name)}
            </option>
          `;
                    });
                });

            document.querySelector('#updateModal').style.display = 'block';
        })
        .catch(error => {
            // Never leave the form populated with junk - close it and say so,
            // rather than silently letting the user save "undefined" over
            // their own file.
            console.error('Error loading file for edit:', error);
            modal.style.display = 'none';
            if (typeof showToast === 'function') {
                showToast('Could not load this file for editing.', 'error');
            }
        });
}

// The submit handler is bound ONCE, here - not inside modify().
//
// It used to be registered inside modify(), which meant every click of an edit
// (pencil) button added ANOTHER listener, each closing over the file id it was
// opened with. Submitting once then fired all of them: opening the editor for
// file A, closing it, opening it for file B and saving sent PUT /update-file/A
// *and* PUT /update-file/B, both carrying B's values - so file A was silently
// overwritten with file B's title and description. Confirmed in a real browser:
// one save renamed two different files. With N modals opened, N files were hit.
//
// Binding once and reading the id from the hidden #fileId input (which modify()
// populates) means exactly one request always goes to exactly the file on screen.
function initUpdateFormHandler() {
    const form = document.getElementById('updateForm');
    if (!form || form.dataset.submitBound === 'true') return;
    form.dataset.submitBound = 'true';

    form.addEventListener('submit', (event) => {
        event.preventDefault(); // Prevent form from submitting traditionally

        const fileId = document.getElementById('fileId').value;
        if (!fileId) {
            console.error('Update aborted: no file id on the form.');
            return;
        }

        const title2 = document.getElementById('title').value;
        const description2 = document.getElementById('description').value;
        const category2 = document.getElementById('categoryFile').value;

        const updatedData = {
            ...(title2 && { title2 }),
            ...(description2 && { description2 }),
            ...(category2 && { category2 })
        };

        fetch(`/update-file/${fileId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(updatedData),
        })
            .then(response => response.json())
            .then(data => {
                if (!data.success && typeof showToast === 'function') {
                    showToast(data.message || 'Could not update this file.', 'error');
                    return;
                }
                window.location.href = '/views/file-page-myfile.html';
            })
            .catch(error => {
                console.error('Error updating file:', error);
                if (typeof showToast === 'function') {
                    showToast('Could not update this file.', 'error');
                }
            });
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUpdateFormHandler);
} else {
    initUpdateFormHandler();
}

function closeUpdate() {
    const modal = document.getElementById('updateModal');
    modal.style.display = 'none';
}



