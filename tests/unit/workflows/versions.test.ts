import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PLUGIN_ROOT, REPO_ROOT } from "../../support/plugin-paths";

/**
 * Las actions de terceros corren en los jobs que tienen los secretos: un tag
 * se puede mover, un SHA no. Y Node 20 dejó de tener soporte en abril de
 * 2026 (revisión del 2026-11-23).
 */

const NODE_MAJOR = 24;

const WORKFLOW_DIRS = [
  path.join(REPO_ROOT, ".github/workflows"),
  path.join(PLUGIN_ROOT, "templates/.github/workflows"),
];

const workflows = WORKFLOW_DIRS.flatMap((dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".yml"))
    .map((f) => ({
      file: path.relative(REPO_ROOT, path.join(dir, f)),
      text: readFileSync(path.join(dir, f), "utf8"),
    })),
);

/** Las líneas `uses:` de actions de terceros: ni las locales ni las del plugin. */
function thirdPartyUses(): { file: string; line: string }[] {
  return workflows.flatMap(({ file, text }) =>
    text
      .split("\n")
      .filter((line) => /^\s*(-\s+)?uses:\s/.test(line))
      .filter((line) => !/uses:\s+(\.\/|__FABRICA_REPO__)/.test(line))
      .map((line) => ({ file, line: line.trim() })),
  );
}

describe("versiones de los workflows", () => {
  it("cada action de terceros va fijada por SHA, con su versión en un comentario", () => {
    const uses = thirdPartyUses();

    expect(uses.length).toBeGreaterThan(0);
    for (const { file, line } of uses) {
      expect(line, file).toMatch(/@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    }
  });

  it("la misma action va en el mismo SHA en todos los workflows", () => {
    const shas = new Map<string, Set<string>>();
    for (const { line } of thirdPartyUses()) {
      const [, action, sha] = /uses:\s+([^@]+)@(\S+)/.exec(line)!;
      shas.set(action, (shas.get(action) ?? new Set()).add(sha));
    }

    for (const [action, set] of shas) {
      expect([...set], action).toHaveLength(1);
    }
  });

  it(`los workflows usan Node ${NODE_MAJOR}, igual que el dev container`, () => {
    const versions = workflows.flatMap(({ text }) =>
      [...text.matchAll(/node-version:\s*["']?(\d+)/g)].map((m) =>
        Number(m[1]),
      ),
    );
    const dockerfile = readFileSync(
      path.join(PLUGIN_ROOT, "templates/.devcontainer/Dockerfile"),
      "utf8",
    );

    expect(versions.length).toBeGreaterThan(0);
    expect(new Set(versions)).toEqual(new Set([NODE_MAJOR]));
    expect(dockerfile).toMatch(new RegExp(`^FROM node:${NODE_MAJOR}-`, "m"));
  });

  // setup-node v5 en adelante cachea solo si package.json trae
  // packageManager; un caché escrito desde la rama de un PR lo leen después
  // los jobs con secretos.
  it("los workflows de los proyectos no usan el caché automático de setup-node", () => {
    for (const { file, text } of workflows) {
      if (file.endsWith("kit.yml")) continue;
      const blocks = text
        .split(/\n(?=\s*-\s)/)
        .filter((b) => b.includes("actions/setup-node@"));
      for (const block of blocks) {
        expect(block, file).toMatch(/package-manager-cache:\s*false/);
      }
    }
  });

  it("el dev container instala una versión fija de Claude Code", () => {
    const dockerfile = readFileSync(
      path.join(PLUGIN_ROOT, "templates/.devcontainer/Dockerfile"),
      "utf8",
    );

    expect(dockerfile).toMatch(/ARG CLAUDE_CODE_VERSION=\d+\.\d+\.\d+/);
    expect(dockerfile).toContain(
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}",
    );
  });
});
