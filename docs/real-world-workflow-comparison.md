# Direct Agent vs Juno: Real Repository Workflow Comparison

This comparison records two sequential, real repository audits performed on the same Windows developer
machine on 2026-07-29. It evaluates workflow behavior and completion evidence. It is not a controlled
benchmark of model intelligence: the repository changed between runs because the first audit found a valid
P0 defect, which was fixed before the Juno run.

## Scenario

Both tasks audited Juno-Oversight for non-visual product release readiness. They inspected onboarding,
diagnostics, smoke behavior, direct control, repository policy, CI, builds, and tests, then wrote one report
without committing or pushing.

| Measurement | Direct one-shot agent | Juno governed mission |
|-------------|-----------------------|-----------------------|
| Repository state | `d6aaf8c`, before the smoke isolation fix | `9d8d325`, after the P0 fix |
| Output | `docs/direct-agent-baseline-evaluation.md` | `docs/juno-governed-product-readiness-evaluation.md` |
| Report verdict | `NO-GO` | `NO-GO` for release; local developer-preview gates passed |
| Useful artifact | Report written after about 4 minutes | Final governed result after 628.6 seconds |
| Caller result | Timed out after 904.1 seconds, exit `124` | Returned normally, exit `0`, `outcome=complete` |
| Progress while running | No durable phase, checkpoint, heartbeat, or queryable status | Four queryable phases, active run, Worker PID, queue depth, retries, and scheduler heartbeat |
| Quality gates | Commands run by the same one-shot execution | Independent review `PASS`; verify `PASS` |
| Terminal cleanup | Underlying call did not terminate by itself | Queue `0`; Worker stopped; scheduler remained enabled and running |
| Retries | Not externally visible | `0`, with an explicit maximum of `3` per phase |

## What the direct agent did well

The direct agent found the most important defect in the initial repository state: `pnpm loop:smoke` reused
the configured Live workbench, replaced its queue, and disabled the Live scheduler. It produced a detailed,
useful report faster than Juno produced its final governed result. A one-shot call is therefore still the
better fit when speed, low call count, and exploratory diagnosis matter more than a durable completion
contract.

Its weakness was not the quality of that finding. The weakness was lifecycle certainty: after writing the
report, the underlying call remained active until an external 15-minute timeout. There was no machine-
readable way to distinguish useful work, self-review, test execution, cleanup, and terminal completion.

## What Juno added

The P0 was fixed before the governed run. Juno then independently verified that the isolated smoke passed,
the configured Live queue hashes were preserved, the scheduler stayed enabled, and the full local desktop
gate and Rust tests passed. The caller could observe every transition:

```text
p01-plan      done
p02-implement done
p03-review    done  -> review PASS
p04-verify    done  -> verify PASS
mission       COMPLETE
queue         0
worker        stopped
```

Juno did not merely turn a `NO-GO` into a `GO`. It preserved the negative release verdict where evidence was
missing: no green GitHub Actions run was available at audit time, cold-clone onboarding was not executed,
and the upstream dependency advisory remained. This is the practical quality improvement: claims were
separated from evidence, and the task received a deterministic terminal state after independent gates.

## Product advantage

Juno's measurable advantage is workflow reliability rather than raw model intelligence:

- programmatic submission and final JSON remove desktop `computer use` from the normal control path;
- phase state and heartbeats make long-running work observable and recoverable;
- independent review and verify prevent file creation from being treated as completion;
- bounded retries and explicit terminal outcomes make automation decisions possible;
- queue and Worker cleanup are part of the result, not an operator assumption.

The cost is also measurable: the governed run used separate model work for plan, implementation, review,
and verification and took about 10 minutes 29 seconds. The direct run surfaced its useful report sooner and
is likely cheaper. Juno should be used for consequential tasks where completion evidence, review separation,
and unattended recovery justify that overhead.

## Conclusion

The experiment supports a narrow but defensible product claim: Juno improves the reliability and
inspectability of AI work completion. It does not prove that Juno makes the underlying model smarter, faster,
or universally better. The direct baseline supplied an important diagnosis; Juno supplied the governed
execution contract needed to verify the fix and finish with auditable state.
