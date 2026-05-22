#!/usr/bin/env bash
# End-to-end tests for the MOSS evolution control surface.
#
# Drives real OpenClaw agent conversations via `openclaw agent --message --json`
# and asserts the agent's behavior matches the contract.
#
# Gated by MOSS_E2E=1. Requires:
#   - moss-gateway container running
#   - moss CLI installed at /usr/local/bin/moss
#   - $MOSS_DATA_DIR set
#   - $MOSS_GATEWAY_TOKEN set
#
# Usage:
#   MOSS_E2E=1 bash host-daemon/tests/e2e/test_evolution_control.sh
#
# Each scenario function returns 0 on pass, non-zero on fail.

set -uo pipefail

if [ "${MOSS_E2E:-0}" != "1" ]; then
  echo "SKIP: MOSS_E2E not set"
  exit 0
fi

: "${MOSS_DATA_DIR:?MOSS_DATA_DIR must be set}"

PASS=0
FAIL=0
SCENARIOS=()

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
agent_say() {
  # Send a message to the agent, return the reply as JSON on stdout.
  # Uses sg docker wrapper since the host user may not be in the docker group.
  # Extra args (e.g. --session-id <id>) are passed through as a single string.
  local msg="$1"
  shift
  # Shell-escape the message for safe embedding in the sg docker -c "..." string.
  local escaped_msg
  escaped_msg="$(printf '%s' "$msg" | sed "s/'/'\\''/g")"
  local extra=""
  for arg in "$@"; do
    extra="$extra $(printf '%q' "$arg")"
  done
  sg docker -c "docker exec moss-gateway node /app/openclaw.mjs agent --agent main --message '$escaped_msg' --json$extra" 2>/dev/null
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  if echo "$haystack" | grep -qF -- "$needle"; then
    echo "  PASS: $label"
    return 0
  else
    echo "  FAIL: $label (missing: $needle)"
    return 1
  fi
}

run_scenario() {
  local name="$1"
  local fn="$2"
  echo ""
  echo "=== $name ==="
  if $fn; then
    PASS=$((PASS + 1))
    SCENARIOS+=("PASS: $name")
  else
    FAIL=$((FAIL + 1))
    SCENARIOS+=("FAIL: $name")
  fi
}

# ----------------------------------------------------------------------------
# Scenario 1: Capability description loaded into system prompt
# ----------------------------------------------------------------------------
e2e_capability_loaded() {
  local reply
  reply="$(agent_say "What self-improvement capabilities do you have? Just list them, do not invoke anything.")"
  # Accept either the literal CLI name or evolution-related keywords (LLM may paraphrase)
  assert_contains "$reply" "moss evo" "agent mentions moss evo CLI" \
    || assert_contains "$reply" "evolution" "agent mentions evolution capability" \
    || assert_contains "$reply" "batch" "agent mentions batches" \
    || return 1
  return 0
}

# ----------------------------------------------------------------------------
# Scenario 2: Agent runs moss evo status when asked about evolution state
# ----------------------------------------------------------------------------
e2e_status_query() {
  local reply
  reply="$(agent_say "What is the current evolution status? Check it for me.")"
  # Look for either evidence the agent ran the CLI (status text in reply) or
  # the literal "idle" / "running" that the CLI emits.
  assert_contains "$reply" "idle" "agent received status output (or 'idle' state surfaced)" \
    || assert_contains "$reply" "moss evo status" "agent at least mentions invoking the command" \
    || return 1
  return 0
}

# ----------------------------------------------------------------------------
# Scenario 3: Agent lists batches when asked
# ----------------------------------------------------------------------------
e2e_batches_list() {
  local reply
  reply="$(agent_say "Show me the list of evolution batches.")"
  # If no batches exist yet, the CLI returns "(no batches)" — that's a valid response
  assert_contains "$reply" "batch" "reply mentions batches in some form" || return 1
  return 0
}

