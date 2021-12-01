import spawn from "cross-spawn";

export type Command = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

type BundleResult = {
  directory: string;
  handler: string;
};

export type Instructions = {
  build?: () => Promise<void>;
  bundle: () => BundleResult;
  run: Command;
  watcher: {
    include: string[];
    ignore: string[];
  };
};

export type Opts<T = any> = {
  id: string;
  root: string;
  runtime: string;
  srcPath: string;
  handler: string;
  bundle?: T | false;
};

export type Definition<T = any> = (opts: Opts<T>) => Instructions;

export function buildAsync(opts: Opts, cmd: Command) {
  const proc = spawn(cmd.command, cmd.args, {
    env: {
      ...cmd.env,
      ...process.env,
    },
    cwd: opts.srcPath,
  });
  return new Promise<void>((resolve, reject) => {
    proc.on("exit", () => {
      if (proc.exitCode === 0) resolve();
      if (proc.exitCode !== 0) reject();
    });
  });
}

export function buildSync(opts: Opts, cmd: Command) {
  spawn.sync(cmd.command, cmd.args, {
    env: {
      ...cmd.env,
      ...process.env,
    },
    stdio: "inherit",
    cwd: opts.srcPath,
  });
}
