import { interpret, actions, assign, createMachine } from "xstate";
import { Config } from "../config";
import { Stacks } from "../stacks";

type Events =
  | { type: "FILE_CHANGE" }
  | { type: "TRIGGER_DEPLOY" }
  | { type: "BUILD_SUCCESS" };

type Context = {
  dirty: boolean;
};

function sleep(name: string, duration = 1000) {
  return function () {
    console.log(name);
    return new Promise((r) => setTimeout(r, duration));
  };
}

function isClean(ctx: Context) {
  return !ctx.dirty;
}

function isChanged() {
  return false;
}

const machine = createMachine<Context, Events>(
  {
    initial: "idle",
    context: {
      dirty: false,
    },
    id: "top",
    states: {
      idle: {
        on: {
          FILE_CHANGE: "building",
        },
      },
      building: {
        entry: assign<Context>({
          dirty: false,
        }),
        invoke: {
          src: "build",
          onDone: [
            {
              target: "synthing",
              cond: isClean,
            },
            {
              target: "building",
            },
          ],
          onError: [
            {
              target: "idle",
              cond: isClean,
            },
            {
              target: "building",
            },
          ],
        },
      },
      synthing: {
        invoke: {
          src: "synth",
          onDone: [
            {
              target: "deployable",
              cond: isChanged,
            },
            {
              target: "idle",
              cond: isClean,
            },
            {
              target: "building",
            },
          ],
          onError: [
            {
              target: "idle",
              cond: isClean,
            },
            {
              target: "building",
            },
          ],
        },
      },
      deployable: {
        on: {
          TRIGGER_DEPLOY: "deploying",
          FILE_CHANGE: "building",
        },
      },
      deploying: {
        invoke: {
          src: "deploy",
          onDone: [{ cond: isClean, target: "idle" }, { target: "building" }],
        },
      },
    },
    on: {
      FILE_CHANGE: {
        actions: actions.assign({
          dirty: (_ctx) => true,
        }),
      },
    },
  },
  {
    services: {
      build: sleep("build"),
      deploy: sleep("deploy"),
      synth: sleep("synth"),
    },
  }
);

export function useStacksBuilder(root: string, config: Config) {
  const service = interpret(
    machine.withConfig({
      services: {
        build: async () => {
          console.log("Building");
          await Stacks.build(root, config);
        },
      },
    })
  );
  service.start();
  return service;
}
