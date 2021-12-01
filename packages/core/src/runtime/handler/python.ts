import { Definition } from "./definition";
import os from "os";
import path from "path";
import { Paths } from "../../util";

export const PythonHandler: Definition = (opts) => {
  const PATH = (() => {
    if (process.env.VIRTUAL_ENV) {
      const runtimeDir = os.platform() === "win32" ? "Scripts" : "bin";
      return [
        path.join(process.env.VIRTUAL_ENV, runtimeDir),
        path.delimiter,
        process.env.PATH,
      ].join("");
    }

    return process.env.PATH!;
  })();
  const dir = path.dirname(opts.handler);
  const [base, ext] = path.basename(opts.handler).split(".");
  const target = path.join(opts.srcPath, opts.id, dir, base);

  return {
    bundle: () => {
      return {
        handler: opts.handler,
        directory: opts.srcPath,
      };
    },
    run: {
      command:
        os.platform() === "win32" ? "python.exe" : opts.runtime.split(".")[0],
      args: [
        "-u",
        path.join(
          Paths.OWN_PATH,
          "../src",
          "runtime",
          "shells",
          "bootstrap.py"
        ),
        target.split(path.sep).join("."),
        opts.srcPath,
        ext,
      ],
      env: {
        PATH,
      },
    },
    watcher: {
      include: [path.join(opts.srcPath, "**/*.py")],
      ignore: [],
    },
  };
};
