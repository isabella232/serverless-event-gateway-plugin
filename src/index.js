"use strict";

const merge = require("lodash.merge");
const SDK = require("@serverless/event-gateway-sdk");
const chalk = require("chalk");
const to = require("await-to-js").to;

class EGPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;

    this.awsProvider = this.serverless.getProvider("aws");

    this.hooks = {
      "package:compileEvents": this.addUserDefinition.bind(this),
      "after:deploy:finalize": this.configureEventGateway.bind(this),
      "emitremote:emit": this.emitEvent.bind(this)
    };

    this.commands = {
      emitremote: {
        usage: "Emit event to hosted Event Gateway",
        lifecycleEvents: ["emit"],
        options: {
          event: {
            usage: "Event you want to emit",
            required: true,
            shortcut: "e"
          },
          data: {
            usage: "Data for the event you want to emit",
            required: true,
            shortcut: "d"
          }
        }
      }
    };
  }

  emitEvent() {
    const eg = this.getClient();

    eg.emit({
      event: this.options.event,
      data: JSON.parse(this.options.data)
    }).then(() => {
      this.serverless.cli.consoleLog(
          chalk.yellow.underline("Event emitted:") +
          chalk.yellow(` ${this.options.event}`)
      );
      this.serverless.cli.consoleLog(
          chalk.yellow("Run `serverless logs -f <functionName>` to verify your subscribed function was triggered.")
      );
    });
  }

  getConfig() {
    if (
      this.serverless.service.custom &&
      this.serverless.service.custom.eventgateway
    ) {
      const config = this.serverless.service.custom.eventgateway;
      config.eventsAPI = `https://${config.subdomain}.eventgateway-dev.io`;
      config.configurationAPI = "https://config.eventgateway-dev.io/";
      return config;
    }

    return null;
  }

  getClient() {
    const config = this.getConfig();
    process.env.EVENT_GATEWAY_TOKEN = config.apikey || process.env.EVENT_GATEWAY_TOKEN;
    if (!config) {
      throw new Error(
        "No Event Gateway configuration provided in serverless.yaml"
      );
    }

    if (!config.subdomain) {
      throw new Error(
        'Required "subdomain" property is missing from Event Gateway configuration provided in serverless.yaml'
      );
    }

    if (!config.apikey) {
      throw new Error(
        'Required "apikey" property is missing from Event Gateway configuration provided in serverless.yaml'
      );
    }

    return new SDK({
      url: "http://localhost:4000",
      configurationUrl: "http://localhost:8080",
      space: config.subdomain,
    });
  }

  async configureEventGateway() {
    const config = this.getConfig();
    const eg = this.getClient();

    this.serverless.cli.consoleLog("");
    this.serverless.cli.consoleLog(
      chalk.yellow.underline("Event Gateway Plugin")
    );

    let [err, data] = await to(this.awsProvider.request(
      "CloudFormation",
      "describeStacks",
      { StackName: this.awsProvider.naming.getStackName() },
      this.awsProvider.getStage(),
      this.awsProvider.getRegion()
    ))
    if (err) {
      throw new Error("Error during fetching information about stack.")
    }

    const stack = data.Stacks.pop();
    if (!stack) {
      throw new Error("Unable to fetch CloudFormation stack information.");
    }

    const outputs = this.parseOutputs(stack);
    if (!outputs.EventGatewayUserAccessKey ||!outputs.EventGatewayUserSecretKey) {
      throw new Error("Event Gateway Access Key or Secret Key not found in outputs");
    }

    let functions = [], subscriptions = [], result
    [err, result] = await to(eg.listFunctions())
    if (!err) {
      functions = result
    }

    [err, result] = await to(eg.listSubscriptions())
    if (!err) {
      subscriptions = result
    }

    // Register missing functions and create missing subscriptions
    this.filterFunctionsWithEvents().map(async name => {
      const outputKey = this.awsProvider.naming.getLambdaVersionOutputLogicalId(name);
      const fullArn = outputs[outputKey];
      // Remove the function version from the ARN so that it always uses the latest version.
      const arn = fullArn.split(':').slice(0,7).join(':')
      const functionId = fullArn.split(':')[6]
      const fn = {
        functionId: functionId,
        provider: {
          type: "awslambda",
          arn: arn,
          region: this.awsProvider.getRegion(),
          awsAccessKeyId: outputs.EventGatewayUserAccessKey,
          awsSecretAccessKey: outputs.EventGatewayUserSecretKey
        }
      }
      const functionEvents = this.serverless.service.getFunction(name).events

      const registeredFunction = functions.find(f => f.functionId === functionId)
      if (!registeredFunction) {
        // create function if doesn't exit
        await to(registerFunction(eg, fn))
        this.serverless.cli.consoleLog(`EventGateway: Function "${name}" registered. (ID: ${fn.functionId})`);

        functionEvents.forEach(async event => {
          await to(createSubscription(config, eg, functionId, event.eventgateway))
          this.serverless.cli.consoleLog(`EventGateway: Function "${name}" subscribed to "${event.eventgateway.event}" event.`)
        })
      } else {
        // remove function from functions array
        functions = functions.filter(f => f.functionId !== functionId)

        // update subscriptions
        let createdSubscriptions = subscriptions.filter(s => s.functionId === functionId)
        functionEvents.forEach(async event => {
          event = event.eventgateway

          const createdSubscription = createdSubscriptions.find(s =>
            s.event == event.event && s.method == event.method && s.path == eventPath(event, config.subdomain)
          )

          // create subscription as it doesn't exists
          if (!createdSubscription) {
              await to(createSubscription(config, eg, functionId, event))
              this.serverless.cli.consoleLog(`EventGateway: Function "${name}" subscribed to "${event.event}" event.`)
          } else {
            createdSubscriptions = createdSubscriptions.filter(s => s.subscriptionId !== createdSubscription.subscriptionId)
          }
        })

        // cleanup subscription that are not needed
        createdSubscriptions.forEach(async sub => {
          eg.unsubscribe({ subscriptionId: sub.subscriptionId })
          this.serverless.cli.consoleLog(`EventGateway: Function "${name}" unsubscribed from "${sub.event}" event.`)
        })
      }
    })

    // Delete function and subscription no longer needed
    functions.forEach(async functionToDelete => {
      const subscriptionsToDelete = subscriptions.filter(s => s.functionId === functionToDelete.functionId)
      await to(
        Promise.all(subscriptionsToDelete.map(toDelete => eg.unsubscribe({subscriptionId: toDelete.subscriptionId}))))

      await to(eg.deleteFunction({ functionId: functionToDelete.functionId }))
      this.serverless.cli.consoleLog(`EventGateway: Function "${functionToDelete.functionId}" deleted.`);
    })
  }

  filterFunctionsWithEvents() {
    const functions = []
    this.serverless.service.getAllFunctions().forEach(name => {
      const func = this.serverless.service.getFunction(name);
      const events = func.events

      if (!events) {
        return
      }

      const eventgateway = events.find(event => event.eventgateway)
      if (!eventgateway) {
        return
      }

      functions.push(name)
    })

    return functions
  }

  parseOutputs(stack) {
    return stack.Outputs.reduce((agg, current) => {
      if (current.OutputKey && current.OutputValue) {
        agg[current.OutputKey] = current.OutputValue;
      }
      return agg;
    }, {});
  }

  addUserDefinition() {
    const resources = this.filterFunctionsWithEvents().map(name => {
      return {
        "Fn::GetAtt": [
          this.awsProvider.naming.getLambdaLogicalId(name),
          "Arn"
        ]
      };
    });
    merge(
      this.serverless.service.provider.compiledCloudFormationTemplate.Resources,
      {
        EventGatewayUser: {
          Type: "AWS::IAM::User"
        },
        EventGatewayUserPolicy: {
          Type: "AWS::IAM::ManagedPolicy",
          Properties: {
            Description:
              "This policy allows Custom plugin to gather data on IAM users",
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Action: ["lambda:InvokeFunction"],
                  Resource: resources
                }
              ]
            },
            Users: [
              {
                Ref: "EventGatewayUser"
              }
            ]
          }
        },
        EventGatewayUserKeys: {
          Type: "AWS::IAM::AccessKey",
          Properties: {
            UserName: {
              Ref: "EventGatewayUser"
            }
          }
        }
      }
    );

    merge(
      this.serverless.service.provider.compiledCloudFormationTemplate.Outputs,
      {
        EventGatewayUserAccessKey: {
          Value: {
            Ref: "EventGatewayUserKeys"
          },
          Description: "Access Key ID of Custom User"
        },
        EventGatewayUserSecretKey: {
          Value: {
            "Fn::GetAtt": ["EventGatewayUserKeys", "SecretAccessKey"]
          },
          Description: "Secret Key of Custom User"
        }
      }
    );
  }
}

function eventPath(event, subdomain) {
  let path = event.path || "/";

  if (!path.startsWith("/")) {
    path = "/" + path
  }

  return `/${subdomain}${path}`
}

async function registerFunction(eg, fn) {
  let [err] = await to(eg.registerFunction(fn))
  if (err) {
    throw new Error(`Couldn't register a function ${fn.functionId}. ${err}.`)
  }
}

async function createSubscription(config, eg, functionId, event) {
    const subscribeEvent = {
      functionId,
      event: event.event,
      path: eventPath(event, config.subdomain),
      cors: event.cors
    };

    if (event.event === "http") {
      subscribeEvent.method = event.method.toUpperCase() || "GET";
    }

    let [err] = await to(eg.subscribe(subscribeEvent))
    if (err) {
      throw new Error(`Couldn't create subscriptions for ${functionId}. ${err}.`)
    }
}

module.exports = EGPlugin;
