import { spawn } from "node:child_process";

export interface GitCommand {
  executable: "git";
  args: readonly string[];
  cwd: string;
}

export interface GitRunOptions {
  environment?: Readonly<Record<string, string>>;
  privateEnvironment?: Readonly<Record<string, string>>;
  /**
   * Drop inherited GIT_* process variables before applying the controlled
   * command environment. Used when repository content is materialized.
   */
  isolateInheritedGitEnvironment?: boolean;
}

export interface GitRunner {
  run(command: GitCommand, options?: GitRunOptions): Promise<void>;
}

export const defaultGitRunner: GitRunner = {
  async run(command, options): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const inheritedEnvironment =
        options?.isolateInheritedGitEnvironment === true
          ? Object.fromEntries(
              Object.entries(process.env).filter(
                ([key]) => !key.toUpperCase().startsWith("GIT_"),
              ),
            )
          : process.env;
      const child = spawn(command.executable, [...command.args], {
        cwd: command.cwd,
        env: {
          ...inheritedEnvironment,
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
