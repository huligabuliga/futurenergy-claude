#!/bin/bash
# Future Energy — Claude Config Setup
# Run this once after cloning to install MCP server + skills into ~/.claude/

set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"

echo "=== Future Energy Claude Setup ==="
echo "Repo: $REPO_DIR"
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
npm install --silent 2>/dev/null
npm run build 2>/dev/null
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

if [[ "$OSTYPE" == "darwin"* ]]; then
  CLAUDE_DESKTOP_DIR="$HOME/Library/Application Support/Claude"
  CLAUDE_DESKTOP_CONFIG="$CLAUDE_DESKTOP_DIR/claude_desktop_config.json"
  MCP_PATH="$CLAUDE_DIR/mcp-servers/salesforce-futurenergy/dist/index.js"

  mkdir -p "$CLAUDE_DESKTOP_DIR"

  if [ -f "$CLAUDE_DESKTOP_CONFIG" ]; then
    echo "  Config file exists: $CLAUDE_DESKTOP_CONFIG"
    echo "  Please verify it contains the salesforce MCP server entry."
  else
    cat > "$CLAUDE_DESKTOP_CONFIG" << JSONEOF
{
  "mcpServers": {
    "salesforce": {
      "command": "node",
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
  echo '    "command": "node",'
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
