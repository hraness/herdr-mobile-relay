# Supplemental formatter experiment

This disposable diagnostic branch descends from `fad4d975ee482e95860ff56a250d4c318a9f1835`.
Never merge it into `dev` or `main`. Root owns review, commit, push and one CI run.
All four first-experiment files and the original mobile/product sources remain
byte-exact. The first workflow triggers only on `codex/herdr-clock-ci-diag-20261109`;
the supplemental workflow triggers only on `codex/herdr-date-format-ci-diag-20261109`.
The previous clock experiment and two witness cases are not rerun on this push.

The retained report from run `42524344956`, SHA
`c2742eb13c09bb234327f607056987bcae62675d0dc8d60e4ff16d613a64a27b`,
completed all 4096 samples normally. File samples had 208/2048 future comparisons
(maximum 935ms); pipe samples had 207/2048 (maximum 983ms), including after close.
Its 32 retained outliers cluster near the first 100ms of Bun's epoch seconds.
For example, the date text was `1794172579831` while Bun observed `1794172579008`.
This pattern suggests checking formatter width and leading zero behavior. It
does not establish a Bun bug or explain the separate positive-witness failure.
Both unchanged witness cases passed their single isolated replay.

Root consulted the primary GNU documentation for
[padding and flags](https://www.gnu.org/software/coreutils/manual/html_node/Padding-and-other-flags.html)
and [time conversions](https://www.gnu.org/s/coreutils/manual/html_node/Time-conversion-specifiers.html).
Those describe the default nine-digit nanosecond range and width adjustment.
No GNU source or installed GNU manual was available in the author's bounded local
documentation search. The experiment records the actual runner's GNU version and
binary SHA rather than assuming which formatter behavior its implementation has.
Root also verified the two supported explicit image labels in the official
[runner image catalog](https://github.com/actions/runner-images/blob/main/README.md).
The supplemental matrix uses `ubuntu-24.04` and `ubuntu-26.04`, five minutes per
job, with identical vectors and separate artifacts. The source records the actual
OS version, admitting only those two families. This compares an older supported
image with the observed image before any possible CI-lane pin is proposed; no
production/default workflow or mobile test is changed here.

Every formatter observation is from one GNU `date` invocation with
`+%s|%N|%3N|%s%N|%s%3N`. Thirteen read-only `--date=@1700000000.<nine digits>`
inputs cover zero, sub-millisecond, 1ms, 7.831ms, 14.4ms, 99ms, 100ms and 999ms
boundaries. These fixed inputs distinguish formatting behavior from the current
clock or Bun. They never set the system clock. The script then takes 2048
current-time tuples and compares narrow and full-precision-derived values with
Bun's immediate first-output and later child-close clock readings.

The candidate is admitted only when the full nanosecond field has exactly nine
digits and the concatenated seconds/nanoseconds agree within that same call.
It truncates six trailing digits as a **string**, before converting the resulting
milliseconds to a JS number. This avoids unsafe full-epoch-nanosecond rounding.
No new candidate is used by production or mobile tests. Their future-time
assertion and two-second bound are unchanged.

The existing exact-hash-pinned command transport retains its owned-child,
exit-before-close, cancellation, timeout and uncertainty rules. Sampling is
bounded to 60 seconds, commands to two seconds, with at most one additional
second of refused-child cleanup. Only safe numeric formatter tuples, bounded
counts and at most 32 examples are retained in the new one-day artifact. No
user output, credentials, argv dump or environment dump is collected. Diagnostic
success means only that sampling completed; all observed differences remain in
the report and no cause or product qualification is asserted.

Local fixtures inject current-time sampling and execute no GNU date process,
XCTest or native operation. Root reviews the evidence before choosing any change
to the original timestamp producer.
