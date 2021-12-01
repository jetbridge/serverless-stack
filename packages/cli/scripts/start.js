"use strict";

const path = require("path");
const util = require("util");
const fs = require("fs-extra");
const chalk = require("chalk");
const crypto = require("crypto");
const detect = require("detect-port-alt");
const {
  logger,
  getChildLogger,
  STACK_DEPLOY_STATUS,
  Runtime,
  Stacks,
  Bridge,
  State,
  useStacksBuilder,
} = require("@serverless-stack/core");

const paths = require("./util/paths");
const {
  synth,
  deploy,
  prepareCdk,
  writeConfig,
  isNodeRuntime,
  checkFileExists,
  writeOutputsFile,
} = require("./util/cdkHelpers");
const objectUtil = require("../lib/object");
const ApiServer = require("./util/ApiServer");
const { deserializeError } = require("../lib/serializeError");

const API_SERVER_PORT = 4000;

let apiServer;
let isConsoleEnabled = false;
// This flag is currently used by the "sst.Script" construct to make the "BuiltAt"
// remain the same when rebuilding infrastructure.
const debugStartedAt = Date.now();

const IS_TEST = process.env.__TEST__ === "true";

// Setup logger
const clientLogger = {
  debug: (...m) => {
    getChildLogger("client").debug(...m);
  },
  trace: (...m) => {
    // If console is not enabled, print trace in terminal (ie. request logs)
    isConsoleEnabled
      ? getChildLogger("client").trace(...m)
      : getChildLogger("client").info(...m);
    forwardToBrowser(...m);
  },
  info: (...m) => {
    getChildLogger("client").info(...m);
    forwardToBrowser(...m);
  },
  warn: (...m) => {
    getChildLogger("client").warn(...m);
    forwardToBrowser(...m);
  },
  error: (...m) => {
    getChildLogger("client").error(...m);
    forwardToBrowser(...m);
  },
};

module.exports = async function (argv, config, cliInfo) {
  await prepareCdk(argv, cliInfo, config);

  // Deploy debug stack
  const debugStackOutputs = await deployDebugStack(config, cliInfo);
  const debugEndpoint = debugStackOutputs.Endpoint;
  const debugBucketArn = debugStackOutputs.BucketArn;
  const debugBucketName = debugStackOutputs.BucketName;

  // Startup UDP
  const bridge = new Bridge.Server();
  if (argv.udp) {
    clientLogger.info(chalk.grey(`Using UDP connection`));
    config.debugBridge = await bridge.start();
  }

  // Deploy app
  const { deployRet: appStackDeployRet } = await deployApp(
    argv,
    {
      ...config,
      debugEndpoint,
      debugBucketArn,
      debugBucketName,
    },
    cliInfo
  );
  await updateStaticSiteEnvironmentOutputs(appStackDeployRet);

  logger.info("");
  logger.info("==========================");
  logger.info(" Starting Live Lambda Dev");
  logger.info("==========================");
  logger.info("");

  const funcs = State.Function.read(paths.appPath);

  // Startup Websocket
  const ws = new Runtime.WS();
  ws.onMessage.add((msg) => {
    switch (msg.action) {
      case "register":
        bridge.addPeer(msg.body);
        bridge.ping();
        break;
      case "server.clientRegistered":
        clientLogger.info("Debug session started. Listening for requests...");
        clientLogger.debug(`Client connection id: ${msg.clientConnectionId}`);
        break;
      case "server.clientDisconnectedDueToNewClient":
        clientLogger.warn(
          "A new debug session has been started. This session will be closed..."
        );
        break;
      case "server.failedToSendResponseDueToStubDisconnected":
        clientLogger.error(
          chalk.grey(msg.debugRequestId) +
            " Failed to send response because the Lambda function is disconnected"
        );
        break;
    }
  });
  ws.start(debugEndpoint, debugBucketArn);

  const server = new Runtime.Server({
    port: argv.port || (await chooseServerPort(12557)),
  });
  server.onStdErr.add((arg) => {
    arg.data.endsWith("\n")
      ? clientLogger.trace(arg.data.slice(0, -1))
      : clientLogger.trace(arg.data);
  });
  server.onStdOut.add((arg) => {
    arg.data.endsWith("\n")
      ? clientLogger.trace(arg.data.slice(0, -1))
      : clientLogger.trace(arg.data);
  });
  server.listen();

  // Wire up watcher
  const watcher = new Runtime.Watcher();
  watcher.reload(paths.appPath, config);
  watcher.onChange.add(async (funcs) => {
    if (!funcs.length) return;
    clientLogger.info(chalk.gray("New: Rebuilding..."));
    await Promise.all(funcs.map((f) => server.drain(f).catch(() => {})));
    clientLogger.info(chalk.gray("New: Done rebuilding."));
  });

  const stacksWatcher = new Stacks.Watcher(config.main);
  const stacksBuilder = useStacksBuilder(paths.appPath, config);
  stacksBuilder.onTransition((state) => console.log("State:", state.value));
  stacksWatcher.onChange.add(() => stacksBuilder.send("FILE_CHANGE"));

  // Handle requests from udp or ws
  async function handleRequest(req) {
    const timeoutAt = Date.now() + req.debugRequestTimeoutInMs;
    const func = funcs.find((f) => f.id === req.functionId);
    if (!func) {
      console.error("Unable to find function", req.functionId);
      return {
        type: "failure",
        body: "Failed to find function",
      };
    }

    clientLogger.debug("Invoking local function...");
    const result = await server.invoke({
      function: {
        ...func,
        root: paths.appPath,
      },
      env: {
        ...getSystemEnv(),
        ...req.env,
      },
      payload: {
        event: req.event,
        context: req.context,
        deadline: timeoutAt,
      },
    });
    clientLogger.debug("Response", result);

    if (result.type === "success") {
      clientLogger.info(
        chalk.grey(
          `${req.context.awsRequestId} RESPONSE ${objectUtil.truncate(
            result.data,
            {
              totalLength: 1500,
              arrayLength: 10,
              stringLength: 100,
            }
          )}`
        )
      );
      return {
        type: "success",
        body: result.data,
      };
    }

    if (result.type === "failure") {
      const errorMessage = isNodeRuntime(func.runtime)
        ? deserializeError(result.error)
        : result.rawError;
      clientLogger.info(
        `${chalk.grey(req.context.awsRequestId)} ${chalk.red("ERROR")}`,
        util.inspect(errorMessage, { depth: null })
      );
      return {
        type: "failure",
        body: {
          errorMessage: result.rawError.errorMessage,
          errorType: result.rawError.errorType,
          stackTrace: result.rawError.trace,
        },
      };
    }
  }
  bridge.onRequest(handleRequest);
  ws.onRequest(handleRequest);

  if (argv.console) {
    isConsoleEnabled = true;
    await startApiServer();
  }
};

