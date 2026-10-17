---
name: cross-model-team-leader
description: How to lead a CouCou Teamwork team of AI agents from different vendors — triage, split work for parallelism, review once, and finish fast. Use whenever you are the leader of a team.
---

# Leading a cross-model team

You lead a team of agents that run on different models (for example Claude, Codex/GPT, Gemini, DeepSeek). Each one has its own session and screen. Your job is to get the user a correct result in the shortest possible time. A team is only faster than one agent if the members actually work at the same time, so keeping people busy in parallel matters more than being busy yourself.

## How the team runtime behaves

These facts shape every decision below.

- **One turn at a time per member.** Two tasks given to the same member run one after the other. A task assigned to a busy member waits.
- **Messages are read only when a turn starts**, or when the member calls `team_status`. A member deep in a long turn will not see your correction until it is done. A message sent after a task was handed in usually means the work gets redone.
- **Dependents start on delivery, not on acceptance.** A task is released as soon as everything in its `depends_on` has been handed in. Reviewing a task does not unblock anyone; rejecting it sends the chain backwards.
- **Every review lands on you** unless the task is yours. You are the bottleneck for acceptance.
- **The team closes only when every task is accepted.** Each extra task you add pushes the finish line back.

## Step 1: Triage before planning

Decide how big the request is before you create anything.

| Size | Signs | What to do |
|---|---|---|
| **Quick** | One fact, one short answer, one small file. A single agent would finish in a few minutes. | Do it yourself. Create one task with yourself as owner, do it, `deliver` it (your own task is accepted automatically), report to the user with `message_send` to `you`, then call `team_finish`. Do not involve teammates. |
| **Medium** | One deliverable that needs research or checking, but no natural split. | One member does the whole thing and one other member, on a **different model**, reviews it once. This is usually the best quality-per-minute setup. |
| **Large** | Several independent parts (chapters, themes, product lines, modules). | Split the work by scope as described in Step 2. |

When in doubt, choose the smaller size. A team that runs for 20 minutes on a quick question is the failure this skill exists to prevent.

## Step 2: Split by scope, not by stage

**Do:** give each member a slice of the result that they take from start to finish. For example:
- Images: each member generates *and* retouches 2 of the 6 themes.
- Research: one member covers iPhone and Watch, another covers Mac, iPad and the rest. Each gathers *and* verifies their own part.
- Reports: one member writes the fundamentals chapter, another the valuation chapter, and so on.

**Avoid:** pipelines such as gather → verify → write, or draft → refine → review, where each member waits for the one before. With 3 members on a 4-stage pipeline, on average only one of them is working. One agent doing every stage itself would be faster.

Rules for the plan:
1. **Every member has work in your first turn**, including you if you have capacity. Nobody should be waiting with nothing to do.
2. **No member owns more than their share.** If one member holds 3 of 5 tasks, those 3 run one after the other and set the finish time. Move independent tasks to someone idle.
3. **Chains are at most two links long** (for example, one part depends on another part, plus your final integration). If a chain is longer, re-split the work.
4. **Do not put the cheapest or least reliable model at the head of a chain.** If it fails, everyone downstream waits. Cheap models are best used on leaf tasks that nothing depends on.
5. **Create every task up front**, with complete criteria. Adding scope later causes rework.
6. Use `deliver_to` only when someone really needs the output. Every delivery creates a message that someone has to read.

## Step 3: Write tasks that do not come back

Each `task_create` should state:
- **The exact deliverable**: file path, format and length.
- **Done criteria a reviewer can check mechanically.** For example: "every price has a source URL that was actually opened", "6 images at 2400×1600", "every number has a date".
- **Shared rules, written once**, such as units, naming, source standards and what counts as fact versus inference. Put them in the first task or one kickoff message, not in a stream of follow-up rulings.
- **What not to do.** For example: "Do not edit other members' files", "Do not guess URLs: if you cannot open a page, write 查不到", "Do not wait for teammates' corrections. Call `team_status` before you deliver."

Tell members to call `team_status` before they `deliver`, so they pick up any messages that arrived during their turn.

## Step 4: Communicate rarely and completely

- **One kickoff message**, then stay quiet unless something changes the result.
- **Batch your corrections.** One message with three points is better than three messages.
- **Do not re-verify what a member already verified**, unless a spot check is cheap and the claim is critical. Spot-check 2 or 3 items; do not redo the work.
- **Do not broadcast to `all`** unless every member really needs the message.
- If a member finds that the user's premise is wrong (for example, "the stock fell" when it actually rose this month), make one ruling for the whole team, then let the work continue.

## Step 5: Review once, then stop

- **Review against the criteria you wrote**, not against new ideas you have now.
- **Accept or reject in a single `review` call.** When you reject, list every required fix at once, numbered. Never reject the same task twice for different reasons.
- **Accepted means done.** Do not send follow-up "cross-checks" or "please also add" after acceptance. If something new truly matters to the result, create a new task, and only if it changes a conclusion.
- **A second rejection of a task means the split was wrong.** Reassign the task, or do it yourself, instead of rejecting it a third time (at the third rejection the team pauses).
- **Keep review notes short:** a verdict plus the required fixes. Do not paste long recalculations back into messages.

## Step 6: Unblock fast

- **A member is blocked or out of quota (for example, HTTP 429):** move their remaining tasks to another member with `task_assign` right away. Do not wait for the quota to reset.
- **A member is idle while others are overloaded:** split an unstarted task and hand half of it to the idle member.
- **Only the user can decide:** `ask_human` with a short question and 2 to 4 options, and keep the other members working while you wait.

## Step 7: Finish

When the wrap-up prompt arrives, write the final report to the user (`message_send` to `you`): what was produced, where it is, what is known to be missing, and any caveats. Then call `team_finish` straight away. Do not open new tasks for polish the user did not ask for.

## Choosing who does what across models

- **Independence is the main reason to mix models.** A reviewer on a *different* model than the author catches errors the author's model tends to repeat. Pair them that way.
- **Match the task to the tool, not just to the role name.** Check which members can browse, run code or generate images before you assign work. A member without image generation cannot be your image maker, whatever their title says.
- **Give the strongest model the decisions, and give volume to fast or cheap models**, as leaf tasks that you spot-check.
- **Check your own cost.** If you run on the most expensive model, every long message you write costs the most. Keep your turns short.

## Anti-patterns seen in real runs

- One data member owned 3 of 5 tasks. A task with no dependencies waited about 7 minutes for that member to become free.
- The leader sent two team-wide "rulings" while a member was in an 11-minute turn. The member read them only after handing in, and redid the work.
- The leader kept asking for more checks after accepting a task. The file went through v3, v4 and v5, and an extra task was created.
- A cheap gatherer at the head of a gather → verify chain guessed its URLs. Both of its tasks were rejected, and the verifier sat blocked for about 16 minutes.
- A plan → draw → retouch → review pipeline kept only about 1.25 of 3 members working at a time.
- The leader, the verifier and the gatherer each checked the same facts, so the work was done three times.
