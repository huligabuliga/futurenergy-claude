#!/bin/bash
# Future Energy — Claude Config Setup
# Installs all MCP servers + skills into ~/.claude/ and wires them into Claude Desktop / Claude Code.

set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"

# MCP servers to install (directory name under mcp-servers/ in this repo)
MCP_SERVERS=("salesforce-futurenergy" "futurerp")

# Skills to symlink (directory name under skills/ in this repo)
SKILLS=("salesforce-futurenergy" "futurerp")

echo "=== Future Energy Claude Setup ==="
echo "Repo: $REPO_DIR"
echo ""

# ── Preflight checks ─────────────────────────────────────────

MIN_NODE_MAJOR=18
MISSING=()
WRONG_VERSION=()

# Detect OS + package manager for install hints
OS_NAME="unknown"
PM_INSTALL=""
if [[ "$OSTYPE" == "darwin"* ]]; then
  OS_NAME="macOS"
  if command -v brew >/dev/null 2>&1; then
    PM_INSTALL="brew install"
  else
    PM_INSTALL="# Install Homebrew first: https://brew.sh"
  fi
elif [[ "$OSTYPE" == "linux"* ]]; then
  OS_NAME="Linux"
  if command -v apt-get >/dev/null 2>&1; then
    PM_INSTALL="sudo apt-get install -y"
  elif command -v dnf >/dev/null 2>&1; then
    PM_INSTALL="sudo dnf install -y"
  elif command -v pacman >/dev/null 2>&1; then
    PM_INSTALL="sudo pacman -S --noconfirm"
  elif command -v zypper >/dev/null 2>&1; then
    PM_INSTALL="sudo zypper install -y"
  else
    PM_INSTALL="# Use your distro's package manager to install:"
  fi
fi

if ! command -v git >/dev/null 2>&1; then
  MISSING+=("git")
fi
if ! command -v node >/dev/null 2>&1; then
  MISSING+=("node")
else
  NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
  if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
    WRONG_VERSION+=("node $(node -v) — need >= v${MIN_NODE_MAJOR}")
  fi
fi
if ! command -v npm >/dev/null 2>&1; then
  MISSING+=("npm")
fi

if [ ${#MISSING[@]} -gt 0 ] || [ ${#WRONG_VERSION[@]} -gt 0 ]; then
  echo "✗ Missing or outdated dependencies on $OS_NAME:"
  for m in "${MISSING[@]}"; do echo "   - $m (not installed)"; done
  for w in "${WRONG_VERSION[@]}"; do echo "   - $w"; done
  echo ""
  echo "Install with:"
  if [[ "$OS_NAME" == "macOS" ]]; then
    echo "  $PM_INSTALL git node"
  elif command -v apt-get >/dev/null 2>&1; then
    echo "  $PM_INSTALL git nodejs npm"
    echo "  # If apt's nodejs is < 18, use NodeSource:"
    echo "  # curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs"
  else
    echo "  $PM_INSTALL git nodejs npm"
  fi
  echo ""
  echo "Then re-run: ./setup.sh"
  exit 1
fi

echo "✓ git $(git --version | awk '{print $3}')"
echo "✓ node $(node -v) at $(which node)"
echo "✓ npm $(npm -v)"
echo ""

# ── 1. MCP servers ──────────────────────────────────────────

mkdir -p "$CLAUDE_DIR/mcp-servers"

step=1
for mcp in "${MCP_SERVERS[@]}"; do
  echo "[$step/4] Setting up MCP server: $mcp"

  if [ -L "$CLAUDE_DIR/mcp-servers/$mcp" ]; then
    rm "$CLAUDE_DIR/mcp-servers/$mcp"
  elif [ -d "$CLAUDE_DIR/mcp-servers/$mcp" ]; then
    echo "  ⚠ Existing mcp-server directory found. Backing up..."
    mv "$CLAUDE_DIR/mcp-servers/$mcp" "$CLAUDE_DIR/mcp-servers/$mcp.bak.$(date +%s)"
  fi

  ln -s "$REPO_DIR/mcp-servers/$mcp" "$CLAUDE_DIR/mcp-servers/$mcp"
  echo "  Linked: ~/.claude/mcp-servers/$mcp -> repo"

  echo "  Installing npm dependencies..."
  cd "$REPO_DIR/mcp-servers/$mcp"
  if ! npm install; then
    echo "  ✗ npm install failed for $mcp. Is Node.js installed? https://nodejs.org"
    exit 1
  fi
  if ! npm run build; then
    echo "  ✗ Build failed for $mcp. Check errors above."
    exit 1
  fi
  echo "  Built successfully."
  step=$((step + 1))
done

cd "$REPO_DIR"

# ── 2. Skills ────────────────────────────────────────────────

echo "[$step/4] Setting up skills..."
mkdir -p "$CLAUDE_DIR/skills"

for skill in "${SKILLS[@]}"; do
  if [ -L "$CLAUDE_DIR/skills/$skill" ]; then
    rm "$CLAUDE_DIR/skills/$skill"
  elif [ -d "$CLAUDE_DIR/skills/$skill" ]; then
    echo "  ⚠ Existing skill '$skill' found. Backing up..."
    mv "$CLAUDE_DIR/skills/$skill" "$CLAUDE_DIR/skills/$skill.bak.$(date +%s)"
  fi

  ln -s "$REPO_DIR/skills/$skill" "$CLAUDE_DIR/skills/$skill"
  echo "  Linked: ~/.claude/skills/$skill -> repo"
done
step=$((step + 1))

# ── 3. Credentials ───────────────────────────────────────────

echo "[$step/4] Checking credentials..."
needs_attention=0

for mcp in "${MCP_SERVERS[@]}"; do
  env_file="$REPO_DIR/mcp-servers/$mcp/.env"
  env_example="$REPO_DIR/mcp-servers/$mcp/.env.example"

  if [ ! -f "$env_file" ] && [ -f "$env_example" ]; then
    cp "$env_example" "$env_file"
    echo ""
    echo "  !! IMPORTANT: Edit credentials for $mcp:"
    echo "  $env_file"
    case "$mcp" in
      salesforce-futurenergy)
        echo "  Ask Jonas for the SF_CLIENT_ID and SF_CLIENT_SECRET values."
        ;;
      futurerp)
        echo "  Get the Supabase key from:"
        echo "    https://supabase.com/dashboard/project/rczhnuurvcxtkfussmfj/settings/api"
        echo "  Either:"
        echo "    - New secret key (recommended): Publishable and secret API keys → New secret key (sb_secret_*)"
        echo "    - Legacy: Legacy anon, service_role API keys → service_role"
        ;;
    esac
    echo ""
    needs_attention=1
  else
    echo "  $mcp: .env exists. Skipping."
  fi
