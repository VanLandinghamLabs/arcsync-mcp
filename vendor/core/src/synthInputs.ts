/**
 * What a user may hand `cdk synth` beyond the repo's own `cdk.json` (#2008):
 * context passed as `--context key=value` argv, and environment variables
 * added under everything the sandbox sets itself. Backend admission, the
 * sandbox router, the builder broker and the SPA's form all validate with
 * this module, so the limits are stated once.
 *
 * Design: docs/superpowers/specs/2026-10-15-cdk-synth-context-design.md
 */

export interface SynthInputs {
  context: Record<string, string>;
  env: Record<string, string>;
}

export const SYNTH_LIMITS = {
  maxContextEntries: 32,
  maxEnvEntries: 16,
  maxContextKeyLength: 128,
  maxEnvNameLength: 64,
  maxValueLength: 1024,
  maxRepoFileBytes: 64 * 1024,
} as const;

/** The repo config file, read from the directory holding `cdk.json`. */
export const REPO_SYNTH_CONFIG_FILE = ".arcsync.json";

// No leading `-`, so the `key=value` argv token can never read as a flag, and
// no `=`, which the CDK CLI splits on.
const CONTEXT_KEY_RE = /^[A-Za-z0-9_@][A-Za-z0-9_.:/@-]*$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * Env names are allowed by shape (`ENV_NAME_RE`, UPPER_SNAKE_CASE) minus this
 * reserved list: the shell and process basics, the dynamic loader, and every
 * variable a toolchain in the sandbox reads for its own configuration or to
 * load code (profilers, compilers, interpreters). Defence in depth — the
 * builders merge user env underneath their own, so a name the Lambda already
 * defines is never replaced either way.
 */
export const RESERVED_ENV_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "OLDPWD",
  "TMPDIR",
  "TMP",
  "TEMP",
  "IFS",
  "CDPATH",
  "PS1",
  "PS4",
  "PROMPT_COMMAND",
  "SHELLOPTS",
  "TZ",
  "TERM",
  "LANG",
  "LANGUAGE",
  "HOSTNAME",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "FTP_PROXY",
  "CLASSPATH",
  "VIRTUAL_ENV",
  "REQUESTS_CA_BUNDLE",
  "GOPATH",
  "GOROOT",
  "GOBIN",
  "GOFLAGS",
  "GOPROXY",
  "GOPRIVATE",
  "GONOPROXY",
  "GONOSUMDB",
  "GONOSUMCHECK",
  "GOSUMDB",
  "GOINSECURE",
  "GOTOOLCHAIN",
  "GOCACHE",
  "GOMODCACHE",
  "GOENV",
  "GOOS",
  "GOARCH",
  "GOTMPDIR",
  "GODEBUG",
  "GOEXPERIMENT",
  "GOWORK",
  "LOCPATH",
  "NLSPATH",
  "HOSTALIASES",
  "RES_OPTIONS",
  "LOCALDOMAIN",
  "TERMINFO",
  "CC",
  "CXX",
  "CPP",
  "LD",
  "AR",
  "CFLAGS",
  "CPPFLAGS",
  "CXXFLAGS",
  "LDFLAGS",
  "LIBS",
  "MAKEFLAGS",
  "PKG_CONFIG_PATH",
]);

