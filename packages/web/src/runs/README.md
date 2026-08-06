# Run monitoring

`RunScreen` keeps the Run graph and the selected StepRun inspector in one page.
StepRuns are selected with in-page buttons; there is deliberately no URL for a
StepRun. A link to a failure is a link to the Run, plus the Step name.

Logs are requested one StepRun and attempt at a time. The screen does not build
a cross-branch stream because the control plane stores chunks by
`(StepRun, attempt)` and different Runner clocks cannot provide a trustworthy
ordering.
