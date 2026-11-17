
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { buildSchema, graphql, parse, subscribe } = require("graphql");

const schemaSource = fs.readFileSync(
    "graphql/schema.graphql",
    "utf8"
);

const appSyncDefinitions = `
    scalar AWSDateTime

    directive @aws_subscribe(
        mutations: [String!]!
    ) on FIELD_DEFINITION
`;

const schema = buildSchema(appSyncDefinitions + schemaSource);

// Our local event publisher
const events = new EventEmitter();

// Create an event stream for one recipient
async function* messageEvents(recipient) {
    const queue = [];
    let wakeUp;

    const onMessage = (message) => {
        if (message.to !== recipient) return;

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

// Tell GraphQL how to subscribe to events
schema.getSubscriptionType()
    .getFields()
    .onMessage.subscribe = (_, args) => {
        return messageEvents(args.to);
    };

// Local mutation resolver
const rootValue = {
    sendMessage: ({ to, body }) => {
        const message = {
            id: randomUUID(),
            from: "Alice",
            to,
            body,
            sentAt: new Date().toISOString()
        };

        // Publish the event
        events.emit("message", message);

        return message;
    }
};

async function main() {
    // Bob subscribes first
    const subscription = await subscribe({
        schema,
        document: parse(`
            subscription {
                onMessage(to: "Bob") {
                    from
                    body
                }
            }
        `)
    });

    if (!subscription[Symbol.asyncIterator]) {
        throw new Error(JSON.stringify(subscription.errors));
    }

    console.log("Bob subscribed to messages");

    // Start listening before Alice sends
    const nextMessage = subscription.next();

    // Alice executes a mutation
    const result = await graphql({
        schema,
        source: `
            mutation {
                sendMessage(to: "Charlie", body: "Hello Charlie!") {
                    id
                    body
                }
            }
        `,
        rootValue
    });

    console.log("Alice's mutation result:");
    console.log(JSON.stringify(result, null, 2));

    console.log("Sending another message, this time to Bob...");

    const secondResult = await graphql({
        schema,
        source: `
        mutation {
            sendMessage(to: "Bob", body: "Hello Bob!") {
                id
                body
            }
        }
    `,
        rootValue
    });

    console.log("Second mutation result:");
    console.log(JSON.stringify(secondResult, null, 2));

    // Bob receives the subscription event
    const received = await nextMessage;

    console.log("Bob's subscription result:");
    console.log(JSON.stringify(received.value, null, 2));

    // Stop listening
    await subscription.return();
}

main().catch(console.error);