export const RESERVED_ENV_PREFIXES: readonly string[] = [
  "AWS_",
  "AMAZON_",
  "_X_AMZN",
  "LAMBDA_",
  "ECS_",
  "CDK_",
  "JSII_",
  "NODE_",
  "NPM_",
  "YARN_",
  "PNPM_",
  "COREPACK_",
  "TS_NODE_",
  "LD_",
  "DYLD_",
  "BASH_",
  "PYTHON",
  "PIP_",
  "UV_",
  "JAVA_",
  "JDK_",
  "MAVEN_",
  "M2_",
  "GRADLE_",
  "CGO_",
  "DOTNET_",
  "NUGET_",
  "MSBUILD",
  "COREHOST_",
  "PULUMI_",
  "XDG_",
  "GIT_",
  "SSH_",
  "GPG_",
  "GNUPG",
  "SSL_",
  "OPENSSL_",
  "CURL_",
  "DOCKER_",
  "LC_",
  "ARCSYNC_",
  "SANDBOX_",
  "GCONV_",
  "GLIBC_",
  "MALLOC_",
  "CORECLR_",
  "PERL5",
  "PERL_",
  "RUBY",
  "GEM_",
  "BUNDLE_",
  "CARGO_",
  "RUST",
  "ESBUILD_",
  "SWC_",
  "BABEL_",
  "TSX_",
];

export function isReservedEnvName(name: string): boolean {
  return RESERVED_ENV_NAMES.has(name) || RESERVED_ENV_PREFIXES.some((p) => name.startsWith(p));
}

export type SynthInputsResult = { ok: true; value: SynthInputs } | { ok: false; error: string };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Why a context key is refused, or null when it is fine. */
export function contextKeyError(key: string): string | null {
  if (key.length === 0) return "a context key is empty";
  if (key.length > SYNTH_LIMITS.maxContextKeyLength) {
    return `context key "${key.slice(0, 32)}…" is longer than ${SYNTH_LIMITS.maxContextKeyLength} characters`;
  }
  if (!CONTEXT_KEY_RE.test(key)) {
    return `context key "${key}" may contain only letters, digits and _ . : / @ - (and may not start with -)`;
  }
  // Assigning it to a plain object would set the prototype, not a key.
  if (key === "__proto__") return `context key "${key}" is not allowed`;
  if (key.toLowerCase().startsWith("aws:")) {
    return `context key "${key}" uses the reserved aws: prefix`;
  }
  return null;
}

/** Why an env name is refused, or null when it is fine. */
export function envNameError(name: string): string | null {
  if (name.length === 0) return "an environment variable name is empty";
  if (name.length > SYNTH_LIMITS.maxEnvNameLength) {
    return `environment variable "${name.slice(0, 32)}…" is longer than ${SYNTH_LIMITS.maxEnvNameLength} characters`;
  }
  if (!ENV_NAME_RE.test(name)) {
    return `environment variable "${name}" must be UPPER_SNAKE_CASE (A-Z, 0-9, _)`;
  }
  if (isReservedEnvName(name)) {
    return `environment variable "${name}" is reserved by the build sandbox`;
  }
  return null;
}

/** Why a value is refused, or null when it is fine. */
export function synthValueError(label: string, value: string): string | null {
  if (value.length > SYNTH_LIMITS.maxValueLength) {
    return `the value of "${label}" is longer than ${SYNTH_LIMITS.maxValueLength} characters`;
  }
  if (CONTROL_RE.test(value)) return `the value of "${label}" contains a control character`;
  return null;
}

function readMap(
  raw: unknown,
  what: "context" | "env",
  coerceScalars: boolean,
): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (!isPlainObject(raw)) return { ok: false, error: `${what} must be an object` };
  const entries = Object.entries(raw);
  const max = what === "context" ? SYNTH_LIMITS.maxContextEntries : SYNTH_LIMITS.maxEnvEntries;
  if (entries.length > max) return { ok: false, error: `at most ${max} ${what} entries` };
  const out: Record<string, string> = {};
  for (const [key, rawValue] of entries) {
    const keyError = what === "context" ? contextKeyError(key) : envNameError(key);
    if (keyError) return { ok: false, error: keyError };
    let value: string;
    if (typeof rawValue === "string") value = rawValue;
    else if (coerceScalars && (typeof rawValue === "number" || typeof rawValue === "boolean")) {
      value = String(rawValue);
    } else {
      return { ok: false, error: `the value of "${key}" must be a string` };
    }
    const valueError = synthValueError(key, value);
    if (valueError) return { ok: false, error: valueError };
    out[key] = value;
  }
  return { ok: true, value: out };
}

