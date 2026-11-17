const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { buildSchema, graphql } = require("graphql");
const { WebSocketServer } = require("ws");
const { useServer } = require("graphql-ws/lib/use/ws");
const { EventEmitter } = require("node:events");

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

const schema = buildSchema(appSyncDefinitions + schemaSource);
const events = new EventEmitter();


async function* messageEvents(recipient) {
    const queue = [];
    let wakeUp;

    const onMessage = (message) => {
        if (message.to !== recipient) {
            return;
        }

        queue.push({ onMessage: message });

        if (wakeUp) {
            wakeUp();
            wakeUp = null;
        }
    };

    events.on("message", onMessage);

    try {
        while (true) {
            if (queue.length === 0) {
                await new Promise((resolve) => {
                    wakeUp = resolve;
                });
            }

            while (queue.length > 0) {
                yield queue.shift();
            }
        }
    } finally {
        events.off("message", onMessage);
    }
}


schema.getSubscriptionType()
    .getFields()
    .onMessage.subscribe = (_, args) => {
        return messageEvents(args.to);
    };


// Local GraphQL resolvers

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

        // Publish message to matching subscribers
        events.emit("message", message);

        return message;
    }
};


const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/graphql") {
        res.writeHead(404);
        res.end("Not Found");
        return;
    }

    let body = "";

    for await (const chunk of req) {
        body += chunk;
    }

    try {
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

const wsServer = new WebSocketServer({
    server,
    path: "/graphql"
});

useServer({
    schema
}, wsServer);

server.listen(4000, "127.0.0.1", () => {
    console.log("GraphQL HTTP API: http://localhost:4000/graphql");
    console.log("GraphQL WebSocket API: ws://localhost:4000/graphql");
});