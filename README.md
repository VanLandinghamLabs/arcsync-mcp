# arcsync-mcp

An [MCP](https://modelcontextprotocol.io) server that gives coding agents (Claude Code, Cursor, GitHub Copilot and other MCP clients) the architecture graph [ArcSync](https://arcsync.dev) parsed from your infrastructure-as-code: Terraform, AWS CDK, CloudFormation, Pulumi, Azure ARM and Serverless Framework.

Tools: `list_diagrams`, `get_diagram` (Mermaid or JSON, plus a canvas link), `describe_resource`, `get_delta`, `list_versions`, `start_parse`, `get_parse_status`. For diagrams the agent writes itself: `validate_diagram` (local check), `push_diagram` (store it and get canvas and Notion embed links), `get_diagram_source`, `list_icons`.

## Setup

Add to `.mcp.json` (no credential in it, so it is safe to commit):

```json
{
  "mcpServers": {
    "arcsync": {
      "command": "npx",
      "args": ["-y", "arcsync-mcp"]
    }
  }
}
```

The first tool call returns a link to `https://arcsync.dev/settings/mcp/connect`. Open it, sign in, and click **Connect**: ArcSync mints an MCP credential and hands it to the server over `127.0.0.1`, which saves it to `~/.config/arcsync/mcp-credential.json` (mode 0600) and uses it from the next call. From a terminal, `npx -y arcsync-mcp login` does the same; `npx -y arcsync-mcp logout` deletes the saved file.

For CI or a shared machine, create an MCP credential at https://arcsync.dev/settings instead and pass `ARCSYNC_CLIENT_ID` and `ARCSYNC_CLIENT_SECRET` in the server's environment; they take precedence over a saved credential.

Two agent skills ship in `skills/`: `arcsync-mcp` tells an agent when to call each graph tool, and `arcsync-diagrams` teaches it to write, validate and push its own diagrams. For Claude Code, install both:

```bash
npm pack arcsync-mcp && tar -xzf arcsync-mcp-*.tgz package/skills
mkdir -p .claude/skills/arcsync-mcp .claude/skills/arcsync-diagrams
cp package/skills/arcsync-mcp/SKILL.md .claude/skills/arcsync-mcp/
cp package/skills/arcsync-diagrams/SKILL.md .claude/skills/arcsync-diagrams/
rm -rf package arcsync-mcp-*.tgz
```

Full guide: https://arcsync.dev/docs/mcp

## Source and development

This repository is mirrored from the ArcSync monorepo on each release, together with the ArcSync core modules the server uses (`vendor/core/`). Releases are published to npm from here with [provenance](https://docs.npmjs.com/generating-provenance-statements), so `npm view arcsync-mcp --json` links each version to the commit and workflow run that built it. Issues and pull requests are welcome; accepted changes are ported to the monorepo and ship in the next release.

```bash
npm ci
npm test
npm run build            # dist/index.js, one self-contained file
npm run eval:diagrams    # arcsync-diagrams skill evals; after build, costs model calls
```

## License

MIT
