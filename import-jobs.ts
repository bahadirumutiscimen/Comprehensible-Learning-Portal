export type ImportSource = "epub" | "youtube";
export type ImportJobStatus = "queued" | "running" | "paused" | "complete" | "failed" | "cancelled";
export type ImportJobStage =
	| "validating"
	| "saving"
	| "extracting"
	| "segmenting"
	| "translating"
	| "indexing"
	| "complete";

export interface ImportJob {
	id: string;
	source: ImportSource;
	input: string;
	displayName: string;
	status: ImportJobStatus;
	stage: ImportJobStage;
	completed: number;
	total: number;
	createdAt: number;
	updatedAt: number;
	checkpoint: Record<string, number | string | boolean>;
	error?: string;
}

export function createImportJob(source: ImportSource, input: string, displayName: string): ImportJob {
	const now = Date.now();
	return {
		id: `${source}-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		source,
		input,
		displayName,
		status: "queued",
		stage: "validating",
		completed: 0,
		total: 0,
		createdAt: now,
		updatedAt: now,
		checkpoint: {},
	};
}

export function patchImportJob(job: ImportJob, patch: Partial<ImportJob>): ImportJob {
	return { ...job, ...patch, updatedAt: Date.now() };
}

/** A cancelled/failed/stale job may remain in the serialized queue, but it must
 * only execute after an explicit transition back to queued. */
export function canStartImportJob(job: ImportJob): boolean {
	return job.status === "queued";
}