async function deployDebugStack(config, cliInfo) {
  // Do not deploy if running test
  if (IS_TEST) {
    return {
      Endpoint: "ws://test-endpoint",
      BucketArn: "bucket-arn",
      BucketName: "bucket-name",
    };
  }

  logger.info("");
  logger.info("=======================");
  logger.info(" Deploying debug stack");
  logger.info("=======================");
  logger.info("");

  const stackName = `${config.stage}-${config.name}-debug-stack`;
  const cdkOptions = {
    ...cliInfo.cdkOptions,
    app: `node bin/index.js ${stackName} ${config.stage} ${config.region} ${
      paths.appPath
    } ${State.stacksPath(paths.appPath)}`,
    output: "cdk.out",
  };

  // Change working directory
  // Note: When deploying the debug stack, the current working directory is user's app.
  //       Setting the current working directory to debug stack cdk app directory to allow
  //       Lambda Function construct be able to reference code with relative path.
  process.chdir(path.join(paths.ownPath, "assets", "debug-stack"));

  // Build
  await synth(cdkOptions);

  // Deploy
  const deployRet = await deploy(cdkOptions);

  logger.debug("deployRet", deployRet);

  // Restore working directory
  process.chdir(paths.appPath);

  // Get WebSocket endpoint
  if (
    !deployRet ||
    deployRet.length !== 1 ||
    deployRet[0].status === STACK_DEPLOY_STATUS.FAILED
  ) {
    throw new Error(`Failed to deploy debug stack ${stackName}`);
  } else if (!deployRet[0].outputs || !deployRet[0].outputs.Endpoint) {
    throw new Error(
      `Failed to get the endpoint from the deployed debug stack ${stackName}`
    );
  }

  return deployRet[0].outputs;
}

async function deployApp(argv, config, cliInfo) {
  logger.info("");
  logger.info("===============");
  logger.info(" Deploying app");
  logger.info("===============");
  logger.info("");

  await writeConfig({
    ...config,
    debugStartedAt,
    debugIncreaseTimeout: argv.increaseTimeout || false,
  });

  // Build
  const cdkManifest = await synth(cliInfo.cdkOptions);
  const cdkOutPath = path.join(paths.appBuildPath, "cdk.out");
  const checksumData = generateChecksumData(cdkManifest, cdkOutPath);

  let deployRet;
  if (IS_TEST) {
    deployRet = [];
  } else {
    // Deploy
    deployRet = await deploy(cliInfo.cdkOptions);

    // Check all stacks deployed successfully
    if (
      deployRet.some((stack) => stack.status === STACK_DEPLOY_STATUS.FAILED)
    ) {
      throw new Error(`Failed to deploy the app`);
    }
  }

  // Write outputsFile
  if (argv.outputsFile) {
    await writeOutputsFile(
      deployRet,
      path.join(paths.appPath, argv.outputsFile),
      cliInfo.cdkOptions
    );
  }

  return { deployRet, checksumData };
}

