import { CORE_ADAPTERS, type ProviderAdapter } from "./providers/adapter.ts";

export const HARNESSES = [
  "claude-code",
  "claude-code-cloud",
  "copilot-cli",
  "codex",
  "other",
] as const;
export type Harness = (typeof HARNESSES)[number];

export const PROJECT_SCOPE =
  "The command line and NODE_OPTIONS cannot be defended from inside the process, so a project-scope harness config is code the developer reviews; register the server at user scope.";

export interface KeyRules {
  /** Entries for `permissions.deny` in the harness's user settings. */
  permissionsDeny?: string[];
  /** Paths for the sandbox's filesystem `denyRead`. */
  sandboxDenyRead?: string[];
  /** Hosts that must not appear in the sandbox's network allowlist. */
  providerHosts?: string[];
}

export interface KeyStep {
  id: string;
  title: string;
  text: string;
  rules?: KeyRules;
}

export interface KeyRecipe {
  harness: Harness;
  steps: KeyStep[];
  limits: string[];
}

export interface KeyDirs {
  configDir?: string;
  stateDir?: string;
}

const REGISTER = "node /abs/path/to/repo/src/cli.ts mcp";
const CHECK_DOCS = "If a command has changed, check the harness's current docs.";
const AGENT_HOLDS_SHELL =
  "The agent holds a shell: these controls stop an over-eager or drifting agent, and text in shared files that tries to steer one, not an agent set on getting round them. The hard money limit is the provider's.";

function providerHosts(adapters: readonly ProviderAdapter[]): string[] {
  return [...new Set(adapters.flatMap((adapter) => adapter.fixedHosts))];
}

/** A Claude Code absolute-path rule pattern: `//` then the path with forward slashes. */
function absolute(dir: string): string {
  return `//${dir.replaceAll("\\", "/").replace(/^\/+/, "")}/**`;
}

function plain(dir: string): string {
  return dir.replaceAll("\\", "/").replace(/\/+$/, "");
}

function claudeCode(dirs: KeyDirs, adapters: readonly ProviderAdapter[]): KeyRecipe {
  const configDir = dirs.configDir ?? "<configDir>";
  const stateDir = dirs.stateDir ?? "<stateDir>";
  const pattern = (dir: string, placeholder: string) =>
    dir === placeholder ? `//${placeholder}/**` : absolute(dir);
  const configPattern = pattern(configDir, "<configDir>");
  const statePattern = pattern(stateDir, "<stateDir>");
  const hosts = providerHosts(adapters);
  return {
    harness: "claude-code",
    steps: [
      {
        id: "claude-code.user-scope",
        title: "Register at user scope with the key in the server's env",
        text: `claude mcp add --scope user --env AI_GATEWAY_API_KEY=<key> assetgrove -- ${REGISTER}. ${CHECK_DOCS}`,
      },
      {
        id: "claude-code.deny-read",
        title: "Deny the agent reads of the harness config, configDir and stateDir",
        text: "In ~/.claude/settings.json add the Read deny rules and the sandbox filesystem denyRead paths, so the agent's tools and its sandboxed shell cannot read the key from ~/.claude.json or the developer's settings and ledger.",
        rules: {
          permissionsDeny: [
            "Read(~/.claude.json)",
            `Read(${configPattern})`,
            `Read(${statePattern})`,
          ],
          sandboxDenyRead: ["~/.claude.json", plain(configDir), plain(stateDir)],
        },
      },
      {
        id: "claude-code.deny-edit",
        title: "Deny the agent edits to configDir and stateDir",
        text: "In ~/.claude/settings.json add the Edit deny rules, so the agent cannot raise its own caps or rewrite the spend ledger.",
        rules: { permissionsDeny: [`Edit(${configPattern})`, `Edit(${statePattern})`] },
      },
      {
        id: "claude-code.no-provider-hosts",
        title: "Keep provider hosts out of the sandbox network allowlist",
        text: `Do not allow ${hosts.join(", ")} in the sandbox's network settings, so a shell the agent starts cannot call a provider with a key. The server runs outside the sandbox.`,
        rules: { providerHosts: hosts },
      },
      {
        id: "claude-code.shell-env",
        title: "Keep the key out of the agent's shell",
        text: "Do not export the key from a shell profile the agent's shell starts with; it lives only in the server's env.",
      },
    ],
    limits: [
      AGENT_HOLDS_SHELL,
      "Deny rules and the sandbox bind the harness's tools and the shell it starts. A shell outside them is not stopped.",
      PROJECT_SCOPE,
    ],
  };
}

type RecipeOf = (dirs: KeyDirs, adapters: readonly ProviderAdapter[]) => KeyRecipe;

