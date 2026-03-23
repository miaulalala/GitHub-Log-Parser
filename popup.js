'use strict';

const tokenInput = document.getElementById('token');
const saveButton = document.getElementById('save');
const statusEl   = document.getElementById('status');
const spawnRadios = document.querySelectorAll('input[name="spawn"]');

// Load saved settings on open
browser.storage.local.get(['githubToken', 'spawnPosition']).then(({ githubToken, spawnPosition }) => {
  if (githubToken) tokenInput.value = githubToken;
  const pos = spawnPosition || 'bottom-right';
  const radio = document.querySelector(`input[name="spawn"][value="${pos}"]`);
  if (radio) radio.checked = true;
});

// Save spawn position immediately on change
spawnRadios.forEach(r => r.addEventListener('change', () => {
  browser.storage.local.set({ spawnPosition: r.value });
}));

saveButton.addEventListener('click', async () => {
  const token = tokenInput.value.trim();

  if (token && !token.startsWith('ghp_') && !token.startsWith('github_pat_')) {
    statusEl.className = 'status err';
    statusEl.textContent = 'Token looks wrong — should start with ghp_ or github_pat_';
    return;
  }

  await browser.storage.local.set({ githubToken: token || null });

  statusEl.className = 'status ok';
  statusEl.textContent = token ? 'Saved! Reload any open Actions pages.' : 'Token cleared.';
  setTimeout(() => { statusEl.textContent = ''; }, 3000);
});
