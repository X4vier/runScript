# runScript bash helper — source this in a wrapped script.
#   source "$(dirname "$0")/helpers/runScript.sh"   # or wherever you keep it
#
# Emit progress as a single OVERWRITTEN line "<done> <total> <message...>" to the
# file runScript injected at $RUNSCRIPT_PROGRESS. The engine reads it each tick,
# timestamps it, and derives rate + ETA. Falls back to /dev/null when run
# standalone (outside runScript), so the same script works in both contexts.

# progress <done> <total> [message...]
progress() {
  printf '%s %s %s\n' "$1" "$2" "${*:3}" > "${RUNSCRIPT_PROGRESS:-/dev/null}"
}

# checkpoint_file <name> — echo the path of a resume file in the run dir.
# Use it to skip already-done units across a kill/timeout/restart.
checkpoint_file() {
  local dir="${RUNSCRIPT_RUN_DIR:-.}"
  printf '%s/%s.checkpoint' "$dir" "$1"
}
