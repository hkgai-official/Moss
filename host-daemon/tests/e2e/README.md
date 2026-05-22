# MOSS Evolution Control Surface — E2E Tests

`test_evolution_control.sh` exercises real `openclaw agent --message --json`
conversations against the running moss-gateway to validate the agent actually
uses the `moss evo` CLI as described in `evolution.md`.

## Running

```bash
MOSS_E2E=1 \
MOSS_GATEWAY_TOKEN=<your-token> \
MOSS_DATA_DIR=/path/to/data \
bash host-daemon/tests/e2e/test_evolution_control.sh
```

## Scenarios

| # | Name | Status |
|---|---|---|
| 1 | Capability description loaded | implemented |
| 2 | Status query routes to `moss evo status` | implemented |
| 3 | Batches listing | implemented |
| 4 | Batch detail | STUB (needs fixture) |
| 5 | Trigger evolution | STUB (destructive) |
| 6 | Stop evolution | STUB (needs running evo) |
| 7 | Natural-language flag of current session | implemented |
| 8 | Converged notification | STUB (webhook orchestration) |
| 9 | Failed notification | STUB |
| 10 | apply-complete on new instance | STUB (container swap) |

The STUBs are honest about what hasn't been validated end-to-end yet. They
require fixtures, destructive actions, or orchestration that is unsafe for an
automated harness. Validate them manually as you observe real behavior.

## Notes

- LLM responses are inherently non-deterministic. Scenarios 1–3 use loose
  assertions (the reply just needs to mention a relevant keyword), not exact
  matching.
- Scenario 7 (flag) uses a two-turn conversation — first turn primes the
  session, second turn asks to flag. The CLI's `--session-id` keeps both
  turns in the same session.
- If a stubbed scenario becomes well-defined later, replace the TODO body
  with the real test logic.
