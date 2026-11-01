#!/usr/bin/env node
// Release metadata for the non-npm channels: the MCP Registry's server.json
// and the Homebrew formula. Copied into the public repo, whose publish.yml
// renders the formula from the release's SHA256SUMS.
//
// Usage: node scripts/release-assets.mjs formula <version> <SHA256SUMS>

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLIC_REPO = "VanLandinghamLabs/arcsync-mcp";
export const SERVER_SCHEMA =
  "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";
export const REGISTRY_DESCRIPTION =
  "Architecture graphs from Terraform, CDK, CloudFormation, Pulumi and ARM, for coding agents";

export const SEA_TARGETS = ["darwin-arm64", "linux-x64", "linux-arm64", "win-x64"];

export function archiveName(version, target) {
  return `arcsync-mcp-${version}-${target}.${target.startsWith("win-") ? "zip" : "tar.gz"}`;
}

export const npmTarballName = (version) => `arcsync-mcp-${version}.tgz`;

export function serverJson(pkg) {
  if (!pkg.mcpName) throw new Error("package.json has no mcpName");
  return {
    $schema: SERVER_SCHEMA,
    name: pkg.mcpName,
    title: "ArcSync",
    description: REGISTRY_DESCRIPTION,
    version: pkg.version,
    websiteUrl: pkg.homepage,
    repository: { url: `https://github.com/${PUBLIC_REPO}`, source: "github" },
    packages: [
      {
        registryType: "npm",
        identifier: pkg.name,
        version: pkg.version,
        transport: { type: "stdio" },
        environmentVariables: [
          {
            name: "ARCSYNC_CLIENT_ID",
            description:
              "MCP credential client ID for CI or shared machines; omit to connect in the browser",
            isRequired: false,
            isSecret: false,
          },
          {
            name: "ARCSYNC_CLIENT_SECRET",
            description: "MCP credential secret, paired with ARCSYNC_CLIENT_ID",
            isRequired: false,
            isSecret: true,
          },
        ],
      },
    ],
  };
}

/** `sha256sum` output as a name → hash map. */
export function parseSums(text) {
  const sums = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const match = /^([0-9a-f]{64}) [ *](\S+)$/.exec(line.trim());
    if (!match) throw new Error(`not a sha256sum line: ${line}`);
    sums[match[2]] = match[1];
  }
  return sums;
}

function shaOf(sums, name) {
  const sha = sums[name];
  if (!sha) throw new Error(`SHA256SUMS has no entry for ${name}`);
  return sha;
}

/**
 * Apple Silicon and Linux get the standalone binary. Node's single-executable
 * support is untested on Intel macOS, so there the formula installs the npm
 * tarball on Homebrew's node instead.
 */
export function homebrewFormula(version, sums) {
  const release = `https://github.com/${PUBLIC_REPO}/releases/download/v${version}`;
  const binary = (target, indent) =>
    [
      `url "${release}/${archiveName(version, target)}"`,
      `sha256 "${shaOf(sums, archiveName(version, target))}"`,
    ]
      .map((line) => `${indent}${line}`)
      .join("\n");
  const npmTarball = npmTarballName(version);
  return `class ArcsyncMcp < Formula
  desc "MCP server giving coding agents ArcSync architecture graphs"
  homepage "https://arcsync.dev/docs/mcp"
  version "${version}"
  license "MIT"

  on_macos do
    on_arm do
${binary("darwin-arm64", "      ")}
    end
    on_intel do
      url "https://registry.npmjs.org/arcsync-mcp/-/${npmTarball}"
      sha256 "${shaOf(sums, npmTarball)}"
      depends_on "node"
    end
  end

  on_linux do
    on_arm do
${binary("linux-arm64", "      ")}
    end
    on_intel do
${binary("linux-x64", "      ")}
    end
  end

  def install
    if OS.mac? && Hardware::CPU.intel?
      system "npm", "install", *std_npm_args
      bin.install_symlink libexec.glob("bin/*")
    else
      bin.install "arcsync-mcp"
    end
  end

  test do
    request = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":' \\
              '{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"brew","version":"0"}}}'
    assert_match '"name":"arcsync"', pipe_output(bin/"arcsync-mcp", "#{request}\\n", 0)
  end
end
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [command, version, sumsPath] = process.argv.slice(2);
  if (command !== "formula" || !version || !sumsPath) {
    console.error("usage: node scripts/release-assets.mjs formula <version> <SHA256SUMS>");
    process.exit(1);
  }
  process.stdout.write(homebrewFormula(version, parseSums(readFileSync(sumsPath, "utf8"))));
}
