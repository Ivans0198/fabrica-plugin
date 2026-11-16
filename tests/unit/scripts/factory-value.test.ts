import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pluginFile } from "../../support/plugin-paths";

const LIB = pluginFile("scripts/lib/factory-config.sh").replace(/\\/g, "/");
const TIMEOUT = 20_000;
const HAS_JQ = spawnSync("bash", ["-c", "command -v jq"]).status === 0;
const READERS = HAS_JQ ? ["node", "jq"] : ["node"];

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function readValue(reader: string, json: string | null, key: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "factory-value-"));
  temps.push(dir);
  if (json !== null) writeFileSync(path.join(dir, "factory.json"), json);
  const result = spawnSync(
    "bash",
    ["-c", `source "${LIB}"; factory_read_value "$1"`, "_", key],
    {
      cwd: dir,
      env: { ...process.env, FACTORY_JSON_READER: reader },
      encoding: "utf8",
    },
  );
  return { code: result.status, out: result.stdout, err: result.stderr };
}

describe.each(READERS)("factory_read_value con %s", (reader) => {
  it(
    "lee un texto de primer nivel",
    () => {
      const r = readValue(
        reader,
        '{"appUrl": "http://localhost:3123"}',
        "appUrl",
      );

      expect(r.code).toBe(0);
      expect(r.out).toBe("http://localhost:3123\n");
    },
    TIMEOUT,
  );

  it(
    "lee un número como texto",
    () => {
      expect(readValue(reader, '{"factoryEpic": 12}', "factoryEpic").out).toBe(
        "12\n",
      );
    },
    TIMEOUT,
  );

  it(
    "no imprime nada cuando falta la clave, el archivo o el valor es null",
    () => {
      expect(readValue(reader, "{}", "appUrl").out).toBe("");
      expect(readValue(reader, '{"appUrl": null}', "appUrl").out).toBe("");
      expect(readValue(reader, null, "appUrl").out).toBe("");
    },
    TIMEOUT,
  );

  it(
    "rechaza listas, objetos, textos vacíos y saltos de línea, y lo dice",
    () => {
      for (const bad of ['["a"]', '{"x": 1}', '""', '"a\\nb"']) {
        const r = readValue(reader, `{"devServer": ${bad}}`, "devServer");
        expect(r.out, bad).toBe("");
        expect(r.err, bad).toMatch(/devServer/);
      }
    },
    TIMEOUT,
  );
});
