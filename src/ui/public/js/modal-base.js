/**
 * @module modal-base.js
 * @domain Reusable Modal Component System
 * @description Base Modal class with overlay management, focus trap, and ARIA support.
 *
 * @namespace window.SynapseModalBase
 */
(function () {
  'use strict';

  class Modal {
    /**
     * @param {Object} options
     * @param {string} options.id - Unique ID for the modal
     * @param {string} options.title - Modal title
     * @param {string|HTMLElement} options.content - Modal content (HTML string or element)
     * @param {Function} [options.onClose] - Callback when modal is closed
     */
    constructor(options = {}) {
      this.id = options.id || `modal-${Math.random().toString(36).substr(2, 9)}`;
      this.title = options.title || '';
      this.content = options.content || '';
      this.onClose = options.onClose || null;
      
      this.overlay = null;
      this.modalEl = null;
      this.previousFocusedElement = null;
      
      this._handleKeyDown = this._handleKeyDown.bind(this);
      this._handleOverlayClick = this._handleOverlayClick.bind(this);
    }

    /**
     * Opens the modal, creates DOM elements, and sets up event listeners.
     */
    open() {
      if (this.overlay) return;

      this.previousFocusedElement = document.activeElement;

      // Create Overlay
      this.overlay = document.createElement('div');
      this.overlay.id = `${this.id}-overlay`;
      this.overlay.className = 'modal-base-overlay';
      
      // ARIA attributes
      this.overlay.setAttribute('role', 'dialog');
      this.overlay.setAttribute('aria-modal', 'true');
      this.overlay.setAttribute('aria-labelledby', `${this.id}-title`);

      // Create Modal Container
      this.modalEl = document.createElement('div');
      this.modalEl.className = 'modal-base';

      // Header
      const header = document.createElement('div');
      header.className = 'modal-base-header';
      
      const titleEl = document.createElement('h2');
      titleEl.id = `${this.id}-title`;
      titleEl.textContent = this.title;
      
      const closeBtn = document.createElement('button');
      closeBtn.className = 'modal-base-close';
      closeBtn.innerHTML = '&times;';
      closeBtn.setAttribute('aria-label', 'Close modal');
      closeBtn.onclick = (e) => {
        e.stopPropagation();
        this.close();
      };

      header.appendChild(titleEl);
      header.appendChild(closeBtn);

      // Body
      const body = document.createElement('div');
      body.className = 'modal-base-body';
      if (typeof this.content === 'string') {
        body.innerHTML = this.content;
      } else if (this.content instanceof HTMLElement) {
        body.appendChild(this.content);
      }

      // Footer
      const footer = document.createElement('div');
      footer.className = 'modal-base-footer';

      this.modalEl.appendChild(header);
      this.modalEl.appendChild(body);
      this.modalEl.appendChild(footer);
      this.overlay.appendChild(this.modalEl);

      document.body.appendChild(this.overlay);

      // Scroll Lock
      window.SynapseModalBase.applyScrollLock();

      // Show modal
      // Use requestAnimationFrame to ensure the element is in the DOM before adding .visible
      requestAnimationFrame(() => {
        if (this.overlay) {
          this.overlay.classList.add('visible');
        }
      });

      // Event Listeners
      document.addEventListener('keydown', this._handleKeyDown);
      this.overlay.addEventListener('click', this._handleOverlayClick);

      // Initial focus — deferred a tick so createModal() has appended its
      // footer buttons first; focusing synchronously always landed on the ✕
      // close button because it was the only button in the DOM yet.
      setTimeout(() => this._focusFirstElement(), 0);
    }

    /**
     * Closes the modal and cleans up listeners.
     */
    close() {
      if (!this.overlay || this._closing) return;
      // Idempotency guard: ✕ then backdrop within the 200ms teardown window
      // used to fire onClose twice and schedule a second destroy().
      this._closing = true;

      this.overlay.classList.remove('visible');

      // Wait for CSS transition (0.2s is standard for this project's UI)
      setTimeout(() => {
        this.destroy();
      }, 200);

      if (this.onClose) {
        this.onClose();
      }
    }

    /**
     * Removes the modal from DOM and cleans up all listeners.
     */
    destroy() {
      if (!this.overlay) return;

      document.removeEventListener('keydown', this._handleKeyDown);
      this.overlay.removeEventListener('click', this._handleOverlayClick);
      
      if (this.overlay.parentNode) {
        this.overlay.parentNode.removeChild(this.overlay);
      }
      
      // Restore scroll if no other modals (base or legacy) are open
      window.SynapseModalBase.removeScrollLock();

      if (this.previousFocusedElement && typeof this.previousFocusedElement.focus === 'function') {
        this.previousFocusedElement.focus();
      }

      this.overlay = null;
      this.modalEl = null;
    }

    /** @private */
    _handleKeyDown(e) {
      if (e.key === 'Escape') {
        // Only close the topmost visible modal (considering both base and legacy)
        const overlays = document.querySelectorAll('.modal-base-overlay.visible, .modal-overlay.visible');
        if (overlays.length > 0 && overlays[overlays.length - 1] === this.overlay) {
          this.close();
        }
      }

      if (e.key === 'Tab') {
        this._handleFocusTrap(e);
      }
    }

    /** @private */
    _handleOverlayClick(e) {
      if (e.target === this.overlay) {
        this.close();
      }
    }

    /** @private */
    _handleFocusTrap(e) {
      // Filter disabled/hidden nodes — a disabled last element made the wrap
      // condition unsatisfiable and let Tab escape the dialog.
      const focusableElements = [...this.modalEl.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )].filter(el => !el.disabled && el.offsetParent !== null);
      if (focusableElements.length === 0) {
        e.preventDefault();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          lastElement.focus();
          e.preventDefault();
        }
      } else {
        if (document.activeElement === lastElement) {
          firstElement.focus();
          e.preventDefault();
        }
      }
    }

    /** @private */
    _focusFirstElement() {
      const focusableElements = this.modalEl.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusableElements.length > 0) {
        focusableElements[0].focus();
      }
    }
  }

  /**
   * Factory helper to create modals with declarative options.
   * @param {Object} opts
   * @param {string} [opts.id] - Modal ID
   * @param {string} opts.title - Modal title
   * @param {string|HTMLElement} opts.content - Modal content
   * @param {Array<{label, className, onClick}>} [opts.footerButtons] - Footer buttons
   * @param {Function} [opts.onOpen] - Lifecycle hook called after modal opens
   * @param {string} [opts.cssClass] - Additional CSS class for modal container
   * @param {Function} [opts.onClose] - Callback when modal closes
   * @returns {Modal} Modal instance
   */
  function createModal(opts = {}) {
    const modal = new Modal({
      id: opts.id,
      title: opts.title,
      content: opts.content,
      onClose: opts.onClose
    });

    // Apply custom CSS class
    const originalOpen = modal.open.bind(modal);
    modal.open = function() {
      originalOpen();

      if (opts.cssClass && modal.modalEl) {
        modal.modalEl.classList.add(opts.cssClass);
      }

      // Add footer buttons
      if (opts.footerButtons && opts.footerButtons.length > 0) {
        const footer = modal.modalEl.querySelector('.modal-base-footer');
        opts.footerButtons.forEach(btnOpts => {
          const btn = document.createElement('button');
          btn.textContent = btnOpts.label;
          btn.className = btnOpts.className || '';
          btn.onclick = () => btnOpts.onClick({ modal, modalEl: modal.modalEl, close: () => modal.close() });
          footer.appendChild(btn);
        });
      }

      // Call onOpen hook
      if (opts.onOpen) {
        opts.onOpen({ modal, modalEl: modal.modalEl, close: () => modal.close() });
      }
    };

    return modal;
  }

  window.SynapseModalBase = {
    Modal,
    createModal,
    /**
     * Applies scroll lock to the body.
     */
    applyScrollLock() {
      document.body.style.overflow = 'hidden';
    },
    /**
     * Removes scroll lock if no modals are visible.
     */
    removeScrollLock() {
      const allVisible = document.querySelectorAll('.modal-base-overlay.visible, .modal-overlay.visible');
      if (allVisible.length === 0) {
        document.body.style.overflow = '';
      }
    },
    init() {
      // Global initialization if needed
    }
  };
})();
