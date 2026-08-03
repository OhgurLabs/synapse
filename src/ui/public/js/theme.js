/**
 * @module theme.js
 * @domain Theme & Appearance Management
 * @description Dark/light theme toggle, theme persistence, theme application.
 *
 * @namespace window.SynapseTheme
 * @exports {
 *   getInitialTheme(): string,
 *   applyTheme(theme: string): void,
 *   updateThemeButton(): void,
 *   currentTheme: string
 * }
 * @depends (none — standalone)
 * @init init() — call after DOMContentLoaded
 */
(function () {
  'use strict';

  // --- State ---
  const THEME_STORAGE_KEY = 'synapse-ui-theme';
  let currentTheme = 'dark';
  let themeToggleBtn = null;

  // --- Functions ---
  function getInitialTheme() {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      if (saved === 'dark' || saved === 'light') return saved;
    } catch {}
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    currentTheme = theme === 'light' ? 'light' : 'dark';
    document.body.dataset.theme = currentTheme;
    try { localStorage.setItem(THEME_STORAGE_KEY, currentTheme); } catch {}
    updateThemeButton();
  }

  function updateThemeButton() {
    if (!themeToggleBtn) return;
    themeToggleBtn.textContent = `Theme: ${currentTheme === 'dark' ? 'Dark' : 'Light'}`;
    themeToggleBtn.title = `Switch to ${currentTheme === 'dark' ? 'Light' : 'Dark'} mode`;
    themeToggleBtn.setAttribute('aria-label', `Current theme ${currentTheme}. Switch to ${currentTheme === 'dark' ? 'light' : 'dark'} mode.`);
    themeToggleBtn.setAttribute('aria-pressed', currentTheme === 'dark' ? 'true' : 'false');
  }

  function init() {
    themeToggleBtn = document.getElementById('theme-toggle');

    if (themeToggleBtn) {
      themeToggleBtn.addEventListener('click', () => {
        applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
      });
    }

    applyTheme(getInitialTheme());
  }

  // --- Public API ---
  window.SynapseTheme = {
    getInitialTheme,
    applyTheme,
    updateThemeButton,
    get currentTheme() { return currentTheme; },
    init,
  };
})();
