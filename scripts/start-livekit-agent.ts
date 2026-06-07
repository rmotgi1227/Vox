import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = findRepoRoot(process.cwd());
const port = Number(process.env.LIVEKIT_AGENT_PORT ?? 8081);

freePort(port);

const tsxBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const agentPath = path.join(root, "apps", "agent", "src", "agent.ts");
const child = spawn(tsxBin, [agentPath, "start"], {
  cwd: root,
  env: { ...process.env, LIVEKIT_AGENT_PORT: String(port) },
  stdio: "inherit"
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});

function findRepoRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "apps", "agent"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function freePort(targetPort: number) {
  let output = "";
  try {
    output = execFileSync("lsof", ["-ti", `tcp:${targetPort}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  } catch {
    return;
  }

  const pids = output
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already exited.
    }
  }
}
