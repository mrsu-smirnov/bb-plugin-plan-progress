Live progress bars for agent work, above a thread's message box.

## What you get

- The agent splits a task into stages and steps; a bar above the message box
  fills as it works.
- Four states: working, needs your answer, error, done.
- Click the bar for every bar of the thread: stages, steps, how long each
  took, and a close button.
- The plan can change mid-task; finished steps keep their done by title.
- Works with any BB agent (Claude Code, Codex, others), on desktop and phone.

## How it works

The plugin adds a `plan_progress` tool. The agent sends the plan once, then
short ops such as `{id, next: true}`. Bars are stored per thread on your BB
server and nothing leaves the machine.

After [plan-progress](https://github.com/zycck/claude-mods) by zycck for
Claude Code.
