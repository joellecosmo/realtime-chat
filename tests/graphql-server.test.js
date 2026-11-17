
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createClient } = require("graphql-ws");
const WebSocket = require("ws");

const { createGraphQLApp } = require("../graphql-server");

let app;
let baseUrl;

before(async () => {
    app = createGraphQLApp();

    await new Promise((resolve) => {
        app.server.listen(0, "127.0.0.1", resolve);
    });

    const port = app.server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
    await app.wsCleanup.dispose();

    await new Promise((resolve, reject) => {
        app.server.close((error) => {
            if (error) reject(error);
            else resolve();
        });
    });
});

// Send a GraphQL request over HTTP.
async function executeGraphQL(query, variables) {
    const response = await fetch(`${baseUrl}/graphql`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ query, variables })
    });

    return {
        status: response.status,
        body: await response.json()
    };
}

// Wait for an asynchronous condition with a timeout.
async function waitFor(predicate, timeout = 2000) {
    const deadline = Date.now() + timeout;

    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error("Timed out waiting for condition");
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

// Create a GraphQL WebSocket client.
function createSubscriptionClient() {
    return createClient({
        url: baseUrl.replace("http:", "ws:") + "/graphql",
        webSocketImpl: WebSocket,
        retryAttempts: 0
    });
}

// HTTP TESTS

test("health query returns OK", async () => {
    const response = await executeGraphQL(`
        query {
            health
        }
    `);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
        data: {
            health: "OK"
        }
    });
});

test("sendMessage mutation returns a message", async () => {
    const response = await executeGraphQL(`
        mutation {
            sendMessage(
                to: "Bob"
                body: "Hello Bob!"
            ) {
                id
                from
                to
                body
                sentAt
            }
        }
    `);

    assert.equal(response.status, 200);
    assert.equal(response.body.errors, undefined);

    const message = response.body.data.sendMessage;

    assert.ok(message.id);
    assert.equal(message.from, "DemoSender");
    assert.equal(message.to, "Bob");
    assert.equal(message.body, "Hello Bob!");
    assert.ok(!Number.isNaN(Date.parse(message.sentAt)));
});

test("invalid GraphQL query returns validation errors", async () => {
    const response = await executeGraphQL(`
        query {
            nonexistentField
        }
    `);

    assert.equal(response.status, 200);
    assert.ok(response.body.errors);
    assert.match(
        response.body.errors[0].message,
        /Cannot query field/
    );
});

test("unknown HTTP endpoint returns 404", async () => {
    const response = await fetch(`${baseUrl}/unknown`, {
        method: "POST"
    });

    assert.equal(response.status, 404);
    assert.equal(await response.text(), "Not Found");
});

// WEBSOCKET SUBSCRIPTION TESTS

test("subscription delivers messages only to the intended recipient", {
    timeout: 5000
}, async () => {
    const received = [];
    const initialListeners = app.events.listenerCount("message");

    const client = createSubscriptionClient();
    let subscriptionError;

    const unsubscribe = client.subscribe(
        {
            query: `
                subscription {
                    onMessage(to: "Bob") {
                        id
                        to
                        body
                    }
                }
            `
        },
        {
            next: (result) => received.push(result),
            error: (error) => {
                subscriptionError = error;
            },
            complete: () => {}
        }
    );

    try {
        // Wait until Bob's subscription is registered.
        await waitFor(() =>
            app.events.listenerCount("message") === initialListeners + 1 ||
            subscriptionError !== undefined
        );

        if (subscriptionError) {
            throw new Error(String(subscriptionError));
        }

        // Send a message to Bob.
        const bobResponse = await executeGraphQL(`
            mutation {
                sendMessage(to: "Bob", body: "Hello Bob!") {
                    id
                }
            }
        `);

        assert.equal(bobResponse.status, 200);
        assert.equal(bobResponse.body.errors, undefined);

        // Wait for Bob to receive it.
        await waitFor(() =>
            received.length > 0 ||
            subscriptionError !== undefined
        );

        if (subscriptionError) {
            throw new Error(String(subscriptionError));
        }

        assert.equal(received.length, 1);

        const message = received[0].data.onMessage;

        assert.equal(message.to, "Bob");
        assert.equal(message.body, "Hello Bob!");
        assert.equal(
            message.id,
            bobResponse.body.data.sendMessage.id
        );

        // Send a message to Charlie.
        const charlieResponse = await executeGraphQL(`
            mutation {
                sendMessage(to: "Charlie", body: "Hello Charlie!") {
                    id
                }
            }
        `);

        assert.equal(charlieResponse.status, 200);
        assert.equal(charlieResponse.body.errors, undefined);

        // Check that Bob did not receive Charlie's message.
        await new Promise((resolve) => setTimeout(resolve, 150));

        assert.equal(subscriptionError, undefined);
        assert.equal(received.length, 1);
    } finally {
        unsubscribe();
        await client.dispose();

        await waitFor(() =>
            app.events.listenerCount("message") === initialListeners
        );
    }
});

test("subscription removes its listener after disconnect", {
    timeout: 5000
}, async () => {
    const initialListeners = app.events.listenerCount("message");

    const client = createSubscriptionClient();
    let subscriptionError;

    const unsubscribe = client.subscribe(
        {
            query: `
                subscription {
                    onMessage(to: "Bob") {
                        id
                    }
                }
            `
        },
        {
            next: () => {},
            error: (error) => {
                subscriptionError = error;
            },
            complete: () => {}
        }
    );

    try {
        // Verify that the subscription creates a listener.
        await waitFor(() =>
            app.events.listenerCount("message") === initialListeners + 1 ||
            subscriptionError !== undefined
        );

        if (subscriptionError) {
            throw new Error(String(subscriptionError));
        }

        assert.equal(
            app.events.listenerCount("message"),
            initialListeners + 1
        );
    } finally {
        unsubscribe();
        await client.dispose();
    }

    // Verify that disconnecting removes the listener.
    await waitFor(() =>
        app.events.listenerCount("message") === initialListeners
    );

    assert.equal(
        app.events.listenerCount("message"),
        initialListeners
    );
});