const RECIPES: Record<Harness, RecipeOf> = {
  "claude-code": claudeCode,
  "claude-code-cloud": () => ({
    harness: "claude-code-cloud",
    steps: [
      {
        id: "claude-code-cloud.secret-key",
        title: "Supply the key as a secret in the environment's setup",
        text: "The cloud environment's setup supplies AI_GATEWAY_API_KEY as a secret. Keep it out of the checkout and out of any committed file.",
      },
      {
        id: "claude-code-cloud.config-outside-checkout",
        title: "Write settings outside the checkout",
        text: "The setup writes the developer settings to a file outside the checkout and points ASSETGROVE_CONFIG at it. Register the server in the environment's own user-level config; a `.mcp.json` in the checkout is project scope, so review it as code and leave it uncommitted.",
      },
    ],
    limits: [
      AGENT_HOLDS_SHELL,
      "The key is in the session's environment, so the agent's shell can read it. The provider's cap is the limit.",
      PROJECT_SCOPE,
    ],
  }),
  "copilot-cli": () => ({
    harness: "copilot-cli",
    steps: [
      {
        id: "copilot-cli.user-scope",
        title: "Register in ~/.copilot/mcp-config.json with the key in the server's env",
        text: `Add the server to ~/.copilot/mcp-config.json (user scope) with command node, args ["/abs/path/to/repo/src/cli.ts", "mcp"] and env { "AI_GATEWAY_API_KEY": "<key>" }. ${CHECK_DOCS}`,
      },
      {
        id: "copilot-cli.shell-env",
        title: "Keep the key out of the agent's shell",
        text: "Do not export the key from a shell profile the agent's shell starts with.",
      },
    ],
    limits: [
      AGENT_HOLDS_SHELL,
      "The CLI has no read deny for the agent's shell: it can read ~/.copilot/mcp-config.json and configDir, and reach the provider hosts.",
      PROJECT_SCOPE,
    ],
  }),
  codex: () => ({
    harness: "codex",
    steps: [
      {
        id: "codex.user-scope",
        title: "Register in ~/.codex/config.toml with the key in the server's env",
        text: `Add [mcp_servers.assetgrove] to ~/.codex/config.toml with command = "node", args = ["/abs/path/to/repo/src/cli.ts", "mcp"] and env = { AI_GATEWAY_API_KEY = "<key>" }. ${CHECK_DOCS}`,
      },
      {
        id: "codex.shell-sandbox",
        title: "Keep the shell sandboxed with the network off",
        text: "Run Codex with a sandboxed shell and no network access for it, so the shell cannot reach the provider hosts.",
      },
      {
        id: "codex.shell-env-policy",
        title: "Keep key variables out of the shell",
        text: "Set shell_environment_policy so AI_GATEWAY_API_KEY and the other key variables are not passed to the agent's shell.",
      },
    ],
    limits: [
      AGENT_HOLDS_SHELL,
      "The agent's shell may still read ~/.codex/config.toml unless the sandbox hides it, and with the network on it can reach the provider hosts.",
      PROJECT_SCOPE,
    ],
  }),
  other: () => ({
    harness: "other",
    steps: [
      {
        id: "other.user-scope",
        title: "Register at user scope with the key in the server's env",
        text: `Register ${REGISTER} in the harness's user-level config, with AI_GATEWAY_API_KEY in the server's env. ${CHECK_DOCS}`,
      },
      {
        id: "other.shell-env",
        title: "Keep the key out of the agent's shell",
        text: "Do not export the key from a shell profile the agent's shell starts with.",
      },
    ],
    limits: [
      AGENT_HOLDS_SHELL,
      "Whatever the harness does not deny, the agent's shell can read, including the config file that holds the key.",
      PROJECT_SCOPE,
    ],
  }),
};

/** The sentence naming each pack adapter's key variable; empty when no pack adapter has one. */
function packKeys(adapters: readonly ProviderAdapter[]): string {
  const core = new Set(CORE_ADAPTERS.map((adapter) => adapter.id));
  const keys = adapters
    .filter((adapter) => !core.has(adapter.id) && adapter.defaultKeyEnv !== undefined)
    .map((adapter) => `${adapter.defaultKeyEnv} (${adapter.id})`);
  return keys.length === 0
    ? ""
    : ` Each pack adapter's key goes in the server's env the same way: ${keys.join(", ")}.`;
}

export function keyRecipe(
  harness: string,
  dirs: KeyDirs = {},
  adapters: readonly ProviderAdapter[] = CORE_ADAPTERS,
): KeyRecipe {
  if (!(HARNESSES as readonly string[]).includes(harness)) {
    throw new Error(`Unknown harness "${harness}". Use one of: ${HARNESSES.join(", ")}.`);
  }
  const recipe = RECIPES[harness as Harness](dirs, adapters);
  const keys = packKeys(adapters);
  const [first] = recipe.steps;
  if (keys !== "" && first) first.text += keys;
  return recipe;
}
