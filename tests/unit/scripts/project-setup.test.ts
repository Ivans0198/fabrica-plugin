import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
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
 * Las reglas mandan las tarjetas a Blocked, pero un Project nuevo solo trae
 * Todo, In Progress y Done, y project-setup.sh no la creaba
 * (truckconnect-mobile, 2026-11-26). Al crearla, GitHub cambia los IDs de
 * todas las opciones y los workflows del Project quedan en "A value is
 * required": hay que decirlo.
 */

const SCRIPT = pluginFile("scripts/project-setup.sh");

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

type Option = { id: string; name: string; color: string; description: string };

const BASE: Option[] = [
  { id: "o1", name: "Todo", color: "GRAY", description: "" },
  { id: "o2", name: "In Progress", color: "YELLOW", description: "" },
  { id: "o3", name: "Done", color: "GREEN", description: "Hecho" },
];

/** Un gh falso: devuelve el Project con sus opciones y anota cada mutación. */
function fakeGh(dir: string, options: Option[]): string {
  const bin = path.join(dir, ".bin");
  mkdirSync(bin);
  const state = path.join(dir, "options.json");
  writeFileSync(state, JSON.stringify(options));
  const project = (opts: string) =>
    `{"data":{"user":{"projectV2":{"id":"P1","title":"demo","fields":{"nodes":[{"id":"F1","name":"Status","options":${opts}}]}}}}}`;
  const gh = path.join(bin, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
if [ "$1" = auth ]; then echo "Token scopes: 'gist', 'project', 'repo'"; exit 0; fi
args="$*"
if [[ "$args" == *updateProjectV2Field* ]]; then
  echo "$args" >> "${dir}/mutations.log"
  # La mutación reemplaza las opciones: todas con ID nuevo.
  jq -c '[.[] | .id = ("n" + .id)] + [{"id":"nB","name":"Blocked","color":"RED","description":""}]' "${state}" > "${state}.new"
  mv "${state}.new" "${state}"
  echo '{"data":{}}'
  exit 0
fi
echo '${project("__OPTS__")}' | sed "s|__OPTS__|$(cat "${state}")|"
`,
  );
  chmodSync(gh, 0o755);
  return bin;
}

function run(options: Option[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "project-setup-"));
  temps.push(dir);
  const bin = fakeGh(dir, options);
  const result = spawnSync("bash", [SCRIPT, "demo-owner", "7"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  const log = path.join(dir, "mutations.log");
  return {
    code: result.status,
    out: result.stdout,
    err: result.stderr,
    mutations: existsSync(log) ? readFileSync(log, "utf8") : "",
    cached: existsSync(path.join(dir, ".plan/project.json"))
      ? (JSON.parse(
          readFileSync(path.join(dir, ".plan/project.json"), "utf8"),
        ) as { statusOptions: Record<string, string> })
      : null,
  };
}

describe("project-setup.sh", () => {
  it("sin Blocked, la crea conservando las otras opciones, y guarda los IDs nuevos", () => {
    const r = run(BASE);

    expect(r.code, r.err).toBe(0);
    expect(r.mutations).toContain('name:"Todo",color:GRAY');
    expect(r.mutations).toContain(
      'name:"Done",color:GREEN,description:"Hecho"',
    );
    expect(r.mutations).toContain('name:"Blocked",color:RED');
    expect(r.cached?.statusOptions).toEqual({
      Todo: "no1",
      "In Progress": "no2",
      Done: "no3",
      Blocked: "nB",
    });
  });

  it("al crearla avisa que hay que volver a elegir el valor de los workflows", () => {
    const r = run(BASE);

    expect(r.out).toContain("A value is required");
  });

  it("con Blocked ya creada no toca el campo", () => {
    const r = run([
      ...BASE,
      { id: "o4", name: "Blocked", color: "RED", description: "" },
    ]);

    expect(r.code, r.err).toBe(0);
    expect(r.mutations).toBe("");
    expect(r.cached?.statusOptions.Blocked).toBe("o4");
  });

  it("indica el botón Workflows, no un engranaje", () => {
    const r = run(BASE);

    expect(r.out).toContain("Workflows");
    expect(r.out).not.toContain("⚙");
  });
});