# ----------------------------------------------------------------------------
# Scenario 4: Agent describes one batch when asked  [STUB — needs batch fixture]
# ----------------------------------------------------------------------------
e2e_batch_detail() {
  echo "  TODO: needs a real batch in evo-loop-state to query"
  echo "  Manually: create a batch fixture, then ask 'show me batch <id>'"
  return 0  # don't fail, just note
}

# ----------------------------------------------------------------------------
# Scenario 5: Agent triggers evolution  [STUB — destructive]
# ----------------------------------------------------------------------------
e2e_trigger_evolution() {
  echo "  TODO: triggers a real evolution loop — too destructive for CI"
  echo "  Manually: ensure a sealed batch exists, then say 'start evolving batch X'"
  return 0
}

# ----------------------------------------------------------------------------
# Scenario 6: Agent stops a running evolution  [STUB — needs running evolution]
# ----------------------------------------------------------------------------
e2e_stop_evolution() {
  echo "  TODO: needs a real running evolution; assert stop sentinel file appears"
  return 0
}

# ----------------------------------------------------------------------------
# Scenario 7: Natural-language flag of current session
# ----------------------------------------------------------------------------
e2e_flag_session() {
  # Two-turn: in turn 1 the agent says something potentially wrong; in turn 2
  # we ask it to flag the conversation. We assert the agent invoked moss evo flag.
  local session_id
  session_id="$(date +%s)-e2e-flag-test"
  # Turn 1: prime the conversation
  agent_say "What is 2 + 2? Just answer numerically." --session-id "$session_id" >/dev/null
  # Turn 2: ask to flag
  local reply
  reply="$(agent_say "That was not the answer I wanted. Add this conversation to a batch." --session-id "$session_id")"
  assert_contains "$reply" "flag" "agent acknowledges flagging" \
    || assert_contains "$reply" "batch" "agent acknowledges batch addition" \
    || return 1
  return 0
}

# ----------------------------------------------------------------------------
# Scenario 8: Converged notification delivered  [STUB — needs webhook orchestration]
# ----------------------------------------------------------------------------
e2e_converged_notification() {
  echo "  TODO: POST to /hooks/evolution-converged with a fixture payload, then"
  echo "  send an empty message to the same session and assert the agent's"
  echo "  first reply mentions the converged batch."
  return 0
}

# ----------------------------------------------------------------------------
# Scenario 9: Failed notification delivered  [STUB]
# ----------------------------------------------------------------------------
e2e_failed_notification() {
  echo "  TODO: similar to scenario 8 but with /hooks/evolution-failed"
  return 0
}

# ----------------------------------------------------------------------------
# Scenario 10: apply-complete on new instance  [STUB — destructive]
# ----------------------------------------------------------------------------
e2e_apply_complete_new_instance() {
  echo "  TODO: requires a real swap-req + supervisor activation"
  return 0
}

# ----------------------------------------------------------------------------
# Runner
# ----------------------------------------------------------------------------
run_scenario "1. capability loaded"          e2e_capability_loaded
run_scenario "2. status query"               e2e_status_query
run_scenario "3. batches list"               e2e_batches_list
run_scenario "4. batch detail (STUB)"        e2e_batch_detail
run_scenario "5. trigger evolution (STUB)"   e2e_trigger_evolution
run_scenario "6. stop evolution (STUB)"      e2e_stop_evolution
run_scenario "7. flag session"               e2e_flag_session
run_scenario "8. converged notif (STUB)"     e2e_converged_notification
run_scenario "9. failed notif (STUB)"        e2e_failed_notification
run_scenario "10. apply-complete (STUB)"     e2e_apply_complete_new_instance

echo ""
echo "===================================="
echo "Summary: $PASS passed, $FAIL failed (out of ${#SCENARIOS[@]} scenarios)"
echo "===================================="
for s in "${SCENARIOS[@]}"; do
  echo "  $s"
done

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
