import path from "path";
import chokidar from "chokidar";
import { EventDelegate } from "../events";

export class Watcher {
  public readonly onChange = new EventDelegate<void>();

  constructor(main: string) {
    const directory = path.dirname(main);
    chokidar
      .watch(directory, {
        persistent: true,
        ignoreInitial: true,
        followSymlinks: false,
        disableGlobbing: false,
      })
      .on("change", () => {
        this.onChange.trigger();
      });
  }
}