function sorted(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(map).sort()) out[key] = map[key];
  return out;
}

function parseInputs(raw: unknown, coerceScalars: boolean): SynthInputsResult {
  if (!isPlainObject(raw)) return { ok: false, error: "synth inputs must be an object" };
  for (const key of Object.keys(raw)) {
    if (key !== "context" && key !== "env") {
      return { ok: false, error: `unknown synth input field "${key}"` };
    }
  }
  const context = readMap(raw.context, "context", coerceScalars);
  if (!context.ok) return context;
  const env = readMap(raw.env, "env", coerceScalars);
  if (!env.ok) return env;
  return { ok: true, value: { context: sorted(context.value), env: sorted(env.value) } };
}

/**
 * Validate per-diagram synth inputs from a request or an event. Strings only.
 * The result has its keys sorted, so equal inputs serialize identically.
 */
export function parseSynthInputs(raw: unknown): SynthInputsResult {
  return parseInputs(raw, false);
}

export function isEmptySynthInputs(inputs: SynthInputs | undefined | null): boolean {
  return (
    !inputs || (Object.keys(inputs.context).length === 0 && Object.keys(inputs.env).length === 0)
  );
}

/**
 * Parse `.arcsync.json`. The synth block lives under `synth` so the file can
 * carry other settings later; a file without one yields empty inputs. Scalar
 * values are stringified, as `cdk.json` context often holds booleans.
 */
export function parseRepoSynthConfig(text: string): SynthInputsResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: `${REPO_SYNTH_CONFIG_FILE} is not valid JSON` };
  }
  if (!isPlainObject(json)) {
    return { ok: false, error: `${REPO_SYNTH_CONFIG_FILE} must hold a JSON object` };
  }
  if (json.synth === undefined) return { ok: true, value: { context: {}, env: {} } };
  const parsed = parseInputs(json.synth, true);
  if (!parsed.ok) return { ok: false, error: `${REPO_SYNTH_CONFIG_FILE}: ${parsed.error}` };
  return parsed;
}

/** Per-diagram settings win over the repo file, key by key. */
export function mergeSynthInputs(
  fromRepo: SynthInputs | undefined,
  fromDiagram: SynthInputs | undefined,
): SynthInputs {
  return {
    context: sorted({ ...fromRepo?.context, ...fromDiagram?.context }),
    env: sorted({ ...fromRepo?.env, ...fromDiagram?.env }),
  };
}

/** `--context key=value` pairs for the CDK CLI, one argv entry each, no shell. */
export function cdkContextArgv(context: Record<string, string>): string[] {
  return Object.keys(context)
    .sort()
    .flatMap((key) => ["--context", `${key}=${context[key]}`]);
}

/**
 * Why a context key cannot be a Pulumi config key, or null when it can. A
 * Pulumi run applies context as config in the project's own namespace only,
 * the values the program itself reads: `namespace:name` keys would configure
 * a provider (`gcp:credentials`, `kubernetes:kubeconfig`), and synth settings
 * come from whoever owns the diagram, not from the repository.
 */
export function pulumiConfigKeyError(key: string): string | null {
  if (key.includes(":")) {
    return `context key "${key}" has a namespace; Pulumi runs set config in the project's own namespace only`;
  }
  return null;
}

/**
 * `pulumi config set-all` argv, plaintext values, one `--plaintext=key=value`
 * token each, no shell. The `=` after the flag name keeps a value that starts
 * with `-` from reading as a flag, and Pulumi splits each pair at its first
 * `=`, which a context key never contains.
 */
export function pulumiConfigArgv(context: Record<string, string>): string[] {
  const keys = Object.keys(context).sort();
  if (keys.length === 0) return [];
  return ["config", "set-all", ...keys.map((key) => `--plaintext=${key}=${context[key]}`)];
}
