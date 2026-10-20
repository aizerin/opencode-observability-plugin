import { createServer } from "node:http";

import LangfusePlugin from "@langfuse/opencode-observability-plugin/v2";
import { Agent, Model, Provider } from "@opencode/plugin";
import type { Hooks } from "@opencode/plugin/promise/registration";
import type { SessionHooks as SessionHookInputs } from "@opencode/plugin/promise/session";
import { CallID, Error as ToolError } from "@opencode/plugin/promise/tool";
import { trace } from "@opentelemetry/api";
import { Schema } from "effect";
import { expect, onTestFinished, test, vi } from "vitest";

type PluginContext = Parameters<typeof LangfusePlugin.setup>[0];
type ToolHook = Parameters<PluginContext["tool"]["hook"]>[1];
type ToolHookInputs =
  PluginContext["tool"]["hook"] extends Hooks<infer Inputs> ? Inputs : never;

// These SDK IDs are string brands with no additional runtime constraints.
const SessionIDSchema = Schema.declare(
  (value): value is Parameters<ToolHook>[0]["sessionID"] =>
    typeof value === "string",
);
const MessageIDSchema = Schema.declare(
  (value): value is Parameters<ToolHook>[0]["messageID"] =>
    typeof value === "string",
);

const SpanSchema = Schema.Struct({
  name: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.optional(Schema.String),
  attributes: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      value: Schema.Struct({ stringValue: Schema.optional(Schema.String) }),
    }),
  ),
  status: Schema.optional(
    Schema.Struct({
      code: Schema.optional(Schema.Number),
      message: Schema.optional(Schema.String),
    }),
  ),
});
const PayloadSchema = Schema.parseJson(
  Schema.Struct({
    resourceSpans: Schema.Array(
      Schema.Struct({
        scopeSpans: Schema.Array(
          Schema.Struct({ spans: Schema.Array(SpanSchema) }),
        ),
      }),
    ),
  }),
);

const getJsonAttribute = (span: typeof SpanSchema.Type, key: string) => {
  const value = span.attributes.find((attribute) => attribute.key === key)
    ?.value.stringValue;
  if (value === undefined) {
    throw new Error(`Expected ${span.name} attribute ${key}`);
  }
  return Schema.decodeUnknownSync(Schema.parseJson(Schema.Unknown))(value);
};

function createPluginContext(input: {
  sessionHook: PluginContext["session"]["hook"];
  toolHook: PluginContext["tool"]["hook"];
  subscribe: PluginContext["event"]["subscribe"];
}) {
  const unexpectedApi = () => {
    throw new Error("The plugin used an unsupported mock host capability");
  };
  return {
    app: { name: "opencode", version: "2.0.4", channel: "stable" },
    session: {
      hook: input.sessionHook,
      create: unexpectedApi,
      get: unexpectedApi,
      switchAgent: unexpectedApi,
      switchModel: unexpectedApi,
      prompt: unexpectedApi,
      generate: unexpectedApi,
      command: unexpectedApi,
      synthetic: unexpectedApi,
      interrupt: unexpectedApi,
      update: unexpectedApi,
      move: unexpectedApi,
      wait: unexpectedApi,
      context: unexpectedApi,
    },
    tool: {
      hook: input.toolHook,
      transform: unexpectedApi,
      reload: unexpectedApi,
    },
    event: { subscribe: input.subscribe },
    get location() {
      return unexpectedApi();
    },
    get options() {
      return unexpectedApi();
    },
    get agent() {
      return unexpectedApi();
    },
    get aisdk() {
      return unexpectedApi();
    },
    get command() {
      return unexpectedApi();
    },
    get experimental() {
      return unexpectedApi();
    },
    get integration() {
      return unexpectedApi();
    },
    get mcp() {
      return unexpectedApi();
    },
    get model() {
      return unexpectedApi();
    },
    get generate() {
      return unexpectedApi();
    },
    get permission() {
      return unexpectedApi();
    },
    get plugin() {
      return unexpectedApi();
    },
    get provider() {
      return unexpectedApi();
    },
    get reference() {
      return unexpectedApi();
    },
    get rpc() {
      return unexpectedApi();
    },
    get shell() {
      return unexpectedApi();
    },
    get skill() {
      return unexpectedApi();
    },
    get storage() {
      return unexpectedApi();
    },
    get vcs() {
      return unexpectedApi();
    },
    get websearch() {
      return unexpectedApi();
    },
    get worktree() {
      return unexpectedApi();
    },
  } satisfies PluginContext;
}

