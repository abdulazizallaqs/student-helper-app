/**
 * Handle validation errors from server
 * Intercepts fetch responses and shows toast notifications for validation errors
 */

// Add this to forms that use fetch for submission
function handleFormSubmit(formId, url, method = 'POST', onSuccess) {
    const form = document.getElementById(formId);
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const formData = new FormData(form);
        const data = Object.fromEntries(formData);

        try {
            const response = await fetch(url, {
                method: method,
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(data),
            });

            const result = await response.json();

            if (!response.ok) {
                // Show validation errors as toasts
                if (result.errors && Array.isArray(result.errors)) {
                    result.errors.forEach(error => {
                        showToast(error.message, 'warning');
                    });
                } else if (result.message) {
                    showToast(result.message, 'error');
                } else {
                    showToast('An error occurred', 'error');
                }
                return;
            }

            // Success
            if (result.message) {
                showToast(result.message, 'success');
            }

            if (onSuccess) {
                onSuccess(result);
            }

        } catch (error) {
            console.error('Error:', error);
            showToast('Network error occurred', 'error');
        }
    });
}

// Check URL for error parameter and show toast
function checkUrlForErrors() {
    const urlParams = new URLSearchParams(window.location.search);
    const error = urlParams.get('error');

    if (error) {
        if (typeof showToast === 'function') {
            showToast(decodeURIComponent(error), 'warning');
        }

        // Remove error from URL without reloading
        const newUrl = window.location.pathname;
        window.history.replaceState({}, document.title, newUrl);
    }
}

// Run on page load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkUrlForErrors);
} else {
    checkUrlForErrors();
}

// Make functions globally available
window.handleFormSubmit = handleFormSubmit;
window.checkUrlForErrors = checkUrlForErrors;