async function startApiServer() {
  const port = await chooseServerPort(API_SERVER_PORT);
  apiServer = new ApiServer({});
  await apiServer.start(port);

  logger.info(
    `\nYou can now view the SST Console in the browser: ${chalk.cyan(
      `http://localhost:${port}`
    )}`
  );
  // note: if working on the CLI package (ie. running within the CLI package),
  //       print out how to start up console.
  if (isRunningWithinCliPackage()) {
    logger.info(
      `If you are working on the SST Console, navigate to ${chalk.cyan(
        "assets/console"
      )} and run ${chalk.cyan(`REACT_APP_SST_PORT=${port} yarn start`)}`
    );
  }
}

////////////////////
// Util functions //
////////////////////

async function updateStaticSiteEnvironmentOutputs(deployRet) {
  // ie. environments outputs
  // [{
  //    id: "MyFrontend",
  //    path: "src/sites/react-app",
  //    stack: "dev-playground-another",
  //    environmentOutputs: {
  //      "REACT_APP_API_URL":"FrontendSSTSTATICSITEENVREACTAPPAPIURLFAEF5D8C",
  //      "ABC":"FrontendSSTSTATICSITEENVABC527391D2"
  //    }
  // }]
  //
  // ie. deployRet
  // [{
  //    name: "dev-playground-another",
  //    outputs: {
  //      "FrontendSSTSTATICSITEENVREACTAPPAPIURLFAEF5D8C":"https://...",
  //      "FrontendSSTSTATICSITEENVABC527391D2":"hi"
  //    }
  // }]
  const environmentOutputKeysPath = path.join(
    paths.appPath,
    paths.appBuildDir,
    "static-site-environment-output-keys.json"
  );
  const environmentOutputValuesPath = path.join(
    paths.appPath,
    paths.appBuildDir,
    "static-site-environment-output-values.json"
  );

  if (!(await checkFileExists(environmentOutputKeysPath))) {
    throw new Error(`Failed to get the StaticSite info from the app`);
  }

  // Replace output value with stack output
  const environments = await fs.readJson(environmentOutputKeysPath);
  environments.forEach(({ stack, environmentOutputs }) => {
    const stackData = deployRet.find(({ name }) => name === stack);
    if (stackData) {
      Object.entries(environmentOutputs).forEach(([envName, outputName]) => {
        environmentOutputs[envName] = stackData.outputs[outputName];
      });
    }
  });

  // Update file
  await fs.writeJson(environmentOutputValuesPath, environments);
}
function generateChecksumData(cdkManifest, cdkOutPath) {
  const checksums = {};
  cdkManifest.stacks.forEach(({ name }) => {
    const templatePath = path.join(cdkOutPath, `${name}.template.json`);
    const templateContent = fs.readFileSync(templatePath);
    checksums[name] = generateChecksum(templateContent);
  });
  return checksums;
}
function generateChecksum(templateContent) {
  const hash = crypto.createHash("sha1");
  hash.setEncoding("hex");
  hash.write(templateContent);
  hash.end();
  return hash.read();
}
async function chooseServerPort(defaultPort) {
  const host = "0.0.0.0";
  logger.debug(`Checking port ${defaultPort} on host ${host}`);

  try {
    return detect(defaultPort, host);
  } catch (err) {
    throw new Error(
      chalk.red(`Could not find an open port at ${chalk.bold(host)}.`) +
        "\n" +
        ("Network error message: " + err.message || err) +
        "\n"
    );
  }
}
function isRunningWithinCliPackage() {
  return (
    path.resolve(__filename) ===
    path.resolve(
      path.join(
        __dirname,
        "..",
        "..",
        "..",
        "packages",
        "cli",
        "scripts",
        "start.js"
      )
    )
  );
}

function getSystemEnv() {
  const env = { ...process.env };
  // AWS_PROFILE is defined if users run `AWS_PROFILE=xx sst start`, and in
  // aws sdk v3, AWS_PROFILE takes precedence over AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY.
  // Hence we need to remove it to ensure the invoked function uses the IAM
  // credentials from the remote Lambda.
  delete env.AWS_PROFILE;
  return env;
}
function forwardToBrowser(message) {
  apiServer &&
    apiServer.publish("RUNTIME_LOG_ADDED", {
      runtimeLogAdded: {
        message: message.endsWith("\n") ? message : `${message}\n`,
      },
    });
}
