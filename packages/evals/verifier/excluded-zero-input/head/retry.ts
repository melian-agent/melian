type Job = { attempts: 1 | 2 | 3 };
function allowance(job: Job): number {
  return 100 / job.attempts;
}
const job: Job = { attempts: 3 };
export const retryAllowance = allowance(job);
