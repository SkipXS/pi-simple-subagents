export const ROLE_RUN_PURPOSES = ["context", "implementation", "review", "fix", "validation"] as const;
export const WORKER_PURPOSES = ["implementation", "fix", "validation"] as const;

export const DEFAULT_WORKER_OUTPUT_FILE = "worker-report.md";
export const CONFIG_EFFECTIVE_FILE = "config-effective.json";
export const INPUT_WORKER_TASK_FILE = "input-worker-task.md";
export const INPUT_TARGET_FILE = "input-target.md";
export const SCOUT_REVIEW_CONTEXT_FILE = "scout-review-context.md";
export const FINAL_SUMMARY_FILE = "final-summary.md";
export const REVIEW_FAILURE_SUMMARY_FILE = "review-failure-summary.md";
export const PARALLEL_WORKERS_FILE = "parallel-workers.md";
export const PARALLEL_WORKERS_SUMMARY_FILE = "parallel-workers-summary.md";

export const WORK_PARALLEL_TASK_KEYS = ["name", "task", "purpose", "outputFile"] as const;
export const WORK_PARALLEL_ROOT_KEYS = ["tasks"] as const;