done
step=$((step + 1))

# ── 4. Claude Desktop / Claude Code config ──────────────────

echo "[$step/4] Claude Desktop / Code configuration..."

NODE_PATH="$(which node 2>/dev/null || true)"
if [ -z "$NODE_PATH" ]; then
  echo "  ✗ Node.js not found in PATH. Install from https://nodejs.org"
  exit 1
fi
echo "  Node.js: $NODE_PATH"

SF_MCP_PATH="$CLAUDE_DIR/mcp-servers/salesforce-futurenergy/dist/index.js"
ERP_MCP_PATH="$CLAUDE_DIR/mcp-servers/futurerp/dist/index.js"

# Candidate config files. ~/.claude.json is Claude Code (cross-platform).
# Claude Desktop's location is OS-specific — we only write there if its
# parent directory already exists (i.e. Claude Desktop is/was installed).
CONFIG_TARGETS=("$HOME/.claude.json")

case "$OSTYPE" in
  darwin*)
    CLAUDE_DESKTOP_DIR="$HOME/Library/Application Support/Claude"
    ;;
  linux*)
    CLAUDE_DESKTOP_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/Claude"
    ;;
  msys*|cygwin*|win32*)
    CLAUDE_DESKTOP_DIR="${APPDATA:-$HOME/AppData/Roaming}/Claude"
    ;;
  *)
    CLAUDE_DESKTOP_DIR=""
    ;;
esac

if [ -n "$CLAUDE_DESKTOP_DIR" ] && [ -d "$CLAUDE_DESKTOP_DIR" ]; then
  CONFIG_TARGETS+=("$CLAUDE_DESKTOP_DIR/claude_desktop_config.json")
  echo "  Found Claude Desktop config dir: $CLAUDE_DESKTOP_DIR"
fi

if ! command -v python3 &>/dev/null; then
  echo "  ⚠ python3 not found — cannot safely merge MCP config."
  echo "  Manually add to mcpServers in your Claude config:"
  echo "    \"salesforce\": { \"command\": \"$NODE_PATH\", \"args\": [\"$SF_MCP_PATH\"] }"
  echo "    \"futurerp\":   { \"command\": \"$NODE_PATH\", \"args\": [\"$ERP_MCP_PATH\"] }"
else
  for target in "${CONFIG_TARGETS[@]}"; do
    python3 - "$target" "$NODE_PATH" "$SF_MCP_PATH" "$ERP_MCP_PATH" <<'PYEOF'
import json, os, sys
config_path, node_path, sf_path, erp_path = sys.argv[1:5]
config = {}
if os.path.exists(config_path):
    try:
        with open(config_path) as f:
            config = json.load(f)
    except json.JSONDecodeError:
        print(f"  ⚠ {config_path} is not valid JSON. Skipping — fix it manually.")
        sys.exit(0)
# Claude Code (~/.claude.json) requires type:stdio; Claude Desktop omits it.
is_claude_code = os.path.basename(config_path) == '.claude.json'
def entry(path):
    e = {'command': node_path, 'args': [path]}
    if is_claude_code:
        e = {'type': 'stdio', **e}
    return e
config.setdefault('mcpServers', {})
config['mcpServers']['salesforce'] = entry(sf_path)
config['mcpServers']['futurerp']   = entry(erp_path)
# Atomic write — preserve everything else in the file.
os.makedirs(os.path.dirname(config_path) or '.', exist_ok=True)
tmp = config_path + '.tmp'
with open(tmp, 'w') as f:
    json.dump(config, f, indent=2)
os.replace(tmp, config_path)
print(f"  Wrote: {config_path}")
PYEOF
  done
fi

# ── Done ──────────────────────────────────────────────────────

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Next steps:"
if [ "$needs_attention" -eq 1 ]; then
  echo "  1. Edit the .env files above with real credentials"
  echo "  2. Restart Claude Desktop (or reconnect MCPs in Claude Code)"
  echo "  3. Test:"
  echo "     Salesforce → 'Dame los KPIs de este mes'"
  echo "     FuturERP   → '¿Cuántos tickets abiertos hay por área?'"
else
  echo "  1. Restart Claude Desktop (or reconnect MCPs in Claude Code)"
  echo "  2. Test:"
  echo "     Salesforce → 'Dame los KPIs de este mes'"
  echo "     FuturERP   → '¿Cuántos tickets abiertos hay por área?'"
fi
echo ""
echo "To update later: git pull && ./setup.sh"
