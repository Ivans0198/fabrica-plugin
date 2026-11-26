import { readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, TEMPLATES_ROOT } from "../../support/plugin-paths";

/**
 * El e2e nativo en un emulador de Android, en cada PR de un proyecto con
 * flows de Maestro. En truckconnect-mobile #16 la app se caía al arrancar en
 * Hermes y ningún check lo veía; el worker iteró a ciegas dos veces
 * (2026-11-26).
 */

const WORKFLOW = path.join(REPO_ROOT, ".github/workflows/android-e2e.yml");
const CALLER = path.join(TEMPLATES_ROOT, ".github/workflows/android-e2e.yml");

interface Step {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string | boolean | number>;
  env?: Record<string, string>;
}

interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress"?: boolean };
  jobs: Record<
    string,
    { "timeout-minutes"?: number; steps: Step[]; permissions?: object }
  >;
}

const parse = (file: string) => load(readFileSync(file, "utf8")) as Workflow;
const steps = () => Object.values(parse(WORKFLOW).jobs)[0]!.steps;
const indexOf = (pred: (s: Step) => boolean) => steps().findIndex(pred);

describe("android-e2e.yml", () => {
  // Las cachés de un PR solo las ven ese PR y los que salen de su rama: sin
  // una corrida en main, cada PR compilaba 20 minutos desde cero (PR #24 de
  // truckconnect-mobile, 2026-11-27). En main no se cancela una corrida a
  // medias, que es la que deja la caché.
  it("el proyecto lo corre en cada PR, en main y a mano, uno por PR a la vez", () => {
    const caller = parse(CALLER);

    expect(Object.keys(caller.on).sort()).toEqual([
      "pull_request",
      "push",
      "workflow_dispatch",
    ]);
    expect(caller.on.push).toEqual({ branches: ["main"] });
    expect(String(caller.concurrency?.["cancel-in-progress"])).toMatch(
      /github\.event_name == 'pull_request'/,
    );
    expect(caller.concurrency?.group).toContain("pull_request.number");
    expect(caller.permissions).toEqual({ contents: "read" });
  });

  it("solo sigue si factory.json define commands.androidE2e", () => {
    const all = steps();
    const gate = all.find((s) => s.id === "android")!;

    expect(gate.run).toContain("androidE2e");
    const after = all.slice(all.indexOf(gate) + 1);
    expect(after.length).toBeGreaterThan(3);
    for (const step of after.filter((s) => !s.if?.includes("failure()")))
      expect(step.if, step.name).toContain(
        "steps.android.outputs.enabled == 'true'",
      );
  });

  it("corre el script del plugin dentro del emulador, con KVM", () => {
    const all = steps();
    const emulator = all.find((s) =>
      s.uses?.startsWith("reactivecircus/android-emulator-runner@"),
    )!;

    expect(emulator.uses).toMatch(/@[0-9a-f]{40}$/);
    expect(readFileSync(WORKFLOW, "utf8")).toContain(`${emulator.uses} # v`);
    // Cada línea de `script:` corre en su propio shell: una sola llamada.
    expect(String(emulator.with?.script).trim().split("\n")).toHaveLength(1);
    expect(emulator.with?.script).toContain(
      "fabrica-plugin/plugins/fabrica/scripts/android-e2e.sh",
    );
    expect(emulator.with?.arch).toBe("x86_64");
    // Con el perfil por defecto (320×640) el teclado tapaba el botón de
    // entrar y el flow de cerrar sesión falló solo en la CI (PR #21 de
    // truckconnect-mobile, 2026-11-26): la pantalla de un teléfono real.
    expect(emulator.with?.profile).toMatch(/^pixel_/);
    const kvm = all.findIndex((s) => (s.run ?? "").includes("kvm"));
    expect(kvm).toBeGreaterThan(-1);
    expect(kvm).toBeLessThan(all.indexOf(emulator));
  });

  it("instala antes Java, las dependencias y Maestro en una versión fija", () => {
    const emulator = indexOf((s) =>
      Boolean(s.uses?.startsWith("reactivecircus/android-emulator-runner@")),
    );
    const java = indexOf((s) =>
      Boolean(s.uses?.startsWith("actions/setup-java@")),
    );
    const deps = indexOf((s) => (s.run ?? "").includes("fabrica-cmd install"));
    const maestro = indexOf((s) =>
      (s.run ?? "").includes("get.maestro.mobile.dev"),
    );

    expect(java).toBeGreaterThan(-1);
    expect(java).toBeLessThan(emulator);
    expect(deps).toBeGreaterThan(-1);
    expect(deps).toBeLessThan(emulator);
    expect(maestro).toBeGreaterThan(-1);
    expect(maestro).toBeLessThan(emulator);
    expect(steps()[maestro]!.env?.MAESTRO_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("si falla, sube los logs del servidor, el logcat y las capturas de Maestro", () => {
    const upload = steps().find((s) =>
      s.uses?.startsWith("actions/upload-artifact@"),
    )!;

    expect(upload.if).toContain("failure()");
    expect(String(upload.with?.path)).toContain("android-logs");
    expect(String(upload.with?.path)).toContain(".maestro/tests");
  });

  // Compilar con el emulador arriba dejó al runner sin recursos: GitHub lo
  // apagó en plena compilación (PR #21 de truckconnect-mobile, 2026-11-26).
  it("compila antes de arrancar el emulador, con espacio liberado", () => {
    const all = steps();
    const emulator = all.findIndex((s) =>
      Boolean(s.uses?.startsWith("reactivecircus/android-emulator-runner@")),
    );
    const build = all.findIndex((s) =>
      (s.run ?? "").includes("fabrica-cmd androidBuild"),
    );
    const free = all.findIndex((s) =>
      (s.run ?? "").includes("/usr/share/dotnet"),
    );

    expect(build).toBeGreaterThan(-1);
    expect(build).toBeLessThan(emulator);
    expect(free).toBeGreaterThan(-1);
    expect(free).toBeLessThan(build);
    // El script recibe el APK que dice factory.json → androidApk.
    expect(String(all[emulator]!.with?.script)).toContain(
      "steps.android.outputs.apk",
    );
    expect(all.find((s) => s.id === "android")!.run).toContain("androidApk");
  });

  // Un flow en rojo no guardaba la caché, y la siguiente corrida compilaba
  // 20 minutos desde cero (PR #21 de truckconnect-mobile, 2026-11-26).
  it("guarda la caché de Gradle aunque el job falle, solo en la rama principal", () => {
    const all = steps();
    const isGradle = (s: Step) => String(s.with?.path).includes(".gradle");
    const save = all.find(
      (s) => s.uses?.startsWith("actions/cache/save@") && isGradle(s),
    )!;
    const restore = all.find(
      (s) => s.uses?.startsWith("actions/cache/restore@") && isGradle(s),
    )!;

    expect(save.if).toContain("always()");
    expect(restore.id).toBeDefined();
    expect(save.with?.key).toBe(restore.with?.key);
    // Cada PR guardaba 1,8 GB que no veía nadie más: cuatro llenaban 7,3 de
    // los 10 GB del repo (2026-11-27).
    expect(save.if).toContain("github.event.repository.default_branch");
  });

  // Con el dev client el APK solo lleva la parte nativa: el JavaScript lo
  // sirve Metro. Casi todos los PRs tocan solo JavaScript y compilaban 20
  // minutos igual (PR #24 de truckconnect-mobile, 2026-11-27).
  describe("con commands.androidFingerprint", () => {
    const find = (pred: (s: Step) => boolean) => steps().find(pred)!;
    const fingerprint = () => find((s) => s.id === "fingerprint");
    const restore = () => find((s) => s.id === "apk-cache");
    const isApkSave = (s: Step) =>
      Boolean(s.uses?.startsWith("actions/cache/save@")) &&
      String(s.with?.path).includes("steps.android.outputs.apk");

    it("saca la huella nativa después de las dependencias", () => {
      expect(find((s) => s.id === "android").run).toContain(
        "androidFingerprint",
      );
      expect(fingerprint().run).toContain("fabrica-cmd androidFingerprint");
      expect(fingerprint().if).toContain(
        "steps.android.outputs.fingerprint == 'true'",
      );
      // steps() vuelve a leer el YAML: se compara por id, no por objeto.
      expect(indexOf((s) => s.id === "fingerprint")).toBeGreaterThan(
        indexOf((s) => (s.run ?? "").includes("fabrica-cmd install")),
      );
    });

    it("trae el APK de la caché por la huella y, si está, no compila", () => {
      expect(restore().uses).toMatch(/^actions\/cache\/restore@[0-9a-f]{40}$/);
      expect(restore().with?.path).toBe("${{ steps.android.outputs.apk }}");
      expect(restore().with?.key).toContain("steps.fingerprint.outputs.hash");
      expect(restore().if).toContain("steps.fingerprint.outputs.hash != ''");
      const hit = "steps.apk-cache.outputs.cache-hit != 'true'";
      const build = find((s) =>
        (s.run ?? "").includes("fabrica-cmd androidBuild"),
      );
      for (const step of [
        build,
        find((s) => Boolean(s.uses?.startsWith("actions/setup-java@"))),
        find(
          (s) =>
            Boolean(s.uses?.startsWith("actions/cache/restore@")) &&
            String(s.with?.path).includes(".gradle"),
        ),
      ])
        expect(step.if, step.name).toContain(hit);
      expect(indexOf((s) => s.id === "apk-cache")).toBeLessThan(
        indexOf((s) => s.id === "build"),
      );
    });

    it("guarda el APK que compiló, aunque los flows fallen", () => {
      const save = find(isApkSave);
      const build = find((s) =>
        (s.run ?? "").includes("fabrica-cmd androidBuild"),
      );

      expect(build.id).toBe("build");
      expect(save.if).toContain("always()");
      expect(save.if).toContain("steps.build.outcome == 'success'");
      expect(save.with?.key).toBe(restore().with?.key);
    });

    it("la huella cambia si cambia cómo se compila", () => {
      expect(fingerprint().run).toMatch(/androidBuild/);
      expect(fingerprint().run).toMatch(/androidApk/);
    });
  });

  it("apaga el demonio de Gradle antes del emulador", () => {
    const build = steps().find((s) =>
      (s.run ?? "").includes("fabrica-cmd androidBuild"),
    )!;

    expect(build.run).toMatch(/pkill .*GradleDaemon/);
  });

  it("tiene un tope de tiempo", () => {
    const job = Object.values(parse(WORKFLOW).jobs)[0]!;

    expect(job["timeout-minutes"]).toBeGreaterThan(0);
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(60);
  });
});
