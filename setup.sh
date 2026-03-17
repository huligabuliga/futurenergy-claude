#!/bin/bash
# Future Energy — Claude Config Setup
# Run this once after cloning to install MCP server + skills into ~/.claude/

set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"

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

# ── 1. MCP Server ────────────────────────────────────────────

echo "[1/4] Setting up Salesforce MCP server..."
mkdir -p "$CLAUDE_DIR/mcp-servers"

# Symlink MCP server
if [ -L "$CLAUDE_DIR/mcp-servers/salesforce-futurenergy" ]; then
  rm "$CLAUDE_DIR/mcp-servers/salesforce-futurenergy"
elif [ -d "$CLAUDE_DIR/mcp-servers/salesforce-futurenergy" ]; then
  echo "  ⚠ Existing mcp-server directory found. Backing up..."
  mv "$CLAUDE_DIR/mcp-servers/salesforce-futurenergy" "$CLAUDE_DIR/mcp-servers/salesforce-futurenergy.bak.$(date +%s)"
fi

ln -s "$REPO_DIR/mcp-servers/salesforce-futurenergy" "$CLAUDE_DIR/mcp-servers/salesforce-futurenergy"
echo "  Linked: ~/.claude/mcp-servers/salesforce-futurenergy -> repo"

# Install dependencies & build
echo "  Installing npm dependencies..."
cd "$REPO_DIR/mcp-servers/salesforce-futurenergy"
if ! npm install; then
  echo "  ✗ npm install failed. Is Node.js installed? https://nodejs.org"
  exit 1
fi
if ! npm run build; then
  echo "  ✗ Build failed. Check errors above."
  exit 1
fi
echo "  Built successfully."

# ── 2. Skills ─────────────────────────────────────────────────

echo "[2/4] Setting up skills..."
mkdir -p "$CLAUDE_DIR/skills"

for skill in salesforce-futurenergy; do
  if [ -L "$CLAUDE_DIR/skills/$skill" ]; then
    rm "$CLAUDE_DIR/skills/$skill"
  elif [ -d "$CLAUDE_DIR/skills/$skill" ]; then
    echo "  ⚠ Existing skill '$skill' found. Backing up..."
    mv "$CLAUDE_DIR/skills/$skill" "$CLAUDE_DIR/skills/$skill.bak.$(date +%s)"
  fi

  ln -s "$REPO_DIR/skills/$skill" "$CLAUDE_DIR/skills/$skill"
  echo "  Linked: ~/.claude/skills/$skill -> repo"
done

# ── 3. Credentials ────────────────────────────────────────────

echo "[3/4] Checking credentials..."
ENV_FILE="$REPO_DIR/mcp-servers/salesforce-futurenergy/.env"

if [ ! -f "$ENV_FILE" ]; then
  cp "$REPO_DIR/mcp-servers/salesforce-futurenergy/.env.example" "$ENV_FILE"
  echo ""
  echo "  !! IMPORTANT: Edit the .env file with real credentials:"
  echo "  $ENV_FILE"
  echo ""
  echo "  Ask Jonas for the SF_CLIENT_ID and SF_CLIENT_SECRET values."
  echo ""
else
  echo "  .env file already exists. Skipping."
fi

# ── 4. Claude Desktop config (Mac only) ──────────────────────

echo "[4/4] Claude Desktop configuration..."

# Resolve full path to node (Claude Desktop doesn't inherit terminal PATH)
NODE_PATH="$(which node 2>/dev/null || true)"
if [ -z "$NODE_PATH" ]; then
  echo "  ✗ Node.js not found in PATH. Install from https://nodejs.org"
  exit 1
fi
echo "  Node.js: $NODE_PATH"

if [[ "$OSTYPE" == "darwin"* ]]; then
  CLAUDE_DESKTOP_DIR="$HOME/Library/Application Support/Claude"
  CLAUDE_DESKTOP_CONFIG="$CLAUDE_DESKTOP_DIR/claude_desktop_config.json"
  MCP_PATH="$CLAUDE_DIR/mcp-servers/salesforce-futurenergy/dist/index.js"

  mkdir -p "$CLAUDE_DESKTOP_DIR"

  if [ -f "$CLAUDE_DESKTOP_CONFIG" ]; then
    # Merge into existing config (preserves other MCP servers)
    if command -v python3 &>/dev/null; then
      python3 -c "
import json, sys
with open('$CLAUDE_DESKTOP_CONFIG') as f:
    config = json.load(f)
config.setdefault('mcpServers', {})
config['mcpServers']['salesforce'] = {
    'command': '$NODE_PATH',
    'args': ['$MCP_PATH']
}
with open('$CLAUDE_DESKTOP_CONFIG', 'w') as f:
    json.dump(config, f, indent=2)
print('  Updated: $CLAUDE_DESKTOP_CONFIG')
print('  (existing MCP servers preserved)')
"
    else
      echo "  ⚠ Config exists but python3 not found to merge safely."
      echo "  Manually add this to mcpServers in: $CLAUDE_DESKTOP_CONFIG"
      echo "  \"salesforce\": { \"command\": \"$NODE_PATH\", \"args\": [\"$MCP_PATH\"] }"
    fi
  else
    cat > "$CLAUDE_DESKTOP_CONFIG" << JSONEOF
{
  "mcpServers": {
    "salesforce": {
      "command": "$NODE_PATH",
      "args": [
        "$MCP_PATH"
      ]
    }
  }
}
JSONEOF
    echo "  Created: $CLAUDE_DESKTOP_CONFIG"
  fi
else
  echo "  Not macOS. For Claude Code (CLI), add to ~/.claude.json mcpServers:"
  echo '  "salesforce": {'
  echo '    "type": "stdio",'
  echo "    \"command\": \"$NODE_PATH\","
  echo "    \"args\": [\"$CLAUDE_DIR/mcp-servers/salesforce-futurenergy/dist/index.js\"]"
  echo '  }'
fi

# ── Done ──────────────────────────────────────────────────────

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Next steps:"
echo "  1. Make sure .env has real credentials (if not already)"
echo "  2. Restart Claude Desktop (or reconnect MCP in Claude Code)"
echo "  3. Ask Claude: 'Dame los KPIs de este mes'"
echo ""
echo "To update later, just run: git pull && ./setup.sh"
