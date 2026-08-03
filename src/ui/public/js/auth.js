/**
 * @module auth.js
 * @domain RBAC & User Identity
 * @description Manages current user role and permissions for client-side gating.
 *   Initialized via WebSocket 'init' payload.
 *
 * @namespace window.SynapseAuth
 * @exports {
 *   userId: string|null,
 *   userRole: string,
 *   permissions: Set<string>,
 *   init(data: Object): void,
 *   hasPermission(action: string): boolean
 * }
 */
(function () {
  'use strict';

  const PERMISSION_MATRIX = {
    admin: new Set(['*']),
    operator: new Set([
      'campaign_pause',
      'campaign_resume',
      'provider_pause',
      'provider_resume',
      'dispatch_reroute',
      'checkpoint_replay',
      'apply_routing_recommendation',
      'dispatch_replay',
      'weight_override',
      'cb_hold',
      'cb_reset',
      'alert_ack',
    ]),
    reviewer: new Set(['campaign_pause']),
    support: new Set([]),
    viewer: new Set([]),
  };

  window.SynapseAuth = {
    userId: null,
    userRole: 'operator', // default
    permissions: new Set([]),

    init(data) {
      if (!data) return;
      this.userId = data.userId || null;
      this.userRole = data.userRole || 'operator';
      this._computePermissions(this.userRole);
      
      console.log('[Auth] Initialized', { 
        userId: this.userId, 
        userRole: this.userRole,
        permissionCount: this.permissions.size 
      });
    },

    hasPermission(action) {
      if (this.permissions.has('*')) return true;
      return this.permissions.has(action);
    },

    _computePermissions(role) {
      const perms = PERMISSION_MATRIX[role] || new Set([]);
      this.permissions = perms;
    }
  };
})();
