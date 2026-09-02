let deleteTarget = null;

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function notify(message, type) {
  if (typeof showToast === 'function') {
    showToast(message, type);
  } else {
    alert(message);
  }
}

// If the admin's session has expired/been revoked mid-visit, every fetch()
// below will now get a 401 from the newly-added requireAdminSession guard
// instead of silently succeeding as anonymous data - send them back to login.
function handleAuthFailure(response) {
  if (response.status === 401) {
    notify('Your admin session has expired. Please log in again.', 'error');
    setTimeout(() => { window.location.href = '/login'; }, 1200);
    return true;
  }
  return false;
}

function closeAdminModal(id) {
  document.getElementById(id).style.display = 'none';
}

function loadUsers() {
  fetch('/admin/users')
    .then(response => {
      if (handleAuthFailure(response)) return null;
      if (!response.ok) throw new Error('Failed to load users.');
      return response.json();
    })
    .then(users => {
      if (!users) return;
      const container = document.querySelector('#users-list');
      container.innerHTML = '';
      if (users.length === 0) {
        container.innerHTML = '<p class="adm-empty-state"><i class="fa fa-users"></i><br>No users yet.</p>';
      } else {
        users.forEach(user => {
          container.innerHTML += `<div class="user-card">
                <p><strong>User ID:</strong> ${user.userId}</p>
                <p><strong>Name:</strong> ${escapeHtml(user.name)}</p>
                <p><strong>Email:</strong> ${escapeHtml(user.email)}</p>
                <p><strong>Files Uploaded:</strong> ${user.fileCount}</p>
                <p><strong>Comments:</strong> ${user.commentCount}</p>
                <p><strong>Sent Messages:</strong> ${user.sendMsg}</p>
                <p><strong>Received Messages:</strong> ${user.receiveMsg}</p>
                <button class="btn-del" onclick="confirmDelete(${user.userId})">Delete This User</button>
           </div>`;
        });
      }
      document.querySelector('#users-container').style.display = 'block';
      document.querySelector('#files-container').style.display = 'none';
      document.querySelector('#users-delete').style.display = 'none';
      document.querySelector('#files-delete').style.display = 'none';
    })
    .catch(() => notify('Could not load users.', 'error'));
}

function loadFiles() {
  fetch('/admin/files')
    .then(response => {
      if (handleAuthFailure(response)) return null;
      if (!response.ok) throw new Error('Failed to load files.');
      return response.json();
    })
    .then(files => {
      if (!files) return;
      const container = document.querySelector('#files-list');
      container.innerHTML = '';
      if (files.length === 0) {
        container.innerHTML = '<p class="adm-empty-state"><i class="fa fa-file-lines"></i><br>No files yet.</p>';
      } else {
        files.forEach(file => {
          container.innerHTML += `<div class="file-card">
                <p><strong>File ID:</strong> ${file.id}</p>
                <p><strong>Title:</strong> ${escapeHtml(file.title)}</p>
                <p><strong>Description:</strong> ${escapeHtml(file.description)}</p>
                <p><strong>Category:</strong> ${escapeHtml(file.category)}</p>
                <p><strong>Uploaded By:</strong> ${escapeHtml(file.userName)}</p>
            <button class="btn-del" onclick="confirmDeleteFile(${file.id})">Delete This File</button>
          </div>`;
        });
      }
      document.querySelector('#users-delete').style.display = 'none';
      document.querySelector('#files-delete').style.display = 'none';
      document.querySelector('#users-container').style.display = 'none';
      document.querySelector('#files-container').style.display = 'block';
    })
    .catch(() => notify('Could not load files.', 'error'));
}

function deleteUserID() {
  const modal = document.getElementById('users-delete');
  modal.style.display = 'block';
  document.querySelector('#files-delete').style.display = 'none';
  document.querySelector('#files-container').style.display = 'none';
  document.querySelector('#users-container').style.display = 'none';

  document.getElementById('del-user').addEventListener('submit', (event) => {
    event.preventDefault();
    const userId = document.getElementById('userId').value;
    confirmDelete(userId);
  });
}

function deleteFileID() {
  const modal = document.getElementById('files-delete');
  modal.style.display = 'block';
  document.querySelector('#users-delete').style.display = 'none';
  document.querySelector('#files-container').style.display = 'none';
  document.querySelector('#users-container').style.display = 'none';

  document.getElementById('del-file').addEventListener('submit', (event) => {
    event.preventDefault();
    const fileId = document.getElementById('fileId').value;
    confirmDeleteFile(fileId);
  });
}

function confirmDelete(userId) {
  showCustomModal({
    title: 'Confirm Deletion',
    message: 'Are you sure you want to delete this user? This cannot be undone.',
    confirmText: 'Yes, Delete',
    cancelText: 'Cancel',
    onConfirm: () => removeUser(userId),
    onCancel: () => console.log('Deletion canceled.'),
  });
}