async function createCollector() {
  const spans: (typeof SpanSchema.Type)[] = [];
  const collectorErrors: unknown[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("error", (error) => {
      collectorErrors.push(error);
    });
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const payload = Schema.decodeUnknownSync(PayloadSchema)(
          Buffer.concat(chunks).toString("utf8"),
        );
        spans.push(
          ...payload.resourceSpans.flatMap((resource) =>
            resource.scopeSpans.flatMap((scope) => scope.spans),
          ),
        );
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      } catch (error) {
        collectorErrors.push(error);
        response.writeHead(400);
        response.end("{}");
      }
    });
  });
  onTestFinished(async () => {
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    } finally {
      trace.disable();
      globalThis.langfuseOpencodeRuntimeState = undefined;
      vi.unstubAllEnvs();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP collector address");
  }
  vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-test");
  vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-test");
  vi.stubEnv(
    "LANGFUSE_BASE_URL",
    `http://127.0.0.1:${address.port.toString()}`,
  );
  vi.stubEnv("LANGFUSE_ENVIRONMENT", "integration-test");

  return { spans, collectorErrors };
}

const createHookRegistry = <Inputs extends object>() => {
  const hooks: {
    [Name in keyof Inputs]?: (input: Inputs[Name]) => Promise<void> | void;
  } = {};
  return {
    register: <Name extends keyof Inputs>(
      name: Name,
      handler: (input: Inputs[Name]) => Promise<void> | void,
    ) => {
      hooks[name] = handler;
      return Promise.resolve({
        dispose: () => {
          hooks[name] = undefined;
          return Promise.resolve();
        },
      });
    },
    run: async <Name extends keyof Inputs>(name: Name, input: Inputs[Name]) => {
      const handler = hooks[name];
      if (!handler) {
        throw new Error(`Expected hook ${String(name)}`);
      }
      await handler(input);
    },
  };
};

