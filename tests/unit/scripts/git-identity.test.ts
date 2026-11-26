import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pluginFile } from "../../support/plugin-paths";

/**
 * El dev container no tenía nombre ni correo de git: el `git commit` del
 * worker falló y lo repitió con `-c user.name -c user.email` a mano
 * (truckconnect-mobile #22, 2026-11-27). `~/.gitconfig` no sobrevive a un
 * rebuild, así que la identidad sale de la cuenta de gh.
 */

const SCRIPT = pluginFile("scripts/git-identity.sh");

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

interface Fake {
  /** Lo que responde `gh api user`; sin esto, gh falla. */
  user?: object;
  /** Identidad que ya tiene git. */
  name?: string;
  email?: string;
}

function run(fake: Fake = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "git-identity-"));
  temps.push(dir);
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const log = path.join(dir, "gh.log");
  writeFileSync(log, "");
  writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env bash
echo "gh $*" >> "${log}"
${fake.user ? `echo '${JSON.stringify(fake.user)}'` : 'echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 4'}
`,
  );
  chmodSync(path.join(bin, "gh"), 0o755);
  const gitconfig = path.join(dir, "gitconfig");
  const lines = [
    fake.name || fake.email ? "[user]" : "",
    fake.name ? `\tname = ${fake.name}` : "",
    fake.email ? `\temail = ${fake.email}` : "",
  ];
  writeFileSync(gitconfig, lines.filter(Boolean).join("\n") + "\n");
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    HOME: dir,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  delete env.GIT_AUTHOR_NAME;
  delete env.GIT_AUTHOR_EMAIL;
  delete env.GIT_COMMITTER_NAME;
  delete env.GIT_COMMITTER_EMAIL;
  const r = spawnSync("bash", [SCRIPT], { cwd: dir, encoding: "utf8", env });
  const get = (key: string) =>
    spawnSync("git", ["config", "--global", key], {
      encoding: "utf8",
      env,
    }).stdout.trim();
  return {
    code: r.status,
    out: r.stdout,
    err: r.stderr,
    calls: readFileSync(log, "utf8"),
    name: get("user.name"),
    email: get("user.email"),
  };
}

describe("git-identity.sh", () => {
  it("sin identidad, la toma de la cuenta de gh con su correo público", () => {
    const r = run({
      user: { login: "ana", id: 7, name: "Ana Pérez", email: "ana@x.com" },
    });

    expect(r.code, r.err).toBe(0);
    expect(r.name).toBe("Ana Pérez");
    expect(r.email).toBe("ana@x.com");
    expect(r.out).toContain("ana@x.com");
  });

  it("sin correo público ni nombre, usa el login y el correo noreply de GitHub", () => {
    const r = run({ user: { login: "ana", id: 7, name: null, email: null } });

    expect(r.code, r.err).toBe(0);
    expect(r.name).toBe("ana");
    expect(r.email).toBe("7+ana@users.noreply.github.com");
  });

  it("si git ya tiene identidad, no la toca ni llama a gh", () => {
    const r = run({
      name: "Iván",
      email: "ivan@y.com",
      user: { login: "ana", id: 7, name: "Ana", email: "ana@x.com" },
    });

    expect(r.code, r.err).toBe(0);
    expect(r.name).toBe("Iván");
    expect(r.email).toBe("ivan@y.com");
    expect(r.calls).toBe("");
  });

  it("sin sesión de gh, falla y dice cómo configurarla a mano", () => {
    const r = run();

    expect(r.code).not.toBe(0);
    expect(r.err).toContain("git config --global user.name");
    expect(r.err).toContain("gh auth login");
    expect(r.email).toBe("");
  });
});
