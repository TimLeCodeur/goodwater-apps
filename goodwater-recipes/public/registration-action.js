'use strict';

(async () => {
  const card = document.getElementById('result-card');
  const icon = document.getElementById('status-icon');
  const title = document.getElementById('result-title');
  const detail = document.getElementById('result-detail');
  const token = new URLSearchParams(window.location.search).get('token');

  try {
    const response = await fetch('/api/registration-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Impossible de traiter cette demande');
    card.classList.add(result.status);
    icon.textContent = result.status === 'accepted' ? '✓' : '×';
    title.textContent = result.title;
    detail.textContent = result.detail;
    document.title = `${result.title} — Goodwater Recipes`;
  } catch (error) {
    card.classList.add('error');
    icon.textContent = '!';
    title.textContent = 'Impossible de traiter la demande';
    detail.textContent = error.message;
  }
})();
