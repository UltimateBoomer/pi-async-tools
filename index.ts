/**
 * pi-async - one `async` tool that runs any callable pi tool in the background.
 *
 * async({ tool, args }) starts a job and returns its id at once. The model keeps working; when the
 * job ends, its result arrives as a custom message that starts or continues a turn.
 *   - Same checks: jobs run through ctx.executeTool(), so validation, tool_call hooks (sandboxes,
 *     permission gates) and tool_result hooks apply as for model-issued calls.
 *   - Delivery: a follow-up message while the agent is busy, a new turn while it is idle. In
 *     print and json mode the run waits for pending jobs before it settles, so no result is lost.
 *   - Limits: at most PI_ASYNC_MAX_JOBS (default 4) jobs at once. Tools in PI_ASYNC_DENY
 *     (default edit,write) are refused, since a background edit races the model's own edits.
 *   - Cleanup: session shutdown aborts every job.
 *
 * async({ cancel: id }) aborts a job. async({}) lists running jobs.
 */

import { type ExtensionAPI, type ExtensionToolContext, truncateTail } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_JOBS = positiveInt(process.env.PI_ASYNC_MAX_JOBS, 4);
const DENIED = new Set(
	(process.env.PI_ASYNC_DENY ?? "edit,write").split(",").map((name) => name.trim()).filter(Boolean).concat("async"),
);
const MAX_RESULT_BYTES = 50 * 1024;

function positiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return value && Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

interface Job {
	id: string;
	tool: string;
	args: unknown;
	started: number;
	controller: AbortController;
	done: Promise<void>;
}

export default function piAsync(pi: ExtensionAPI) {
	const jobs = new Map<string, Job>();
	let nextId = 1;
	let shuttingDown = false;

	const deliver = (job: Job, status: "ok" | "error" | "cancelled", text: string, details: Record<string, unknown>) => {
		if (shuttingDown) return;
		const seconds = ((Date.now() - job.started) / 1000).toFixed(1);
		const body = truncateTail(text || "(no text output)", { maxBytes: MAX_RESULT_BYTES });
		const note = body.truncated ? `\n[result truncated to the last ${MAX_RESULT_BYTES / 1024} KB]` : "";
		const content = `<async_result id="${job.id}" tool="${job.tool}" status="${status}" seconds="${seconds}">\n${body.content}${note}\n</async_result>`;
		try {
			// Busy: queued as a follow-up after the current work. Idle: starts a new turn.
			void pi.sendMessage(
				{ customType: "async-result", content, display: true, details: { id: job.id, tool: job.tool, args: job.args, status, ...details } },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch {
			// The session ended between the job finishing and delivery.
		}
	};

	const start = (ctx: ExtensionToolContext, tool: string, args: unknown): Job => {
		const job = { id: `job-${nextId++}`, tool, args, started: Date.now(), controller: new AbortController() } as Job;
		job.done = (async () => {
			try {
				const outcome = await ctx.executeTool(tool, args, { signal: job.controller.signal });
				if (job.controller.signal.aborted) return deliver(job, "cancelled", "Cancelled.", {});
				const parts = outcome.result.content;
				const images = parts.filter((part) => part.type === "image").length;
				const text = parts.filter((part) => part.type === "text").map((part) => (part.type === "text" ? part.text : "")).join("\n");
				deliver(job, outcome.isError ? "error" : "ok", images ? `${text}\n[${images} image(s) omitted]` : text, {
					usage: outcome.result.usage,
					durationMs: outcome.durationMs,
				});
			} catch (error) {
				deliver(job, job.controller.signal.aborted ? "cancelled" : "error", error instanceof Error ? error.message : String(error), {});
			} finally {
				jobs.delete(job.id);
			}
		})();
		jobs.set(job.id, job);
		return job;
	};

	const listing = () =>
		jobs.size === 0
			? "No async jobs running."
			: [...jobs.values()].map((job) => `${job.id}: ${job.tool}, ${((Date.now() - job.started) / 1000).toFixed(0)}s`).join("\n");

	pi.registerTool({
		name: "async",
		label: "Async",
		description:
			"Run another tool in the background. Returns a job id at once; the result arrives later as an <async_result> message. " +
			"{ tool, args } starts a job, { cancel: id } aborts one, {} lists running jobs.",
		promptSnippet: "Run a slow tool call in the background and keep working",
		promptGuidelines: [
			"Use async for slow calls whose result you do not need right away, such as long builds, test runs, web fetches or subagents.",
			"After starting a job, continue with other work. Do not poll: the <async_result> message arrives on its own, and you may end your turn while waiting.",
			"Pass args exactly as the target tool expects them.",
		],
		parameters: Type.Object({
			tool: Type.Optional(Type.String({ description: "Name of the tool to run in the background" })),
			args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Arguments for that tool" })),
			cancel: Type.Optional(Type.String({ description: "Job id to abort" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });
			if (params.cancel) {
				const job = jobs.get(params.cancel);
				if (!job) throw new Error(`No running job "${params.cancel}".\n${listing()}`);
				job.controller.abort();
				return text(`Cancel sent to ${job.id} (${job.tool}).`);
			}
			if (!params.tool) return text(listing());

			if (DENIED.has(params.tool)) throw new Error(`"${params.tool}" cannot run async (PI_ASYNC_DENY). Call it directly.`);
			if (!ctx.tools.some((tool) => tool.name === params.tool)) {
				throw new Error(`"${params.tool}" is not a callable tool. Callable: ${ctx.tools.map((tool) => tool.name).filter((name) => !DENIED.has(name)).join(", ")}`);
			}
			if (jobs.size >= MAX_JOBS) throw new Error(`${MAX_JOBS} async jobs already running (PI_ASYNC_MAX_JOBS).\n${listing()}`);

			const job = start(ctx, params.tool, params.args ?? {});
			return text(`Started ${job.id}: ${job.tool}. The result arrives as an <async_result id="${job.id}"> message.`);
		},
	});

	// Print and json mode exit when the run settles. Hold the run until pending jobs deliver; their
	// follow-up messages then continue it. Interactive and rpc sessions stay open, so no wait.
	pi.on("agent_before_settle", async (_event, ctx) => {
		if (ctx.mode !== "print" && ctx.mode !== "json") return;
		while (jobs.size > 0) await Promise.all([...jobs.values()].map((job) => job.done));
	});

	pi.on("session_shutdown", () => {
		shuttingDown = true;
		for (const job of jobs.values()) job.controller.abort();
		jobs.clear();
	});
}
