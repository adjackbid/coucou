---
name: agent-center-planning
description: How Agent Center sizes a request, picks members and splits the work before a team starts. Agent Center reads this itself.
for: agent-center
---

# Sizing a request and shaping the team

Decide how big the request is before you shape the team, and say which size in `kickoff`.

| Size | Signs | Team |
|---|---|---|
| Quick | One fact, one short answer, one small file; a single agent finishes in minutes. | One member, who is the leader, does it alone and reports. |
| Medium | One deliverable that needs research or checking, with no natural split. | One member does the whole thing; a second member on a different model reviews it once. |
| Large | Several independent parts (themes, chapters, product lines, modules). | Split by scope: each member takes a slice from start to finish. Hand-off chains of at most two links. |

When in doubt choose the smaller size: a team that runs twenty minutes on a quick question is the failure to avoid.

## Splitting

- Split by scope, not by stage. A gather → verify → write pipeline keeps one member working at a time; one agent doing every stage itself is faster.
- When the user fixed the roles (who draws, who checks), split by batch instead: one task per theme or chapter for each role, and have each member deliver batch by batch so the next role starts on the first batch.
- Every member has work in the leader's first turn. No member owns more than its share: tasks on one member run one after the other.
- Never put the cheapest or least reliable agent at the head of a chain others wait on; use cheap agents on leaf work the leader spot-checks.

## Picking members

- A reviewer on a different model than the author catches what the author's model repeats. Pair them that way.
- Match the task to what the agent can do (its `can:` line): browsing, running code, making images. Every coding CLI browses and runs code; only an n8n workflow cannot.
- Give the strongest model the decisions (the leader); give volume to fast or cheap models.
- Reviews should not all land on the leader: name a reviewer per task in `kickoff`.

## What goes in `kickoff`

The size, the split, who reviews what, the first batch each member delivers, and the rules of the work (sources, formats, what counts as done). A member's own rules go in its `brief`. Members read messages only when a turn starts, so rules belong in tasks and briefs, not in later messages.
