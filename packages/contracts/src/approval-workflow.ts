/** Customer replies request work; each continuation needs its own owner review. */
export const APPROVAL_WORKFLOW_RECIPE = 'reception-approval-workflow';
export const APPROVAL_WORKFLOW_OP = 'core.work-entity.approval-workflow.continue';
export const APPROVAL_WORKFLOW_INGREDIENT = 'approval-workflow-continue';
export const isApprovalWorkflowOperation = (id: string): boolean =>
  id === APPROVAL_WORKFLOW_OP || id === APPROVAL_WORKFLOW_INGREDIENT;
export const APPROVAL_WORKFLOW_TARGET_KINDS = ['task', 'commitment', 'recipe'] as const;
export type ApprovalWorkflowTargetKind = (typeof APPROVAL_WORKFLOW_TARGET_KINDS)[number];

export interface ApprovalWorkflowTarget {
  kind: ApprovalWorkflowTargetKind;
  id: string;
  label: string;
}
export interface ApprovalWorkflowTargetsResult {
  targets: ApprovalWorkflowTarget[];
  truncated: boolean;
}
export interface ApprovalWorkflowContinueInput {
  endpoint_id: string;
  intent_id: string;
  expected_plan_hash: string;
  summary: string;
}
export interface ApprovalWorkflowContinueResult {
  target_kind: ApprovalWorkflowTargetKind;
  target_id: string;
  already_continued: boolean;
  /** A recipe has been handed to the normal engine, with its usual gates. */
  child_run_id?: string;
}
