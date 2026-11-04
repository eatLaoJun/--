import path from "node:path";
import { ArtifactStore } from "../store/artifact-store.js";
import { CheckpointStore, VerificationStore } from "../store/checkpoint-store.js";
import { EventLog } from "../store/event-log.js";
import { LeaseManager } from "../store/lease.js";
import { OperationStore } from "../store/operation-store.js";
import { TaskStore } from "../store/task-store.js";
import { LocalPrAdapter } from "../integrations/pr.js";
import { ReviewChatStore } from "../store/review-chat-store.js";

export interface HarnessStores {
  tasks: TaskStore;
  artifacts: ArtifactStore;
  operations: OperationStore;
  checkpoints: CheckpointStore;
  verifications: VerificationStore;
  events: EventLog;
  leases: LeaseManager;
  pr: LocalPrAdapter;
  reviewChat: ReviewChatStore;
}

export function createStores(root: string): HarnessStores {
  const tasks = new TaskStore(root);
  return {
    tasks,
    artifacts: new ArtifactStore(root),
    operations: new OperationStore(root),
    checkpoints: new CheckpointStore(root),
    verifications: new VerificationStore(root),
    events: new EventLog(root),
    leases: new LeaseManager(tasks),
    pr: new LocalPrAdapter(path.join(root, "prs")),
    reviewChat: new ReviewChatStore(root),
  };
}