test("keeps V2 tool calls and observations with their calling generations despite late and duplicate hooks", async () => {
  const { spans, collectorErrors } = await createCollector();
  const sessionHooks = createHookRegistry<SessionHookInputs>();
  const toolHooks = createHookRegistry<ToolHookInputs>();
  const eventsFinished = Promise.withResolvers<undefined>();

  const sessionID =
    Schema.decodeUnknownSync(SessionIDSchema)("v2-parallel-tools");
  const assistantMessageID =
    Schema.decodeUnknownSync(MessageIDSchema)("v2-tool-generation");
  const followupMessageID =
    Schema.decodeUnknownSync(MessageIDSchema)("v2-followup");
  const followupCallID = CallID.make("v2-followup-call");
  const agent = Agent.ID.make("build");
  const model = {
    id: Model.ID.make("test-model"),
    providerID: Provider.ID.make("test-provider"),
  };
  const tokens = {
    input: 10,
    output: 5,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  };
  const calls = [
    {
      id: CallID.make("v2-call-first"),
      path: "first.txt",
      content: "First\nresponse",
      status: "completed" as const,
    },
    {
      id: CallID.make("v2-call-second"),
      path: "second.txt",
      content: "Second\n\nresponse",
      status: "completed" as const,
    },
    {
      id: CallID.make("v2-call-missing"),
      path: "missing.txt",
      content: "ENOENT: missing.txt",
      status: "error" as const,
    },
  ];
  const results = calls.map((call) => ({
    role: "tool",
    name: "read",
    tool_call_id: call.id,
    content: call.content,
  }));
  const messages = [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "Read three files" }],
    },
    {
      role: "assistant" as const,
      content: [
        { type: "reasoning" as const, text: "Need the files" },
        { type: "text" as const, text: "Reading first. " },
        { type: "text" as const, text: "Reading the rest." },
        ...calls.map((call) => ({
          type: "tool-call" as const,
          id: call.id,
          name: "read",
          input: { path: call.path },
          providerExecuted: false,
        })),
      ],
    },
    ...calls.map((call) => ({
      role: "tool" as const,
      content: [
        {
          type: "tool-result" as const,
          id: call.id,
          name: "read",
          result: {
            type: (
              {
                completed: "text",
                error: "error",
              } as const satisfies Record<
                (typeof calls)[number]["status"],
                "text" | "error"
              >
            )[call.status],
            value: call.content,
          },
        },
      ],
    })),
  ] satisfies SessionHookInputs["context"]["messages"];
  const exportedMessages = [
    messages[0],
    {
      role: "assistant",
      content: [
        ...messages[1].content.slice(0, 3),
        ...calls.map((call) => ({
          type: "tool-call",
          toolCallId: call.id,
          toolName: "read",
          input: { path: call.path },
          providerExecuted: false,
        })),
      ],
    },
    ...calls.map((call) => ({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: call.id,
          toolName: "read",
          output: {
            type: call.status === "error" ? "error-text" : "text",
            value: call.content,
          },
          ...(call.status === "error" ? { isError: true } : {}),
        },
      ],
    })),
  ];
  const contextInput = createPluginContext({
    sessionHook: sessionHooks.register,
    toolHook: toolHooks.register,
    subscribe: () => ({
      async *[Symbol.asyncIterator]() {
        try {
          await sessionHooks.run("prompt", {
            sessionID,
            messageID: Schema.decodeUnknownSync(MessageIDSchema)("v2-user"),
            prompt: { text: "Read three files" },
            delivery: "steer",
          });
          yield {
            id: "v2-tools-started",
            durable: { aggregateID: sessionID, seq: 1, version: 1 as const },
            type: "session.step.started",
            created: Date.now(),
            data: { sessionID, assistantMessageID, agent, model },
          };
          yield {
            id: "v2-reasoning-ended",
            durable: { aggregateID: sessionID, seq: 2, version: 1 as const },
            type: "session.reasoning.ended",
            created: Date.now(),
            data: {
              sessionID,
              assistantMessageID,
              ordinal: 0,
              text: "Need the files",
            },
          };
          for (const text of ["Reading first. ", "Reading the rest."]) {
            yield {
              id: `v2-text-ended-${text}`,
              durable: {
                aggregateID: sessionID,
                seq: 3,
                version: 1 as const,
              },
              type: "session.text.ended",
              created: Date.now(),
              data: {
                sessionID,
                assistantMessageID,
                ordinal: text === "Reading first. " ? 1 : 2,
                text,
              },
            };
          }
          for (const call of calls) {
            yield {
              id: `v2-input-started-${call.id}`,
              durable: {
                aggregateID: sessionID,
                seq: 4,
                version: 1 as const,
              },
              type: "session.tool.input.started",
              created: Date.now(),
              data: {
                sessionID,
                assistantMessageID,
                id: call.id,
                name: "read",
              },
            };
            yield {
              id: `v2-called-${call.id}`,
              durable: {
                aggregateID: sessionID,
                seq: 5,
                version: 1 as const,
              },
              type: "session.tool.called",
              created: Date.now(),
              data: {
                sessionID,
                assistantMessageID,
                id: call.id,
                input: { path: call.path },
                executed: false,
              },
            };
            if (call.status === "error") {
              continue;
            }
            await toolHooks.run("execute.before", {
              sessionID,
              messageID: assistantMessageID,
              agent,
              tool: "read",
              id: call.id,
              input: { path: call.path },
            });
          }
          // Same names and reversed completions must still match by call ID.
          for (const call of [...calls].reverse()) {
            if (call.status === "error") {
              continue;
            }
            const input = {
              sessionID,
              messageID: assistantMessageID,
              agent,
              tool: "read",
              id: call.id,
              input: { path: call.path },
            };
            const result = {
              ...input,
              status: "completed",
              result: {
                content:
                  call.id === "v2-call-second"
                    ? [
                        { type: "text", text: "Second" },
                        { type: "text", text: "response" },
                      ]
                    : call.content,
              },
            } satisfies Parameters<ToolHook>[0];
            await toolHooks.run("execute.after", result);
            await toolHooks.run("execute.after", result);
          }
          yield {
            id: "v2-tools-ended",
            durable: { aggregateID: sessionID, seq: 2, version: 1 as const },
            type: "session.step.ended",
            created: Date.now(),
            data: {
              sessionID,
              assistantMessageID,
              finish: "tool-calls",
              cost: 0,
              tokens,
            },
          };
          await sessionHooks.run("context", {
            sessionID,
            agent,
            model,
            system: [],
            messages,
            options: {},
            tools: {},
          });
          yield {
            id: "v2-followup-started",
            durable: { aggregateID: sessionID, seq: 3, version: 1 as const },
            type: "session.step.started",
            created: Date.now(),
            data: {
              sessionID,
              assistantMessageID: followupMessageID,
              agent,
              model,
            },
          };
          // A late first-generation hook must not attach to the active followup.
          for (const call of calls.filter((call) => call.status === "error")) {
            const input = {
              sessionID,
              messageID: assistantMessageID,
              agent,
              tool: "read",
              id: call.id,
              input: { path: call.path },
            };
            await toolHooks.run("execute.before", input);
            await toolHooks.run("execute.before", input);
            const result = {
              ...input,
              status: "error" as const,
              error: new ToolError({ message: call.content }),
            };
            await toolHooks.run("execute.after", result);
            await toolHooks.run("execute.after", result);
            yield {
              id: `v2-late-called-${call.id}`,
              durable: {
                aggregateID: sessionID,
                seq: 6,
                version: 1 as const,
              },
              type: "session.tool.called",
              created: Date.now(),
              data: {
                sessionID,
                assistantMessageID,
                id: call.id,
                input: { path: call.path },
                executed: false,
              },
            };
          }
          yield {
            id: "v2-followup-input-started",
            durable: { aggregateID: sessionID, seq: 7, version: 1 as const },
            type: "session.tool.input.started",
            created: Date.now(),
            data: {
              sessionID,
              assistantMessageID: followupMessageID,
              id: followupCallID,
              name: "bash",
            },
          };
          for (let repeat = 0; repeat < 2; repeat++) {
            yield {
              id: "v2-followup-called",
              durable: {
                aggregateID: sessionID,
                seq: 8,
                version: 1 as const,
              },
              type: "session.tool.called",
              created: Date.now(),
              data: {
                sessionID,
                assistantMessageID: followupMessageID,
                id: followupCallID,
                input: { command: "pwd" },
                executed: false,
              },
            };
          }
          yield {
            id: "v2-followup-ended",
            durable: { aggregateID: sessionID, seq: 4, version: 1 as const },
            type: "session.step.ended",
            created: Date.now(),
            data: {
              sessionID,
              assistantMessageID: followupMessageID,
              finish: "tool-calls",
              cost: 0,
              tokens,
            },
          };
          const followupToolInput = {
            sessionID,
            messageID: followupMessageID,
            agent,
            tool: "bash",
            id: followupCallID,
            input: { command: "pwd" },
          };
          await toolHooks.run("execute.before", followupToolInput);
          await toolHooks.run("execute.before", followupToolInput);
          const followupToolResult = {
            ...followupToolInput,
            status: "completed" as const,
            result: { content: "/project" },
          };
          await toolHooks.run("execute.after", followupToolResult);
          await toolHooks.run("execute.after", followupToolResult);
          yield {
            id: "v2-execution-succeeded",
            durable: { aggregateID: sessionID, seq: 5, version: 1 as const },
            type: "session.execution.succeeded",
            created: Date.now(),
            data: { sessionID },
          };
        } finally {
          eventsFinished.resolve(undefined);
        }
      },
    }),
  });
  // This mock host does not prove compatibility with a running OpenCode server.
  const cleanup = await LangfusePlugin.setup(contextInput);
  if (!cleanup) {
    throw new Error("Expected plugin cleanup");
  }
  onTestFinished(cleanup);
  await eventsFinished.promise;

  expect(collectorErrors).toEqual([]);
  const tools = spans.filter((span) => span.name === "read");
  expect(tools).toHaveLength(calls.length);
  const generations = spans.filter(
    (span) => span.name === "opencode.generation",
  );
  expect(generations).toHaveLength(2);
  const generation = generations.find((span) => {
    const metadata = getJsonAttribute(span, "langfuse.observation.metadata");
    return (
      typeof metadata === "object" &&
      metadata !== null &&
      "messageID" in metadata &&
      metadata.messageID === assistantMessageID
    );
  });
  const followup = generations.find((span) => span !== generation);
  if (!generation || !followup) {
    throw new Error("Expected both generations");
  }
  expect(getJsonAttribute(generation, "langfuse.observation.output")).toEqual([
    exportedMessages[1],
  ]);
  expect(
    getJsonAttribute(followup, "langfuse.observation.metadata"),
  ).toMatchObject({ messageID: followupMessageID });
  expect(getJsonAttribute(followup, "langfuse.observation.output")).toEqual([
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: followupCallID,
          toolName: "bash",
          input: { command: "pwd" },
          providerExecuted: false,
        },
      ],
    },
  ]);
  const followupTools = spans.filter((span) => span.name === "bash");
  expect(followupTools).toHaveLength(1);
  expect(followupTools[0].parentSpanId).toBe(followup.spanId);
  expect(
    getJsonAttribute(followupTools[0], "langfuse.observation.output"),
  ).toEqual({
    role: "tool",
    name: "bash",
    tool_call_id: followupCallID,
    content: "/project",
  });
  for (const [index, call] of calls.entries()) {
    const tool = tools.find((span) => {
      const output = getJsonAttribute(span, "langfuse.observation.output");
      return (
        typeof output === "object" &&
        output !== null &&
        "tool_call_id" in output &&
        output.tool_call_id === call.id
      );
    });
    if (!tool) {
      throw new Error(`Expected response for ${call.id}`);
    }
    expect(getJsonAttribute(tool, "langfuse.observation.output")).toEqual(
      results[index],
    );
    expect(tool.parentSpanId).toBe(generation.spanId);
    expect(getJsonAttribute(tool, "langfuse.observation.metadata")).toEqual({
      callID: call.id,
      tool: "read",
    });
    if (call.status === "error") {
      expect(tool.status).toEqual({ code: 2, message: call.content });
    }
  }
  expect(getJsonAttribute(followup, "langfuse.observation.input")).toEqual({
    system: [],
    messages: exportedMessages,
    tools: [],
  });
});

