/** Pure crash-recovery decision over footage records (see JobsService.onModuleInit) */
export const STEP_ORDER = ['probe', 'proxy', 'frames', 'transcribe', 'grade', 'caption-style'] as const;
export type Step = (typeof STEP_ORDER)[number];
export const ASSEMBLING_STALE_MS = 10 * 60_000;

export type RecoveryRecord = { _id: any; status: string; jobs?: Record<string, { state?: string }>; updatedAt?: Date | string | number };
export type RecoveryPlan = { reset: string[]; requeue: { id: string; step: Step }[] };

export function planRecovery(records: RecoveryRecord[], now = Date.now()): RecoveryPlan {
  const plan: RecoveryPlan = { reset: [], requeue: [] };
  for (const r of records) {
    const id = String(r._id);
    if (r.status === 'assembling') {
      const t = r.updatedAt ? new Date(r.updatedAt).getTime() : 0;
      if (now - t > ASSEMBLING_STALE_MS) plan.reset.push(id); // chunks are kept until processing is saved, so the client can complete again
    } else if (r.status === 'processing') {
      const step = STEP_ORDER.find((s) => r.jobs?.[s]?.state === 'queued' || r.jobs?.[s]?.state === 'running');
      if (step) plan.requeue.push({ id, step });
    }
  }
  return plan;
}
