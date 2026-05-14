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

if ! command -v node &>/dev/null; then
  echo "✗ Node.js not found. Install from https://nodejs.org (LTS version)"
  exit 1
fi

if ! command -v npm &>/dev/null; then
  echo "✗ npm not found. Install Node.js from https://nodejs.org (includes npm)"
  exit 1
fi

echo "Node.js: $(node --version) at $(which node)"
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

if [[ "$OSTYPE" == "darwin"* ]]; then
  CLAUDE_DESKTOP_DIR="$HOME/Library/Application Support/Claude"
  CLAUDE_DESKTOP_CONFIG="$CLAUDE_DESKTOP_DIR/claude_desktop_config.json"
  mkdir -p "$CLAUDE_DESKTOP_DIR"
  CONFIG_TARGETS=("$CLAUDE_DESKTOP_CONFIG")
else
  CONFIG_TARGETS=()
fi

# Claude Code (Linux + macOS) keeps MCP config in ~/.claude.json
if [ -f "$HOME/.claude.json" ] || [ ! -f "${CONFIG_TARGETS[0]:-/nonexistent}" ]; then
  CONFIG_TARGETS+=("$HOME/.claude.json")
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
# Claude Code's ~/.claude.json uses type:stdio; Claude Desktop omits the type field.
is_claude_code = config_path.endswith('.claude.json')
entry_sf  = {'type': 'stdio', 'command': node_path, 'args': [sf_path]}  if is_claude_code else {'command': node_path, 'args': [sf_path]}
entry_erp = {'type': 'stdio', 'command': node_path, 'args': [erp_path]} if is_claude_code else {'command': node_path, 'args': [erp_path]}
config.setdefault('mcpServers', {})
config['mcpServers']['salesforce'] = entry_sf
config['mcpServers']['futurerp']   = entry_erp
# Atomic write — preserve everything else in the file.
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
