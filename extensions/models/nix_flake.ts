import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  flakeRef: z.string().describe(
    "Flake reference: a local path (e.g. '/path/to/repo' or '.') or a remote ref (e.g. 'github:owner/repo')",
  ),
});

const FlakeInputSchema = z.object({
  url: z.string(),
  locked: z.object({
    type: z.string(),
    rev: z.string().optional(),
    lastModified: z.number().optional(),
  }).passthrough().optional(),
  original: z.object({
    type: z.string(),
    owner: z.string().optional(),
    repo: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

const MetadataSchema = z.object({
  description: z.string().optional(),
  url: z.string().optional(),
  revision: z.string().optional(),
  lastModified: z.number().optional(),
  inputs: z.record(z.string(), FlakeInputSchema).optional(),
  locks: z.object({}).passthrough().optional(),
}).passthrough();

const OutputsSchema = z.object({}).passthrough();

const BuildResultSchema = z.object({
  outputAttr: z.string(),
  storePaths: z.array(z.string()),
  exitCode: z.number(),
});

const CheckResultSchema = z.object({
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  passed: z.boolean(),
});

const UpdateResultSchema = z.object({
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  updatedAt: z.string(),
});

async function runCommand(
  cmd: string[],
  cwd?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
    cwd,
  });
  const { code, stdout, stderr } = await proc.output();
  return {
    exitCode: code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

function flakeRefCwd(
  flakeRef: string,
): { cwd: string | undefined; ref: string } {
  // If it's a path (starts with / or . or ~), use cwd for the directory
  if (
    flakeRef.startsWith("/") || flakeRef.startsWith(".") ||
    flakeRef.startsWith("~")
  ) {
    const expanded = flakeRef.startsWith("~")
      ? flakeRef.replace("~", Deno.env.get("HOME") ?? "~")
      : flakeRef;
    return { cwd: expanded === "." ? undefined : expanded, ref: "." };
  }
  return { cwd: undefined, ref: flakeRef };
}

export const model = {
  type: "@nickgerace/nix-flake",
  version: "2026.03.09.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    metadata: {
      description: "Flake metadata from `nix flake metadata`",
      schema: MetadataSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    outputs: {
      description: "Flake output tree from `nix flake show`",
      schema: OutputsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    build: {
      description: "Result of `nix build` for a specific output attribute",
      schema: BuildResultSchema,
      lifetime: "7d",
      garbageCollection: 20,
    },
    check: {
      description: "Result of `nix flake check`",
      schema: CheckResultSchema,
      lifetime: "7d",
      garbageCollection: 10,
    },
    update: {
      description: "Result of `nix flake update`",
      schema: UpdateResultSchema,
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  methods: {
    metadata: {
      description:
        "Fetch flake metadata (inputs, revision, last modified) via `nix flake metadata --json`",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { ref, cwd } = flakeRefCwd(context.globalArgs.flakeRef);
        const result = await runCommand(
          ["nix", "flake", "metadata", "--json", ref],
          cwd,
        );
        if (result.exitCode !== 0) {
          throw new Error(
            `nix flake metadata failed (exit ${result.exitCode}):\n${result.stderr}`,
          );
        }
        const data = JSON.parse(result.stdout);
        const handle = await context.writeResource("metadata", "main", data);
        return { dataHandles: [handle] };
      },
    },

    show: {
      description: "Show flake output tree via `nix flake show --json`",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { ref, cwd } = flakeRefCwd(context.globalArgs.flakeRef);
        const result = await runCommand(
          ["nix", "flake", "show", "--json", "--all-systems", ref],
          cwd,
        );
        if (result.exitCode !== 0) {
          throw new Error(
            `nix flake show failed (exit ${result.exitCode}):\n${result.stderr}`,
          );
        }
        const data = JSON.parse(result.stdout);
        const handle = await context.writeResource("outputs", "main", data);
        return { dataHandles: [handle] };
      },
    },

    check: {
      description: "Run `nix flake check` to validate the flake",
      arguments: z.object({
        buildAll: z.boolean().default(false).describe(
          "Pass --build to also build all derivations (slower)",
        ),
      }),
      execute: async (args, context) => {
        const { ref, cwd } = flakeRefCwd(context.globalArgs.flakeRef);
        const cmd = ["nix", "flake", "check"];
        if (args.buildAll) cmd.push("--build");
        cmd.push(ref);

        const result = await runCommand(cmd, cwd);
        const data = {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          passed: result.exitCode === 0,
        };
        const handle = await context.writeResource("check", "main", data);
        return { dataHandles: [handle] };
      },
    },

    update: {
      description: "Update flake.lock via `nix flake update`",
      arguments: z.object({
        inputs: z.array(z.string()).default([]).describe(
          "Specific input names to update (empty = update all)",
        ),
      }),
      execute: async (args, context) => {
        const { ref, cwd } = flakeRefCwd(context.globalArgs.flakeRef);
        const cmd = ["nix", "flake", "update"];
        for (const input of args.inputs) {
          cmd.push(input);
        }
        // For remote refs we can't update in place; only makes sense for paths
        if (ref !== ".") {
          throw new Error(
            "nix flake update only works on local flake paths, not remote refs",
          );
        }

        const result = await runCommand(cmd, cwd);
        if (result.exitCode !== 0) {
          throw new Error(
            `nix flake update failed (exit ${result.exitCode}):\n${result.stderr}`,
          );
        }
        const data = {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          updatedAt: new Date().toISOString(),
        };
        const handle = await context.writeResource("update", "main", data);
        return { dataHandles: [handle] };
      },
    },

    build: {
      description: "Build a flake output attribute via `nix build`",
      arguments: z.object({
        outputAttr: z.string().describe(
          "Output attribute to build, e.g. 'packages.x86_64-linux.default' or just 'default'",
        ),
        noLink: z.boolean().default(true).describe(
          "Pass --no-link to avoid creating a result symlink",
        ),
        printBuildLogs: z.boolean().default(false).describe(
          "Pass -L to print build logs",
        ),
      }),
      execute: async (args, context) => {
        const { ref, cwd } = flakeRefCwd(context.globalArgs.flakeRef);
        const target = ref === "."
          ? `.#${args.outputAttr}`
          : `${ref}#${args.outputAttr}`;

        const cmd = ["nix", "build", target, "--json"];
        if (args.noLink) cmd.push("--no-link");
        if (args.printBuildLogs) cmd.push("-L");

        const result = await runCommand(cmd, cwd);
        if (result.exitCode !== 0) {
          throw new Error(
            `nix build failed (exit ${result.exitCode}):\n${result.stderr}`,
          );
        }

        let storePaths: string[] = [];
        try {
          const buildOutput = JSON.parse(result.stdout);
          storePaths = buildOutput.flatMap(
            (o: { outputs?: Record<string, string> }) =>
              Object.values(o.outputs ?? {}),
          );
        } catch {
          // stdout may be empty when --no-link is used with some nix versions
        }

        const data = {
          outputAttr: args.outputAttr,
          storePaths,
          exitCode: result.exitCode,
        };
        const instanceName = args.outputAttr.replace(/[^a-zA-Z0-9_-]/g, "_");
        const handle = await context.writeResource("build", instanceName, data);
        return { dataHandles: [handle] };
      },
    },
  },
};
