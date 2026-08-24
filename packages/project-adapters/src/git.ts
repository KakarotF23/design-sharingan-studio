import { spawn } from "node:child_process";

export interface GitCommand {
  executable: "git";
  args: readonly string[];
  cwd: string;
}

export interface GitRunOptions {
  environment?: Readonly<Record<string, string>>;
  privateEnvironment?: Readonly<Record<string, string>>;
}

export interface GitRunner {
  run(command: GitCommand, options?: GitRunOptions): Promise<void>;
}

export const defaultGitRunner: GitRunner = {
  async run(command, options): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command.executable, [...command.args], {
        cwd: command.cwd,
        env: {
          ...process.env,
          ...options?.environment,
          ...options?.privateEnvironment,
        },
        shell: false,
        stdio: ["ignore", "ignore", "ignore"],
      });

      child.once("error", () => {
        reject(new Error("Git process could not be started"));
      });
      child.once("close", (exitCode) => {
        if (exitCode === 0) {
          resolve();
        } else {
          reject(new Error("Git process failed"));
        }
      });
    });
  },
};
