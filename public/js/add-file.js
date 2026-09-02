document.addEventListener('DOMContentLoaded', () => {
  // Fetch categories for the dropdown
  const categoryDropdown = document.getElementById('category');
  fetch('/categories')
    .then(response => response.json())
    .then(categories => {
      categories.forEach(category => {
        const option = document.createElement('option');
        option.value = category.id;
        option.textContent = category.name;
        categoryDropdown.appendChild(option);
      });
    })
    .catch(err => console.error('Error fetching categories:', err));

  // Handle file selection
  const fileInput = document.getElementById('file');
  const fileNameDisplay = document.getElementById('file-name');

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileNameDisplay.value = file ? file.name : 'No file selected';
  });
});
