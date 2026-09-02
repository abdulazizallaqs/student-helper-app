// Functions for managing message modal

/**
 * Open the "send a message" dialog.
 *
 * @param {number} [_fileId]   - unused; the card passes it for context
 * @param {string} [recipient] - username to pre-select. The Chat button on a
 *   file card is about that file's uploader, but the dialog used to open with
 *   an empty picker, so the user had to find that person again in a list of
 *   everyone.
 */
function openMsg(_fileId, recipient) {
    const modal = document.getElementById('msg');
    if (modal) {
        modal.style.display = 'block';
        loadReceivers(recipient);
    }
}

function closeMsg() {
    const modal = document.getElementById('msg');
    if (modal) {
        modal.style.display = 'none';
        // Reset form
        const form = document.getElementById('add-message');
        if (form) form.reset();
        // Remove success message if exists
        const successMsg = document.getElementById('msg-success');
        if (successMsg) successMsg.style.display = 'none';
    }
}

function loadReceivers(preselectUsername) {
    const receiverSelect = document.getElementById('receiver');
    if (!receiverSelect) return;

    // Fetch users from backend
    fetch('/msg')
        .then(response => {
            if (!response.ok) {
                throw new Error('Failed to fetch receivers');
            }
            return response.json();
        })
        .then(data => {
            receiverSelect.innerHTML = '<option value="" disabled selected>Choose a receiver</option>';
            data.forEach(user => {
                const option = document.createElement('option');
                option.value = user.userId;
                option.textContent = user.username;
                receiverSelect.appendChild(option);
            });

            if (preselectUsername) {
                const match = data.find(u => u.username === preselectUsername);
                if (match) receiverSelect.value = String(match.userId);
            }
        })
        .catch(error => {
            console.error('Error fetching receivers:', error);
        });
}

// Handle message form submission with AJAX
document.addEventListener('DOMContentLoaded', () => {
    const messageForm = document.getElementById('add-message');
    if (messageForm) {
        messageForm.addEventListener('submit', (e) => {
            e.preventDefault(); // Prevent traditional form submission

            const formData = new FormData(messageForm);
            const data = {
                receiver: formData.get('receiver'),
                content: formData.get('content')
            };

            // Get or create success message element inside the modal (not the form)
            const modal = document.getElementById('msg');
            let successMsg = document.getElementById('msg-success');
            if (!successMsg) {
                successMsg = document.createElement('div');
                successMsg.id = 'msg-success';
                successMsg.style.cssText = 'padding: 15px; margin: 15px; border-radius: 5px; text-align: center; display: none; font-weight: bold; position: relative; z-index: 10;';
                // Insert after the h1 title in the modal
                const modalTitle = modal.querySelector('h1');
                if (modalTitle) {
                    modalTitle.insertAdjacentElement('afterend', successMsg);
                } else {
                    modal.insertBefore(successMsg, modal.firstChild);
                }
            }

            fetch('/add-msg', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            })
                .then(response => {
                    if (!response.ok) {
                        throw new Error('Failed to send message');
                    }
                    return response.json();
                })
                .then(result => {
                    console.log('Message sent:', result);

                    // Show success message inside modal
                    successMsg.textContent = '✓ Message sent successfully!';
                    successMsg.style.backgroundColor = '#d4edda';
                    successMsg.style.color = '#155724';
                    successMsg.style.border = '1px solid #c3e6cb';
                    successMsg.style.display = 'block';

                    // Reset form
                    messageForm.reset();

                    // Hide success message and close modal after 2 seconds
                    setTimeout(() => {
                        successMsg.style.display = 'none';
                        closeMsg();
                    }, 2000);
                })
                .catch(error => {
                    console.error('Error sending message:', error);

                    // Show error message inside modal
                    successMsg.textContent = '✗ Failed to send message. Please try again.';
                    successMsg.style.backgroundColor = '#f8d7da';
                    successMsg.style.color = '#721c24';
                    successMsg.style.border = '1px solid #f5c6cb';
                    successMsg.style.display = 'block';

                    // Hide error message after 3 seconds
                    setTimeout(() => {
                        successMsg.style.display = 'none';
                    }, 3000);
                });
        });
    }
});

// Close modal when clicking outside
window.onclick = function (event) {
    const modal = document.getElementById('msg');
    if (event.target === modal) {
        closeMsg();
    }
}
