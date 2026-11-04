import type { Budget, Lifecycle, Stage, TaskState } from "./types.js";

export interface Checkpoint {
  id: string;
  taskId: string;
  stage: Stage;
  lifecycle: Lifecycle;
  taskVersion: number;
  nextSafeAction: string;
  workspace: {
    path: string;
    head: string;
    patchHash: string;
    diffStat: string;
  };
  operationsDone: string[];
  operationsPending: string[];
  verificationFingerprint?: string;
  state: TaskState;
  budget: Budget;
  createdAt: number;
}
