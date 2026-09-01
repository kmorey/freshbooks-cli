import { spawn } from "node:child_process";

export function runProcess(command, args, { input, ignoreFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code, stdout, stderr };
      if (code === 0 || ignoreFailure) resolve(result);
      else reject(new Error(stderr.trim() || `${command} exited with status ${code}`));
    });
    if (input !== undefined) child.stdin.end(input);
  });
}
