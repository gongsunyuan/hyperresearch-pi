/**
 * hpr.ts — hyperresearch CLI bridge.
 *
 * Resolves the `hyperresearch` / `hpr` executable and runs subcommands with
 * `--json` output, returning parsed JSON. All pi custom tools delegate here
 * instead of shelling out directly, so path resolution + error handling live
 * in one place.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export interface HprResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  stderr?: string;
  exitCode?: number;
}

/** Candidate executable names. */
const NAMES = ["hyperresearch", "hpr", "hyperresearch.exe", "hpr.exe"];

/**
 * Resolve the hyperresearch executable path.
 *
 * Order:
 *  1. HYPERRESEARCH_BIN env var
 *  2. bare name on PATH (let the OS resolve)
 *  3. common Windows per-user pip Scripts dirs
 *  4. common conda Scripts dirs
 */
export function resolveHpr(): string {
  const envBin = process.env.HYPERRESEARCH_BIN;
  if (envBin && existsSync(envBin)) return envBin;

  // On Windows, the per-user Scripts dir is the most common install location
  // and is frequently NOT on PATH.
  if (platform() === "win32") {
    const home = homedir();
    const candidates: string[] = [];
    for (const name of NAMES) {
      // per-user pip install (Python 3.11–3.14)
      for (const ver of ["Python313", "Python312", "Python311", "Python314"]) {
        candidates.push(join(home, "AppData", "Roaming", "Python", ver, "Scripts", name));
      }
      // conda / miniconda
      candidates.push(join("C:\\ProgramData\\miniconda3", "Scripts", name));
      candidates.push(join("C:\\ProgramData\\Anaconda3", "Scripts", name));
      candidates.push(join(home, "miniconda3", "Scripts", name));
      candidates.push(join(home, "Anaconda3", "Scripts", name));
    }
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  }

  // Fall back to bare name — execFile will search PATH.
  return NAMES[0];
}

let _cachedBin: string | undefined;

function getBin(): string {
  if (_cachedBin) return _cachedBin;
  _cachedBin = resolveHpr();
  return _cachedBin;
}

/**
 * Run a hyperresearch subcommand with --json and return parsed data.
 *
 * @param args   subcommand args, e.g. ["search", "quantum", "--json"]
 * @param opts   { signal, cwd, timeoutMs }
 */
export function runHpr<T = unknown>(
  args: string[],
  opts: { signal?: AbortSignal; cwd?: string; timeoutMs?: number } = {},
): Promise<HprResult<T>> {
  const bin = getBin();
  const finalArgs = args.includes("--json") ? args : [...args, "--json"];
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      finalArgs,
      {
        signal: opts.signal,
        cwd: opts.cwd,
        maxBuffer: 50 * 1024 * 1024, // 50MB — vault operations can be large
        windowsHide: true,
        timeout: opts.timeoutMs,
      },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            error: err.message,
            stderr: stderr?.toString(),
            exitCode: (err as NodeJS.ErrnoException & { code?: number }).code,
          });
          return;
        }
        const text = stdout?.toString() ?? "";
        try {
          const parsed = JSON.parse(text) as T;
          resolve({ ok: true, data: parsed });
        } catch {
          // Non-JSON output (e.g. rich-rendered help). Return raw text.
          resolve({ ok: true, data: text as unknown as T });
        }
      },
    );
    if (opts.signal) {
      opts.signal.addEventListener("abort", () => child.kill());
    }
  });
}

/**
 * Run a hyperresearch subcommand WITHOUT forcing --json, returning raw stdout.
 * Useful for commands that produce files or rich output.
 */
export function runHprRaw(
  args: string[],
  opts: { signal?: AbortSignal; cwd?: string; timeoutMs?: number } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode?: number }> {
  const bin = getBin();
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      {
        signal: opts.signal,
        cwd: opts.cwd,
        maxBuffer: 50 * 1024 * 1024,
        windowsHide: true,
        timeout: opts.timeoutMs,
      },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            stdout: stdout?.toString() ?? "",
            stderr: stderr?.toString() ?? "",
            exitCode: (err as NodeJS.ErrnoException & { code?: number }).code,
          });
          return;
        }
        resolve({ ok: true, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
      },
    );
    if (opts.signal) {
      opts.signal.addEventListener("abort", () => child.kill());
    }
  });
}

/** Check whether the hyperresearch CLI is available. */
export async function checkHpr(): Promise<{ available: boolean; bin: string; version?: string }> {
  const bin = getBin();
  const res = await runHprRaw(["--version"]);
  return {
    available: res.ok,
    bin,
    version: res.ok ? res.stdout.trim() : undefined,
  };
}

/**
 * Ensure the hyperresearch Python CLI is installed. If `checkHpr()` reports it
 * missing, attempt `pip install hyperresearch` automatically so `pi install`
 * is truly one-step. Returns the post-install availability + version.
 *
 * This is safe to call from an async extension factory — pi awaits the factory
 * before startup continues.
 */
export async function ensureHpr(): Promise<{
  available: boolean;
  bin: string;
  version?: string;
  justInstalled: boolean;
  error?: string;
}> {
  const before = await checkHpr();
  if (before.available) {
    return { ...before, justInstalled: false };
  }

  // Try to auto-install via pip. Locate pip/python via common candidates.
  const pipCandidates = [
    process.env.HYPERRESEARCH_PIP,
    "pip",
    "pip3",
    "python -m pip",
    "python3 -m pip",
  ].filter(Boolean) as string[];

  // On Windows, also try the known conda/per-user python.
  if (platform() === "win32") {
    const home = homedir();
    pipCandidates.push(
      join("C:\\ProgramData\\miniconda3", "Scripts", "pip.exe"),
      join("C:\\ProgramData\\Anaconda3", "Scripts", "pip.exe"),
      join(home, "miniconda3", "Scripts", "pip.exe"),
      join(home, "Anaconda3", "Scripts", "pip.exe"),
      join("C:\\ProgramData\\miniconda3", "python.exe"),
      join("C:\\ProgramData\\Anaconda3", "python.exe"),
    );
  }

  let installError: string | undefined;
  for (const pip of pipCandidates) {
    try {
      const isModule = pip.includes(" -m pip");
      const bin = isModule ? pip.split(" ")[0] : pip;
      const modArgs = isModule ? ["-m", "pip", "install", "hyperresearch"] : ["install", "hyperresearch"];
      const result = await new Promise<{ ok: boolean; stderr: string }>((resolve) => {
        const child = execFile(
          bin,
          modArgs,
          { windowsHide: true, maxBuffer: 20 * 1024 * 1024, timeout: 180_000 },
          (err, _stdout, stderr) => {
            resolve({ ok: !err, stderr: stderr?.toString() ?? "" });
          },
        );
        child.stdout?.on("data", () => {}); // drain
      });
      if (result.ok) {
        // Reset cached bin path so resolveHpr re-scans the fresh install.
        _cachedBin = undefined;
        const after = await checkHpr();
        if (after.available) {
          return { ...after, justInstalled: true };
        }
      } else {
        installError = result.stderr.slice(0, 300);
      }
    } catch (e) {
      installError = (e as Error).message;
    }
  }

  return {
    available: false,
    bin: before.bin,
    justInstalled: false,
    error: installError ?? "pip not found",
  };
}
