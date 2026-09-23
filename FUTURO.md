Una futura PR que exponga más info para los plugins?

https://github.com/anomalyco/opencode/pull/27415

No, this PR won't directly help the telegram plugin right now. Here's why:
What the PR does
It introduces a new Effect-native event system (EventV2) in packages/core with typed pub/sub, and a bridge that feeds events into the legacy BusEvent/SyncEvent system. All the existing session events (session.idle, session.error, permission.asked, etc.) continue to flow exactly as before — the plugin's event hook is unchanged.
New events added — but not reachable by plugins
The PR defines rich new events under the session.next.* namespace:
-
session.next.step.started / .ended — LLM turn lifecycle
-
session.next.tool.called / .success / .failed — tool invocations
-
session.next.shell.started / .ended — shell commands
-
session.next.text.delta — streaming text chunks
-
session.next.compaction.started / .ended
-
And more (20+ events)
These would be great for Telegram — live progress updates during a session instead of only the final result at session.idle. But they're marked as version: 1 + aggregate: "sessionID", which means the bridge routes them to SyncEvent (session persistence/replay), not to Bus (real-time in-process). The plugin event hook receives from Bus, so these events won't land in the plugin today.
The one new Bus-routable event: catalog.model.updated
It goes through Bus (no version/aggregate), so the plugin could receive it, but it's irrelevant for Telegram notifications.
Future potential
This PR lays the groundwork. If/when the plugin SDK eventually exposes the Effect runtime or EventV2.subscribe(), the telegram plugin could tap into those rich session events for real-time progress notifications (tool calls, shell commands, steps, etc.). But that's not available yet.
