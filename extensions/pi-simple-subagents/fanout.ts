import type { Config } from "./config.ts";

export function fanoutConcurrency(config: Config, itemCount: number): number {
	return Math.max(1, Math.min(itemCount, config.children.maxConcurrentSubagents));
}

async function allSettledWithConcurrency<T>(count: number, concurrency: number, run: (index: number) => Promise<T>, shouldStartMore: () => boolean = () => true): Promise<Array<PromiseSettledResult<T>>> {
	const settled = new Array<PromiseSettledResult<T>>(count);
	let next = 0;
	let active = 0;
	return await new Promise<Array<PromiseSettledResult<T>>>((resolve) => {
		const finishSkipped = () => {
			while (next < count) {
				settled[next++] = { status: "rejected", reason: new Error("not started because a sibling subagent failed or the run was aborted") };
			}
		};
		const pump = () => {
			if (!shouldStartMore()) finishSkipped();
			while (active < concurrency && next < count && shouldStartMore()) {
				const index = next++;
				active++;
				Promise.resolve(run(index)).then(
					(value) => { settled[index] = { status: "fulfilled", value }; },
					(reason) => { settled[index] = { status: "rejected", reason }; },
				).finally(() => {
					active--;
					if (next >= count && active === 0) resolve(settled);
					else pump();
				});
			}
			if (next >= count && active === 0) resolve(settled);
		};
		pump();
	});
}

export async function runFanout<T>(input: {
	count: number;
	concurrency: number;
	signal?: AbortSignal;
	abortOnError: boolean;
	run: (index: number, signal: AbortSignal) => Promise<T>;
}): Promise<Array<PromiseSettledResult<T>>> {
	const localAbort = new AbortController();
	const forwardAbort = () => localAbort.abort(input.signal?.reason);
	if (input.signal) {
		if (input.signal.aborted) forwardAbort();
		else input.signal.addEventListener("abort", forwardAbort, { once: true });
	}
	try {
		return await allSettledWithConcurrency(input.count, input.concurrency, async (index) => {
			try {
				return await input.run(index, localAbort.signal);
			} catch (error) {
				if (input.abortOnError && !localAbort.signal.aborted) localAbort.abort(error);
				throw error;
			}
		}, () => !localAbort.signal.aborted);
	} finally {
		if (input.signal) input.signal.removeEventListener("abort", forwardAbort);
	}
}
