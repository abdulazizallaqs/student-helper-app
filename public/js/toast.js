/**
 * Show a toast notification
 * @param {string} message - The message to display
 * @param {string} type - Type of notification: 'success', 'error', 'warning', 'info'
 * @param {number} duration - Duration in milliseconds (default: 3000)
 */
function showToast(message, type = 'info', duration = 3000) {
    // Remove any existing toasts
    const existingToasts = document.querySelectorAll('.toast-notification');
    existingToasts.forEach(toast => toast.remove());

    // Create toast element
    const toast = document.createElement('div');
    toast.className = `toast-notification ${type}`;

    // Icon based on type
    let icon = '';
    switch (type) {
        case 'success':
            icon = '<i class="fa fa-check-circle"></i>';
            break;
        case 'error':
            icon = '<i class="fa fa-exclamation-circle"></i>';
            break;
        case 'warning':
            icon = '<i class="fa fa-exclamation-triangle"></i>';
            break;
        case 'info':
        default:
            icon = '<i class="fa fa-info-circle"></i>';
            break;
    }

    // `icon` above is one of our own fixed HTML strings (safe as innerHTML).
    // `message` is not - callers pass in server responses, validation
    // errors, and (via validation-handler.js) even the ?error= URL
    // parameter, all of which are effectively attacker-controllable. It is
    // set with textContent so a message can never be interpreted as HTML.
    toast.innerHTML = `
    ${icon}
    <span class="toast-message"></span>
    <button class="toast-close" onclick="this.parentElement.remove()">×</button>
  `;
    toast.querySelector('.toast-message').textContent = message;

    // Add to body
    document.body.appendChild(toast);

    // Auto remove after duration
    setTimeout(() => {
        if (toast.parentElement) {
            toast.remove();
        }
    }, duration);
}

// Make it globally available
window.showToast = showToast;
