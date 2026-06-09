#!/usr/bin/env bash
# install.sh — symlink the runScript CLI into ~/.local/bin and ensure it's on
# PATH. Idempotent: safe to re-run. Does NOT touch your ~/.claude/CLAUDE.md
# (the agent offers that separately, with your consent).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_SRC="$REPO_DIR/runScript.ts"
BIN_DIR="$HOME/.local/bin"
BIN_DST="$BIN_DIR/runScript"

say()  { printf '  %s\n' "$1"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; }

echo "Installing runScript…"

# 1. Bun must be present (the CLI shebang is #!/usr/bin/env bun).
if ! command -v bun >/dev/null 2>&1; then
  warn "Bun is not installed. Install it first:  curl -fsSL https://bun.sh/install | bash"
  exit 1
fi
ok "Bun $(bun --version)"

# 2. Make the CLI executable.
chmod +x "$BIN_SRC"

# 3. Symlink into ~/.local/bin.
mkdir -p "$BIN_DIR"
if [ -L "$BIN_DST" ] || [ -e "$BIN_DST" ]; then
  if [ "$(readlink "$BIN_DST" 2>/dev/null || true)" = "$BIN_SRC" ]; then
    ok "Symlink already in place: $BIN_DST"
  else
    warn "Replacing existing $BIN_DST"
    ln -sf "$BIN_SRC" "$BIN_DST"
    ok "Linked $BIN_DST → $BIN_SRC"
  fi
else
  ln -s "$BIN_SRC" "$BIN_DST"
  ok "Linked $BIN_DST → $BIN_SRC"
fi

# 4. Ensure ~/.local/bin is on PATH (zsh + bash), idempotently.
PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'
ensure_path() {
  local rc="$1"
  [ -f "$rc" ] || return 0
  if grep -qF "$PATH_LINE" "$rc" 2>/dev/null; then return 0; fi
  if grep -q '.local/bin' "$rc" 2>/dev/null; then ok "PATH already configured in $rc"; return 0; fi
  printf '\n# Added by runScript install.sh\n%s\n' "$PATH_LINE" >> "$rc"
  ok "Added ~/.local/bin to PATH in $rc"
  NEED_RELOAD=1
}
NEED_RELOAD=0
case ":$PATH:" in
  *":$BIN_DIR:"*) ok "~/.local/bin already on PATH" ;;
  *)
    ensure_path "$HOME/.zshrc"
    ensure_path "$HOME/.bashrc"
    ensure_path "$HOME/.bash_profile"
    ;;
esac

echo
if command -v runScript >/dev/null 2>&1; then
  ok "runScript resolves on PATH → $(command -v runScript)"
else
  warn "runScript not yet on PATH for this shell."
fi
echo
echo "Next steps:"
[ "$NEED_RELOAD" = "1" ] && say "• Reload your shell:  exec \$SHELL  (or open a new terminal)"
say "• Try it:            runScript help"
say "• Optional (global discipline): merge rules/claude-rules.md into ~/.claude/CLAUDE.md"
say "  so the running-scripts protocol applies across all your projects."
ok "Done."
