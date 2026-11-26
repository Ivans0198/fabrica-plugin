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
 * El e2e nativo de la CI, dentro del emulador. En truckconnect-mobile #16 la
 * app se caía al arrancar en Hermes (MessageEvent, después BroadcastChannel)
 * y nada del gate lo veía: jest corre en Node y `expo export` compila sin
 * correr el bundle. El worker iteró a ciegas dos veces (2026-11-26).
 *
 * La app se compila antes, fuera del emulador: las dos cosas juntas dejaron
 * al runner sin recursos y GitHub lo apagó en plena compilación (PR #21 de
 * truckconnect-mobile, 2026-11-26). Dentro del emulador, el script instala
 * el APK, levanta el servidor de desarrollo, espera a que responda y corre
 * los flows.
 */

const SCRIPT = pluginFile("scripts/android-e2e.sh");

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

interface Fake {
  install?: number;
  noApk?: boolean;
  e2e?: number;
  /** El servidor se muere al arrancar. */
  serverDies?: boolean;
  /** Intentos de curl que fallan antes de que el servidor responda. */
  slowStatus?: number;
}

function run(fake: Fake = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "android-e2e-"));
  temps.push(dir);
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const log = path.join(dir, "calls.log");
  writeFileSync(log, "");
  const script = (body: string) => `#!/usr/bin/env bash\n${body}\n`;
  writeFileSync(
    path.join(bin, "fabrica-cmd"),
    script(`echo "fabrica-cmd $1" >> "${log}"
case "$1" in
  androidServe)
    echo "metro arrancando"
    ${fake.serverDies ? 'echo "Error: puerto ocupado"; exit 1' : 'trap "echo server-killed >> ' + log + '; exit 0" TERM; while :; do sleep 0.1; done'} ;;
  androidE2e) exit ${fake.e2e ?? 0} ;;
esac`),
  );
  writeFileSync(
    path.join(bin, "curl"),
    script(`n=$(cat "${log}.curl" 2>/dev/null || echo 0); echo $((n + 1)) > "${log}.curl"
[ "$n" -ge ${fake.slowStatus ?? 0} ] || exit 7
echo "packager-status:running"`),
  );
  writeFileSync(
    path.join(bin, "adb"),
    script(
      `echo "adb $*" >> "${log}"
[ "$1" = logcat ] && echo "logcat de mentira"
[ "$1" = install ] && exit ${fake.install ?? 0}
exit 0`,
    ),
  );
  for (const f of ["fabrica-cmd", "curl", "adb"])
    chmodSync(path.join(bin, f), 0o755);
  const logs = path.join(dir, "logs");
  const apk = path.join(dir, "app-debug.apk");
  if (!fake.noApk) writeFileSync(apk, "apk");
  const r = spawnSync("bash", [SCRIPT, apk, logs], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FABRICA_ANDROID_SERVER_WAIT: "3",
      FABRICA_ANDROID_POLL: "0.1",
    },
    timeout: 15_000,
  });
  return {
    code: r.status,
    out: r.stdout,
    err: r.stderr,
    calls: readFileSync(log, "utf8"),
    logs,
  };
}

describe("android-e2e.sh", () => {
  it("instala el APK, levanta el servidor, espera a que responda y corre los flows", () => {
    const r = run({ slowStatus: 2 });

    expect(r.code, r.err).toBe(0);
    const calls = r.calls.split("\n");
    const at = (c: string) => calls.findIndex((l) => l.startsWith(c));
    expect(at("adb install -r ")).toBeGreaterThan(-1);
    expect(r.calls).toMatch(/adb install -r .*app-debug\.apk/);
    expect(at("fabrica-cmd androidServe")).toBeGreaterThan(
      at("adb install -r "),
    );
    expect(at("fabrica-cmd androidE2e")).toBeGreaterThan(
      at("fabrica-cmd androidServe"),
    );
    // El servidor no queda vivo, y el logcat queda para el artefacto.
    expect(r.calls).toContain("server-killed");
    expect(readFileSync(path.join(r.logs, "server.log"), "utf8")).toContain(
      "metro arrancando",
    );
    expect(readFileSync(path.join(r.logs, "logcat.txt"), "utf8")).toContain(
      "logcat de mentira",
    );
  });

  it("sale con el código de los flows si fallan", () => {
    const r = run({ e2e: 3 });

    expect(r.code).toBe(3);
    expect(r.calls).toContain("server-killed");
    expect(existsSync(path.join(r.logs, "logcat.txt"))).toBe(true);
  });

  it("si la instalación falla, no levanta nada", () => {
    const r = run({ install: 1 });

    expect(r.code).not.toBe(0);
    expect(r.calls).not.toContain("androidServe");
    expect(r.calls).not.toContain("androidE2e");
  });

  it("sin el APK, dice dónde lo buscó y no levanta nada", () => {
    const r = run({ noApk: true });

    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/app-debug\.apk/);
    expect(r.err).toMatch(/androidApk/);
    expect(r.calls).not.toContain("adb install");
  });

  it("si el servidor se muere, lo dice con su log y no corre los flows", () => {
    const r = run({ serverDies: true, slowStatus: 99 });

    expect(r.code).not.toBe(0);
    expect(r.calls).not.toContain("androidE2e");
    expect(r.err).toContain("puerto ocupado");
  });

  it("si el servidor no responde a tiempo, falla sin correr los flows", () => {
    const r = run({ slowStatus: 9999 });

    expect(r.code).not.toBe(0);
    expect(r.calls).not.toContain("androidE2e");
    expect(r.err).toMatch(/no respondió/);
    expect(r.calls).toContain("server-killed");
  });
});
