# Isolated CI diagnosis

This branch is a disposable experiment based on fork `dev` at
`753038b0d54633d1e2647b8bd474bcb5de005ea9`. Never merge it into `dev` or `main`.
Root owns review, commit, push and the single diagnostic CI run. The author runs
only source/static fixtures with all child-process boundaries injected locally.
No production code, mobile test assertion, timeout or default workflow changes.

PR3 run `42519849205` had two different failures. Attempt 1 failed
`listener-concurrent-exit-before-close` at the shell timestamp comparison,
`xctest-owner.ts:2214`. Attempt 2 passed that case and failed the positive owned
terminal witness at line 5836; the parent retained only the category `other` and
nested stderr SHA `75aef18f0752a6b914f14304f6523c1f7363b8ba8eb0ec48614e3dc7558704a4`.
Both jobs used Bun 1.4.4 and Ubuntu 26.04.1, image version `20261101.186.1`
selected by `ubuntu-latest`. Neither failure is classified as a known transient.

The new workflow runs on pushes to this exact diagnostic branch only, with
read-only contents permission and no secrets or PR trigger. Checkout uses the
exact `github.sha`, depth 1 and no persisted credentials. Actions are pinned to
the same immutable revisions as the existing workflow.

The five-minute clock-only job admits the exact original test SHA
`8b93d1644262f180cf2b211c0e099b1a16e2b09f3bcdb4ee7af4124ccd121789`.
It extracts the existing shell clock function and file publisher, preserving
the intervening `cat` reads and atomic rename. Dummy protocol IDs are never
used as process authority. The caller polls the published file as the original
does, then compares its integer timestamp with Bun `Date.now()` immediately.
Alternating direct GNU `date` pipe samples also compare at first stdout data
and at child close. There are at most 2048 pairs, a 90-second monotonic sampling
bound, a two-second command cap and at most one second of refused-child cleanup.
Polling is the original file wait; no
extra sleep is used to make the comparison pass. A future timestamp is counted
as the unchanged assertion's failure and makes the diagnostic exit nonzero.
The artifact is bounded safe counts, time deltas, at most 32 outliers, public
runtime/OS metadata and source hashes; it contains no raw process argv, user
output, credentials or environment dump.

Commands use only the exact returned, still-live child handle for cleanup, never
a process scan or guessed process group. An exited leader with open inherited
pipes is not signalled. Normal exits allow deletion of the owned temp
tree. Refusal/cancellation keeps it and reports uncertainty; no automatic retry
or descendant-census claim is made. This is an ephemeral Linux runner experiment,
not permission to run the fixtures against the owner's Mac or existing workers.

The separate fifteen-minute job installs the original pinned Node 26.13.0,
Bun 1.4.4, Go 1.27.3 and XML prerequisites. It replays the two exact original
case names once through the documented unit runner, retaining all assertions,
deadlines, kernel observations and cleanup checks. No complete mobile or product
qualification claim follows from this selected replay. Original raw stdout and
stderr are redirected away from step logs, and the existing
`XCTEST_DIAGNOSTIC_ROOT` protocol export is retained in a one-day artifact.
That existing export does **not** retain the nested positive child's full stderr:
its parent records only a category/hash, while the nested child can export
protocol/teardown/error receipts. This experiment may expose the cause through
those receipts; it must not claim it recovered missing nested bytes.

Local validation is `bun --no-env-file test scripts/diagnostics/bun-clock-ci.test.ts`
through the required absolute host scheduler's shared compute lane. The fixtures
inject every spawn boundary and check timing accounting, bounded records,
cancel/timeout cleanup, unchanged source extraction and workflow restrictions.
