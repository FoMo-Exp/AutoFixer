export {
  applyIssueChange,
  createIssueVersionHistory,
  rollbackIssueContent,
  type IncomingIssueChange,
  type IssueContentVersion,
  type IssueSyncField,
  type IssueSyncSource,
  type IssueVersionHistory,
  type ProviderIssueState,
  type SyncedIssueComment,
  type SyncedIssueContent,
} from "./versions.js";
export {
  createProviderIssueApi,
  type CreateProviderIssueInput,
  type IssueFieldsPatch,
  type ProviderIssue,
  type ProviderIssueApi,
  type ProviderIssueComment,
  type IssueSyncAdapterOptions,
} from "./provider-api.js";
export {
  IssueSyncConflict,
  IssueSyncStore,
  type IssueSyncOperation,
  type NewIssueSyncOperation,
  type NewProviderIssueLink,
  type ProviderIssueLink,
} from "./store.js";
export { IssueSyncService, type CreateSyncedIssueInput, type SyncedIssueView } from "./service.js";