function confirmDeleteFile(fileId) {
  showCustomModal({
    title: 'Confirm Deletion',
    message: 'Are you sure you want to delete this file? This cannot be undone.',
    confirmText: 'Yes, Delete',
    cancelText: 'Cancel',
    onConfirm: () => removeFile(fileId),
    onCancel: () => console.log('Deletion canceled.'),
  });
}

function showCustomModal({ title, message, confirmText, cancelText, onConfirm, onCancel }) {
  const modal = document.getElementById('deleteConfirmationModal');
  const modalTitle = document.getElementById('modalTitle');
  const modalMessage = document.getElementById('modalMessage');
  const confirmButton = document.getElementById('confirmDeleteBtn');
  const cancelButton = document.getElementById('cancelDeleteBtn');

  modalTitle.textContent = title;
  modalMessage.textContent = message;
  confirmButton.textContent = confirmText;
  cancelButton.textContent = cancelText;

  confirmButton.onclick = function () {
    onConfirm();
    modal.style.display = 'none';
  };

  cancelButton.onclick = function () {
    if (onCancel) onCancel();
    modal.style.display = 'none';
  };

  modal.style.display = 'block';
}

function closeModal() {
  deleteTarget = null;
  document.querySelector('#warningModal').style.display = 'none';
}

function removeUser(userId) {
  fetch(`/admin/delete-user/${userId}`, { method: 'DELETE' })
    .then(response => {
      if (handleAuthFailure(response)) return null;
      if (!response.ok) throw new Error('Failed to delete user.');
      return response.json();
    })
    .then(data => {
      if (!data) return;
      notify('User deleted.', 'success');
      setTimeout(() => location.reload(), 700);
    })
    .catch(error => {
      console.error('Error deleting user:', error);
      notify('Error deleting user.', 'error');
    });
}

function removeFile(fileId) {
  fetch(`/admin/delete-file/${fileId}`, { method: 'DELETE' })
    .then(response => {
      if (handleAuthFailure(response)) return null;
      if (!response.ok) throw new Error('Failed to delete file.');
      return response.json();
    })
    .then(data => {
      if (!data) return;
      notify('File deleted.', 'success');
      setTimeout(() => location.reload(), 700);
    })
    .catch(error => {
      console.error('Error deleting file:', error);
      notify('Error deleting file.', 'error');
    });
}

// -- Dashboard overview: stat tiles + bar charts ---------------------------

function renderBars(containerId, tableBodyId, items, labelKey, valueKey, emptyMessage) {
  const container = document.getElementById(containerId);
  const tableBody = document.getElementById(tableBodyId);
  container.innerHTML = '';
  tableBody.innerHTML = '';

  if (!items || items.length === 0) {
    container.innerHTML = `<p class="adm-empty-state">${emptyMessage}</p>`;
    return;
  }

  const max = Math.max(...items.map(i => Number(i[valueKey]) || 0), 1);

  items.forEach(item => {
    const value = Number(item[valueKey]) || 0;
    const label = String(item[labelKey]);
    const pct = Math.max((value / max) * 100, 4);

    const row = document.createElement('div');
    row.className = 'adm-bar-row';
    row.innerHTML = `
      <span class="adm-bar-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
      <span class="adm-bar-track">
        <span class="adm-bar-fill" style="width:${pct}%" title="${escapeHtml(label)}: ${value}"></span>
      </span>
      <span class="adm-bar-value">${value}</span>`;
    container.appendChild(row);

    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(label)}</td><td>${value}</td>`;
    tableBody.appendChild(tr);
  });
}

function loadStats() {
  fetch('/admin/stats')
    .then(response => {
      if (handleAuthFailure(response)) return null;
      if (!response.ok) throw new Error('Failed to load stats.');
      return response.json();
    })
    .then(stats => {
      if (!stats) return;

      document.getElementById('statUsers').textContent = stats.totals.users;
      document.getElementById('statFiles').textContent = stats.totals.files;
      document.getElementById('statFavorites').textContent = stats.totals.favorites;
      document.getElementById('statComments').textContent = stats.totals.comments;
      document.querySelectorAll('.adm-stat-value').forEach(el => el.classList.remove('is-loading'));

      renderBars('categoryBars', 'categoryTableBody', stats.filesByCategory, 'category', 'fileCount', 'No categories yet.');
      renderBars('uploaderBars', 'uploaderTableBody', stats.topUploaders, 'username', 'fileCount', 'No uploads yet.');
    })
    .catch(() => {
      document.querySelectorAll('.adm-stat-value').forEach(el => { el.textContent = '—'; el.classList.remove('is-loading'); });
      notify('Could not load dashboard stats.', 'error');
    });
}

document.querySelectorAll('.adm-chart-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const table = document.getElementById(btn.dataset.target);
    const bars = document.getElementById(btn.dataset.target.replace('Table', 'Bars'));
    const showTable = table.hasAttribute('hidden');
    table.hidden = !showTable;
    if (bars) bars.hidden = showTable;
    btn.textContent = showTable ? 'View as chart' : 'View as table';
  });
});

loadStats();