test("omits V2 cost_details when OpenCode reports zero cost", async () => {
  const { spans, collectorErrors } = await createCollector();
  const sessionID = Schema.decodeUnknownSync(SessionIDSchema)("v2-zero-cost");
  const assistantMessageID = Schema.decodeUnknownSync(MessageIDSchema)(
    "v2-zero-cost-assistant",
  );
  const tokens = {
    input: 10,
    output: 5,
    reasoning: 2,
    cache: { read: 3, write: 1 },
  };
  const eventsFinished = Promise.withResolvers<undefined>();
  const registration = { dispose: () => Promise.resolve() };
  const sessionHooks = createHookRegistry<SessionHookInputs>();
  const context = createPluginContext({
    sessionHook: sessionHooks.register,
    toolHook: () => Promise.resolve(registration),
    subscribe: () => ({
      async *[Symbol.asyncIterator]() {
        try {
          await sessionHooks.run("prompt", {
            sessionID,
            messageID:
              Schema.decodeUnknownSync(MessageIDSchema)("v2-zero-cost-user"),
            prompt: {
              text: "Use a custom provider without OpenCode cost config",
            },
            delivery: "steer",
          });
          yield {
            id: "v2-zero-cost-started",
            durable: { aggregateID: sessionID, seq: 1, version: 1 as const },
            type: "session.step.started",
            created: Date.now(),
            data: {
              sessionID,
              assistantMessageID,
              agent: Agent.ID.make("build"),
              model: {
                id: Model.ID.make("custom-model"),
                providerID: Provider.ID.make("custom-provider"),
              },
            },
          };
          yield {
            id: "v2-zero-cost-ended",
            durable: { aggregateID: sessionID, seq: 2, version: 1 as const },
            type: "session.step.ended",
            created: Date.now(),
            data: {
              sessionID,
              assistantMessageID,
              finish: "stop",
              cost: 0,
              tokens,
            },
          };
          yield {
            id: "v2-zero-cost-succeeded",
            durable: { aggregateID: sessionID, seq: 3, version: 1 as const },
            type: "session.execution.succeeded",
            created: Date.now(),
            data: { sessionID },
          };
        } finally {
          eventsFinished.resolve(undefined);
        }
      },
    }),
  });

  const cleanup = await LangfusePlugin.setup(context);
  if (!cleanup) {
    throw new Error("Expected plugin cleanup");
  }
  onTestFinished(cleanup);
  await eventsFinished.promise;

  expect(collectorErrors).toEqual([]);
  const generations = spans.filter(
    (span) => span.name === "opencode.generation",
  );
  expect(generations).toHaveLength(1);
  expect(
    getJsonAttribute(generations[0], "langfuse.observation.usage_details"),
  ).toEqual({
    input: 10,
    output: 5,
    reasoning: 2,
    cache_read: 3,
    cache_write: 1,
    total: 17,
  });
  expect(
    generations[0].attributes.map((attribute) => attribute.key),
  ).not.toContain("langfuse.observation.cost_details");
});
