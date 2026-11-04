import type { Lease } from "../domain/types.js";
import type { TaskStore } from "./task-store.js";

export class LeaseHeldError extends Error {
  constructor(taskId: string, public readonly holder: Lease) {
    super(
      `Task ${taskId} is leased by ${holder.owner} until ${new Date(holder.expiresAt).toISOString()}`,
    );
    this.name = "LeaseHeldError";
  }
}

/**
 * A lease is an execution right, not proof that the old executor stopped.
 * Callers must reconcile in-flight external operations before trusting a takeover.
 */
export class LeaseManager {
  constructor(private readonly tasks: TaskStore) {}

  async acquire(taskId: string, owner: string, ttlMs = 120_000): Promise<Lease> {
    const task = await this.tasks.update(taskId, (draft) => {
      const now = Date.now();
      if (draft.lease && draft.lease.expiresAt > now && draft.lease.owner !== owner) {
        throw new LeaseHeldError(taskId, draft.lease);
      }
      const epoch = (draft.leaseEpoch ?? draft.lease?.epoch ?? 0) + 1;
      draft.leaseEpoch = epoch;
      draft.lease = {
        owner,
        epoch,
        expiresAt: now + ttlMs,
      };
      return draft;
    });
    if (process.env.FORGEPILOT_DEBUG_LEASE) console.error("[lease] acquire", taskId, owner, task.lease?.epoch);
    return task.lease!;
  }

  async heartbeat(taskId: string, lease: Lease, ttlMs = 120_000): Promise<Lease> {
    const task = await this.tasks.update(taskId, (draft) => {
      if (!draft.lease || draft.lease.owner !== lease.owner || draft.lease.epoch !== lease.epoch) {
        throw new LeaseHeldError(taskId, draft.lease ?? { owner: "unknown", epoch: -1, expiresAt: 0 });
      }
      draft.lease.expiresAt = Date.now() + ttlMs;
      return draft;
    });
    return task.lease!;
  }

  async release(taskId: string, lease: Lease): Promise<void> {
    if (process.env.FORGEPILOT_DEBUG_LEASE) console.error("[lease] release", taskId, lease.owner, lease.epoch);
    await this.tasks.update(taskId, (draft) => {
      if (draft.lease && draft.lease.owner === lease.owner && draft.lease.epoch === lease.epoch) {
        draft.lease = undefined;
      }
      return draft;
    });
  }
}
