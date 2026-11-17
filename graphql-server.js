
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");

const { buildSchema, graphql } = require("graphql");
const { WebSocketServer } = require("ws");
const { useServer } = require("graphql-ws/lib/use/ws");

const schemaSource = fs.readFileSync(
    path.join(__dirname, "graphql", "schema.graphql"),
    "utf8"
);

const appSyncDefinitions = `
    scalar AWSDateTime

    directive @aws_subscribe(
        mutations: [String!]!
    ) on FIELD_DEFINITION
`;

function createGraphQLApp() {
    const schema = buildSchema(appSyncDefinitions + schemaSource);
    const events = new EventEmitter();

    // SUBSCRIPTION EVENT STREAM


    function messageEvents(recipient) {
        const queue = [];

        let resolveNext = null;
        let closed = false;

        const onMessage = (message) => {
            if (closed || message.to !== recipient) {
                return;
            }

            const result = {
                value: { onMessage: message },
                done: false
            };

            if (resolveNext) {
                const resolve = resolveNext;
                resolveNext = null;
                resolve(result);
            } else {
                queue.push(result);
            }
        };

        events.on("message", onMessage);

        return {
            next() {
                if (closed) {
                    return Promise.resolve({ done: true });
                }

                if (queue.length > 0) {
                    return Promise.resolve(queue.shift());
                }

                return new Promise((resolve) => {
                    resolveNext = resolve;
                });
            },

            return() {
                closed = true;

                // Remove the subscription's event listener.
                events.off("message", onMessage);

                // Discard messages that have not been delivered.
                queue.length = 0;

                // Release any pending next() call.
                if (resolveNext) {
                    const resolve = resolveNext;
                    resolveNext = null;
                    resolve({ done: true });
                }

                return Promise.resolve({ done: true });
            },

            [Symbol.asyncIterator]() {
                return this;
            }
        };
    }


    // SUBSCRIPTION RESOLVER

    schema.getSubscriptionType()
        .getFields()
        .onMessage.subscribe = (_, args) => {
            return messageEvents(args.to);
        };

    // QUERY AND MUTATION RESOLVERS

    const rootValue = {
        health: () => "OK",

        sendMessage: ({ to, body }) => {
            const message = {
                id: randomUUID(),
                from: "DemoSender",
                to,
                body,
                sentAt: new Date().toISOString()
            };

            // Publish the message to subscribers.
            events.emit("message", message);

            return message;
        }
    };

    // HTTP SERVER

    const server = http.createServer(async (req, res) => {
        if (req.method !== "POST" || req.url !== "/graphql") {
            res.writeHead(404);
            res.end("Not Found");
            return;
        }

        let body = "";

        try {
            for await (const chunk of req) {
                body += chunk;
            }

            const { query, variables, operationName } = JSON.parse(body);

            const result = await graphql({
                schema,
                source: query,
                rootValue,
                variableValues: variables,
                operationName
            });

            res.writeHead(200, {
                "Content-Type": "application/json"
            });

            res.end(JSON.stringify(result));
        } catch (error) {
            res.writeHead(400, {
                "Content-Type": "application/json"
            });

            res.end(JSON.stringify({
                errors: [{ message: error.message }]
            }));
        }
    });

    // WEBSOCKET SERVER

    const wsServer = new WebSocketServer({
        server,
        path: "/graphql"
    });

    const wsCleanup = useServer({
        schema
    }, wsServer);

    // EXPOSE APPLICATION COMPONENTS FOR TESTING

    return {
        server,
        wsServer,
        wsCleanup,
        events
    };
}

// START SERVER ONLY WHEN EXECUTED DIRECTLY

if (require.main === module) {
    const { server } = createGraphQLApp();

    server.listen(4000, "127.0.0.1", () => {
        console.log("GraphQL HTTP API: http://localhost:4000/graphql");
        console.log("GraphQL WebSocket API: ws://localhost:4000/graphql");
    });
}

module.exports = { createGraphQLApp };