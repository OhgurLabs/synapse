// src/types/milestone.ts

/**
 * Approval state enum for milestone approval gates.
 * Tracks the authorization state of milestones requiring operator approval.
 */
export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'timeout';

/**
 * Milestone status values.
 */
export type MilestoneStatus = 
  | 'pending' 
  | 'waiting_approval' 
  | 'active' 
  | 'completed' 
  | 'failed' 
  | 'blocked';

/**
 * Milestone schema for campaign milestone tracking.
 * Includes approval gate fields for governance enforcement.
 */
export interface Milestone {
  id: string;
  title: string;
  description: string;
  doneCriteria: string | null;
  contingency: string | null;
  status: MilestoneStatus;
  blockedBy: string[];
  tasks: string[];
  order: number;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  completedAt: string | null;
  traceContext: any | null; // OTel span context for parent-child linkage
  
  // Approval gate fields
  requireApproval: boolean;
  approvalState: ApprovalState | null;
  approverId: string | null;
  approvalRequestedAt: string | null; // ISO 8601
  approvalReason: string | null;
}

/**
 * Milestone creation options.
 * All fields optional except title for backward compatibility.
 */
export interface MilestoneCreateOptions {
  title: string;
  description?: string | null;
  doneCriteria?: string | null;
  contingency?: string | null;
  blockedBy?: string[];
  order?: number;
  requireApproval?: boolean;
}

/**
 * Milestone update options.
 */
export interface MilestoneUpdateOptions {
  title?: string;
  description?: string | null;
  doneCriteria?: string | null;
  contingency?: string | null;
  status?: MilestoneStatus;
  blockedBy?: string[];
  order?: number;
}

/**
 * Approval request payload.
 */
export interface ApprovalRequest {
  projectId: string;
  campaignId: string;
  milestoneId: string;
  reason: string;
}

/**
 * Approval decision payload.
 */
export interface ApprovalDecision {
  projectId: string;
  campaignId: string;
  milestoneId: string;
  approverId: string;
  reason: string;
  timestamp: string; // ISO 8601
}

/**
 * Valid approval states for validation.
 */
export const VALID_APPROVAL_STATES: readonly ApprovalState[] = [
  'pending',
  'approved',
  'rejected',
  'timeout',
];

/**
 * Check if a value is a valid approval state.
 * @param state - The state to validate
 * @returns True if valid approval state
 */
export function isValidApprovalState(state: unknown): state is ApprovalState {
  return typeof state === 'string' && VALID_APPROVAL_STATES.includes(state as ApprovalState);
}
