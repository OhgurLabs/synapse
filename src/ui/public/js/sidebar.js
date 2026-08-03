/**
 * @module sidebar.js
 * @domain Sidebar Resize & Responsive Layout
 * @description Sidebar width persistence, drag-to-resize, and collapsible responsive behavior.
 *
 * @namespace window.SynapseSidebar
 * @exports {
 *   applySidebarWidth(px: number): void,
 *   initSidebarWidth(): void,
 *   collapseSidebar(manual?: boolean): void,
 *   expandSidebar(manual?: boolean): void,
 *   toggleSidebar(): void
 * }
 * @depends (none — standalone)
 * @init init() — call after DOMContentLoaded
 */
(function () {
  'use strict';

  // --- Constants ---
  const SIDEBAR_WIDTH_KEY = 'synapse-sidebar-width';
  const SIDEBAR_COLLAPSED_KEY = 'synapse-sidebar-collapsed';
  const SIDEBAR_MIN_PX = 160;
  const SIDEBAR_MAX_PX = 480;
  const SIDEBAR_COLLAPSED_WIDTH = 48;
  const RESPONSIVE_BREAKPOINT = 1024;

  // --- Functions ---
  function applySidebarWidth(px) {
    const clamped = Math.max(SIDEBAR_MIN_PX, Math.min(SIDEBAR_MAX_PX, px));
    document.documentElement.style.setProperty('--sidebar-width', clamped + 'px');
  }

  function initSidebarWidth() {
    const saved = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY), 10);
    if (!isNaN(saved)) {
      applySidebarWidth(saved);
    }
  }

  function collapseSidebar(manual) {
    if (manual === undefined) manual = true;
    const sidebar = document.getElementById('sidebar');
    const handle = document.getElementById('sidebar-resize-handle');
    const toggleBtn = document.getElementById('sidebar-toggle');
    if (!sidebar) return;

    sidebar.classList.add('sidebar-collapsed');
    document.documentElement.style.setProperty('--sidebar-width', SIDEBAR_COLLAPSED_WIDTH + 'px');
    if (handle) {
      handle.style.pointerEvents = 'none';
    }
    if (toggleBtn) {
      toggleBtn.setAttribute('aria-expanded', 'false');
    }

    if (manual) {
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, 'true');
      } catch {}
    }
  }

  function expandSidebar(manual) {
    if (manual === undefined) manual = true;
    const sidebar = document.getElementById('sidebar');
    const handle = document.getElementById('sidebar-resize-handle');
    const toggleBtn = document.getElementById('sidebar-toggle');
    if (!sidebar) return;

    sidebar.classList.remove('sidebar-collapsed');

    // Restore saved width or use default
    const saved = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY), 10);
    const width = !isNaN(saved) ? saved : 240;
    applySidebarWidth(width);

    if (handle) {
      handle.style.pointerEvents = '';
    }
    if (toggleBtn) {
      toggleBtn.setAttribute('aria-expanded', 'true');
    }

    if (manual) {
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, 'false');
      } catch {}
    }
  }

  function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebar-toggle');
    if (!sidebar) return;

    if (sidebar.classList.contains('sidebar-collapsed')) {
      expandSidebar();
      if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
    } else {
      collapseSidebar();
      if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
    }
  }

  function handleWindowResize() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;

    const width = window.innerWidth;
    const isCollapsed = sidebar.classList.contains('sidebar-collapsed');

    // Auto-collapse below breakpoint (but respect manual toggle above breakpoint)
    if (width < RESPONSIVE_BREAKPOINT && !isCollapsed) {
      collapseSidebar(false);
    } else if (width >= RESPONSIVE_BREAKPOINT && isCollapsed) {
      // Only auto-expand if we're not manually collapsed
      const manuallyCollapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
      if (!manuallyCollapsed) {
        expandSidebar(false);
      }
    }
  }

  // --- Keyboard Navigation (WCAG Tree Pattern) ---
  function initTreeKeyboardNavigation() {
    const tree = document.getElementById('project-tree');
    if (!tree) return;

    // Identify a treeitem by its data attributes or text for focus restoration
    function getItemKey(item) {
      // Use data-project and data-channel attributes if present, fall back to textContent
      const project = item.getAttribute('data-project') || '';
      const channel = item.getAttribute('data-channel') || '';
      if (project || channel) return project + '::' + channel;
      return (item.textContent || '').trim();
    }

    // Set up roving tabindex: only one focusable item at a time.
    // Preserves the currently focused item's position across re-renders.
    function refreshTabindex() {
      const treeitems = tree.querySelectorAll('[role="treeitem"]');
      if (treeitems.length === 0) return;

      // Find the currently active element's key (if it was inside this tree)
      const active = document.activeElement;
      const activeInTree = active && tree.contains(active) && active.getAttribute('role') === 'treeitem';
      const savedKey = activeInTree ? getItemKey(active) : _lastFocusedKey;

      let restored = false;
      treeitems.forEach(item => {
        if (savedKey && getItemKey(item) === savedKey) {
          item.setAttribute('tabindex', '0');
          // Re-focus if the tree currently has focus
          if (tree.contains(document.activeElement)) {
            item.focus();
          }
          restored = true;
        } else {
          item.setAttribute('tabindex', '-1');
        }
      });

      // If no match found, default to first item
      if (!restored) {
        treeitems[0].setAttribute('tabindex', '0');
      }
    }

    // Track the last focused treeitem key so we can restore after innerHTML rebuild
    let _lastFocusedKey = null;
    tree.addEventListener('focusin', (e) => {
      if (e.target.getAttribute('role') === 'treeitem') {
        _lastFocusedKey = getItemKey(e.target);
      }
    });

    // Get all visible treeitems (projects and channels) in visual order
    // Filters out items inside collapsed/hidden sections to prevent
    // roving tabindex corruption when navigating past collapsed projects
    function getTreeitems() {
      return Array.from(tree.querySelectorAll('[role="treeitem"]')).filter(el => {
        // offsetParent is null for display:none elements (and their children)
        return el.offsetParent !== null;
      });
    }

    // Check if a project section is expanded
    function isExpanded(projectHeader) {
      return projectHeader.getAttribute('aria-expanded') === 'true';
    }

    // Expand a project section
    function expandSection(projectHeader) {
      const section = projectHeader.closest('.sidebar-section');
      if (!section) return;
      const channels = section.querySelector('.sidebar-channels');
      const arrow = projectHeader.querySelector('.arrow');
      if (channels) {
        channels.classList.remove('hidden');
        projectHeader.setAttribute('aria-expanded', 'true');
      }
      if (arrow) arrow.classList.remove('collapsed');
    }

    // Collapse a project section
    function collapseSection(projectHeader) {
      const section = projectHeader.closest('.sidebar-section');
      if (!section) return;
      const channels = section.querySelector('.sidebar-channels');
      const arrow = projectHeader.querySelector('.arrow');
      if (channels) {
        channels.classList.add('hidden');
        projectHeader.setAttribute('aria-expanded', 'false');
      }
      if (arrow) arrow.classList.add('collapsed');
    }

    // Move focus to a specific treeitem
    function moveFocus(targetItem) {
      if (!targetItem) return;
      const treeitems = getTreeitems();
      treeitems.forEach(item => item.setAttribute('tabindex', '-1'));
      targetItem.setAttribute('tabindex', '0');
      targetItem.focus();
    }

    // Handle keyboard navigation
    tree.addEventListener('keydown', (e) => {
      const target = e.target;
      if (!target.hasAttribute('role') || target.getAttribute('role') !== 'treeitem') return;

      const treeitems = getTreeitems();
      const currentIndex = treeitems.indexOf(target);
      if (currentIndex === -1) return;

      const isProject = target.classList.contains('sidebar-project');
      let handled = false;

      switch (e.key) {
        case 'ArrowDown':
          // Move to next treeitem
          if (currentIndex < treeitems.length - 1) {
            moveFocus(treeitems[currentIndex + 1]);
          }
          handled = true;
          break;

        case 'ArrowUp':
          // Move to previous treeitem
          if (currentIndex > 0) {
            moveFocus(treeitems[currentIndex - 1]);
          }
          handled = true;
          break;

        case 'ArrowRight':
          // For project headers: expand if collapsed
          if (isProject && !isExpanded(target)) {
            expandSection(target);
            // After DOM update, refresh tabindex to include newly visible channels
            setTimeout(() => {
              refreshTabindex();
              moveFocus(target);
            }, 0);
          } else if (isProject && isExpanded(target)) {
            // Already expanded: move to first child
            const nextItem = treeitems[currentIndex + 1];
            if (nextItem && nextItem.classList.contains('sidebar-channel')) {
              moveFocus(nextItem);
            }
          }
          handled = true;
          break;

        case 'ArrowLeft':
          // For project headers: collapse if expanded
          if (isProject && isExpanded(target)) {
            collapseSection(target);
            // After DOM update, refresh tabindex
            setTimeout(() => {
              refreshTabindex();
              moveFocus(target);
            }, 0);
          } else if (!isProject) {
            // For channel items: move focus to parent project
            const section = target.closest('.sidebar-section');
            const projectHeader = section ? section.querySelector('.sidebar-project') : null;
            if (projectHeader) {
              moveFocus(projectHeader);
            }
          }
          handled = true;
          break;

        case 'Home':
          // Move to first treeitem
          if (treeitems.length > 0) {
            moveFocus(treeitems[0]);
          }
          handled = true;
          break;

        case 'End':
          // Move to last treeitem
          if (treeitems.length > 0) {
            moveFocus(treeitems[treeitems.length - 1]);
          }
          handled = true;
          break;

        case 'Enter':
        case ' ':
          // Activate the focused item (trigger click)
          target.click();
          handled = true;
          break;
      }

      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    });

    // Initialize roving tabindex on page load
    refreshTabindex();

    // Re-apply roving tabindex whenever sidebar is re-rendered.
    // Debounce to avoid rapid-fire resets during renderSidebar()
    // which does innerHTML='' then rebuilds the tree in the same tick.
    let _refreshTimer = null;
    const observer = new MutationObserver(() => {
      if (_refreshTimer) clearTimeout(_refreshTimer);
      _refreshTimer = setTimeout(() => {
        _refreshTimer = null;
        refreshTabindex();
      }, 0);
    });
    observer.observe(tree, { childList: true, subtree: true });
  }

  function init() {
    initSidebarWidth();

    const handle = document.getElementById('sidebar-resize-handle');
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebar-toggle');
    if (!handle || !sidebar) return;

    // Restore collapsed state from localStorage
    const savedCollapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
    if (savedCollapsed) {
      collapseSidebar();
    } else {
      // Check if we should auto-collapse based on viewport
      handleWindowResize();
    }

    // Wire up toggle button
    if (toggleBtn) {
      toggleBtn.addEventListener('click', toggleSidebar);
      toggleBtn.setAttribute('aria-expanded', !savedCollapsed);
    }

    // Window resize listener for responsive behavior
    window.addEventListener('resize', handleWindowResize);

    // Initialize keyboard navigation for sidebar tree
    initTreeKeyboardNavigation();

    // Note: Expand-on-hover behavior is handled by CSS :hover pseudo-class
    // (see sidebar.css lines 135-185 for #sidebar.sidebar-collapsed:hover rules)

    // Drag-to-resize functionality
    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    handle.addEventListener('mousedown', function (e) {
      // Don't allow dragging when collapsed
      if (sidebar.classList.contains('sidebar-collapsed')) return;

      dragging = true;
      handle.classList.add('dragging');
      startX = e.clientX;
      startWidth = sidebar.offsetWidth;
      e.preventDefault();
    });

    function onMouseMove(e) {
      if (!dragging) return;
      const delta = e.clientX - startX;
      const newWidth = startWidth + delta;
      applySidebarWidth(newWidth);
    }

    function onMouseUp() {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      try { localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebar.offsetWidth); } catch {}
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  // --- Public API ---
  window.SynapseSidebar = {
    applySidebarWidth,
    initSidebarWidth,
    collapseSidebar,
    expandSidebar,
    toggleSidebar,
    init,
  };
})();
