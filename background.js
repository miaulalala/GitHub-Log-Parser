'use strict';

/**
 * Background script — handles all fetch requests from the content script.
 *
 * Content scripts can make cross-origin requests to hosts in the manifest
 * permissions, but they cannot follow redirects to OTHER domains (e.g. the
 * GitHub API redirects log downloads to pipelines.actions.githubusercontent.com).
 * Background scripts do not have this limitation when the redirect target is
 * also in the manifest permissions.
 */
browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'fetch') {
    return handleFetch(message.url, message.token);
  }
});

async function handleFetch(url, token) {
  const headers = {};
  if (token) headers['Authorization'] = `token ${token}`;

  try {
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      return { ok: false, status: resp.status };
    }
    const text = await resp.text();
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
