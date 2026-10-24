# pi-async-tools

One `async` tool for [pi](https://github.com/earendil-works/pi). It runs any callable pi tool in the background and returns a job id at once. The model keeps working, and the result arrives later as an `<async_result>` message.

```bash
pi install npm:pi-async-tools                              # from npm
pi install git:github.com/UltimateBoomer/pi-async-tools   # persistent
pi -e git:github.com/UltimateBoomer/pi-async-tools        # one run
```

## Tool

| Call | Effect |
|---|---|
| `async({ tool, args })` | Starts a job and returns `job-N` |
| `async({ cancel: "job-N" })` | Aborts a job. It delivers `status="cancelled"` |
| `async({})` | Lists running jobs with their age |

The result message looks like this:

```
<async_result id="job-1" tool="bash" status="ok" seconds="6.0">
async-done
</async_result>
```

`status` is `ok`, `error` or `cancelled`. Text output is truncated to the last 50 KB. Images are counted and left out. The message `details` carry the tool name, the args, the duration and the tool's `usage`.

## How it works

- Jobs run through `ctx.executeTool()`, so argument validation, `tool_call` hooks and `tool_result` hooks apply as for model-issued calls. A sandbox or permission extension sees each background call with a `parentToolCallId`.
- Delivery uses `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`. While the agent is busy, the result queues after the current work. While it is idle, the result starts a new turn.
- In print and json mode, an `agent_before_settle` handler waits for pending jobs before the run ends. Their messages then continue the run, so `pi -p` never exits with a result undelivered.
- Session shutdown aborts every job and delivers nothing.

## Limits

Set in pi's `settings.json`, globally in `~/.pi/agent/settings.json` or per project in `.pi/settings.json`. Project settings apply only in a trusted project.

```json
{
  "asyncTools": {
    "maxJobs": 4,
    "deny": ["edit", "write"]
  }
}
```

- `maxJobs`: concurrent jobs, default 4.
- `deny`: tools that cannot run async, default `["edit", "write"]`. A background edit races the model's own edits to the same file. `async` itself is always denied. A project `deny` replaces the global list.
- Tools with `model-only` or `hidden` exposure are not callable through `executeTool()` and are refused.
- Background tool usage sits in the message details only. pi does not add it to the session totals.
- The background call does not appear in the transcript as a tool call. The `<async_result>` message names the tool and the job.

## Tested

On pi 1.4.0 with a local model:

- An async `sleep 6; echo async-done` ran while a direct `bash` call finished. The model ended its turn, and the result arrived after 6.0 s and continued the run.
- A `tool_call` read blocker blocked an async `read` outside the working directory. The job delivered `status="error"` with the denial text.
- An async `subagent` from [pi-simple-subagents](https://github.com/UltimateBoomer/pi-simple-subagents) returned `73` in 4.5 s, with 22,935 tokens of usage in the details.
- Unit checks: default deny list, unknown tools, the 4 job cap, listing, cancel, shutdown cleanup and the print mode settle wait.
