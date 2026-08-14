export { FollowUpService, createFollowUpService } from './engine';
export type { FollowUpServiceDeps, FollowUpScanSummary } from './engine';
export { decideFollowUp, isQuietHour, hourInZone, FOLLOWUP_DEFAULT_CONFIG } from './timing';
export type { FollowUpConfig, DueDecision } from './timing';
export { buildFollowUpMessage, describeItems } from './message';
export type { BuildFollowUpMessageInput, FollowUpCartItem } from './message';