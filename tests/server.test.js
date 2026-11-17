const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");

const { createApp } = require("../server");



function waitForMessage(client, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("Timed out waiting for WebSocket message"));
        }, timeoutMs);

        function cleanup() {
            clearTimeout(timeout);
            client.off("message", onMessage);
            client.off("error", onError);
            client.off("close", onClose);
        }

        function onMessage(rawMessage) {
            cleanup();

            try {
                resolve(JSON.parse(rawMessage.toString()));
            } catch (error) {
                reject(error);
            }
        }

        function onError(error) {
            cleanup();
            reject(error);
        }

        function onClose() {
            cleanup();
            reject(new Error("WebSocket closed before message arrived"));
        }

        client.once("message", onMessage);
        client.once("error", onError);
        client.once("close", onClose);
    });
}


async function connectClient(url, username) {
    const client = new WebSocket(url);

    await new Promise((resolve, reject) => {
        client.once("open", resolve);
        client.once("error", reject);
    });

    const response = waitForMessage(client);

    client.send(JSON.stringify({
        type: "register",
        username
    }));

    assert.equal((await response).type, "registered");

    return client;
}


test("client can establish a WebSocket connection", async () => {
    const { server, wss } = createApp();
    // Start the server on a randomly available port
    await new Promise((resolve) => server.listen(0, resolve));

    const port = server.address().port;
    const client = new WebSocket(`ws://127.0.0.1:${port}`);

    try {
        // Wait for the WebSocket connection to open
        await new Promise((resolve, reject) => {
            client.once("open", resolve);
            client.once("error", reject);
        });

        assert.equal(client.readyState, WebSocket.OPEN);
    } finally {
        client.close();

        await new Promise((resolve) => {
            wss.close(() => {
                server.close(resolve);
            });
        });
    }
});

test("duplicate usernames are rejected", async () => {
    const { server, wss } = createApp();
    await new Promise((resolve) => server.listen(0, resolve));

    const port = server.address().port;
    const url = `ws://127.0.0.1:${port}`;

    const alice1 = new WebSocket(url);
    const alice2 = new WebSocket(url);

    try {
        await Promise.all([
            new Promise((resolve, reject) => {
                alice1.once("open", resolve);
                alice1.once("error", reject);
            }),
            new Promise((resolve, reject) => {
                alice2.once("open", resolve);
                alice2.once("error", reject);
            })
        ]);

        // Register the first Alice
        const firstResponse = new Promise((resolve) => {
            alice1.once("message", (data) => {
                resolve(JSON.parse(data.toString()));
            });
        });

        alice1.send(JSON.stringify({
            type: "register",
            username: "Alice"
        }));

        assert.equal((await firstResponse).type, "registered");

        // Attempt to register a second Alice
        const secondResponse = new Promise((resolve) => {
            alice2.once("message", (data) => {
                resolve(JSON.parse(data.toString()));
            });
        });

        alice2.send(JSON.stringify({
            type: "register",
            username: "Alice"
        }));

        const result = await secondResponse;

        assert.equal(result.type, "error");
        assert.equal(result.message, "Username is already taken");

    } finally {
        alice1.close();
        alice2.close();

        await new Promise((resolve) => {
            wss.close(() => {
                server.close(resolve);
            });
        });
    }
});


test("messages are sent only to their intended recipient", async () => {
    const { server, wss } = createApp();

    await new Promise((resolve) => server.listen(0, resolve));

    const port = server.address().port;
    const url = `ws://127.0.0.1:${port}`;

    const clients = [];

    try {
        const alice = await connectClient(url, "Alice");
        clients.push(alice);

        const bob = await connectClient(url, "Bob");
        clients.push(bob);

        const charlie = await connectClient(url, "Charlie");
        clients.push(charlie);

        let charlieReceivedMessage = false;

        charlie.on("message", () => {
            charlieReceivedMessage = true;
        });

        // Listen before sending, so we don't miss the response
        const bobMessage = waitForMessage(bob);

        alice.send(JSON.stringify({
            type: "message",
            to: "Bob",
            body: "Hello Bob!"
        }));

        const received = await bobMessage;

        assert.equal(received.type, "message");
        assert.equal(received.from, "Alice");
        assert.equal(received.body, "Hello Bob!");

        // Allow time for an unexpected message to arrive
        await new Promise((resolve) => setTimeout(resolve, 100));

        assert.equal(charlieReceivedMessage, false);

        // Acknowledge Bob's message so it isn't left pending
        bob.send(JSON.stringify({
            type: "ack",
            messageId: received.messageId
        }));

    } finally {
        for (const client of clients) {
            client.close();
        }

        await new Promise((resolve) => {
            wss.close(() => {
                server.close(resolve);
            });
        });
    }
});


test("sender receives delivery confirmation after recipient ACK", async () => {
    const { server, wss } = createApp();

    await new Promise((resolve) => server.listen(0, resolve));

    const url = `ws://127.0.0.1:${server.address().port}`;
    const clients = [];

    try {
        const alice = await connectClient(url, "Alice");
        clients.push(alice);

        const bob = await connectClient(url, "Bob");
        clients.push(bob);

        const bobMessage = waitForMessage(bob);
        const aliceSent = waitForMessage(alice);

        alice.send(JSON.stringify({
            type: "message",
            to: "Bob",
            body: "Hello Bob!"
        }));

        const message = await bobMessage;
        const sent = await aliceSent;

        assert.equal(message.type, "message");
        assert.equal(sent.type, "message_sent");
        assert.ok(message.messageId);

        // Listen before sending the acknowledgment
        const aliceDelivered = waitForMessage(alice);

        bob.send(JSON.stringify({
            type: "ack",
            messageId: message.messageId
        }));

        const delivered = await aliceDelivered;

        assert.equal(delivered.type, "delivered");
        assert.equal(delivered.messageId, message.messageId);

    } finally {
        for (const client of clients) {
            client.close();
        }

        await new Promise((resolve) => {
            wss.close(() => {
                server.close(resolve);
            });
        });
    }
});

test("sending to an offline recipient returns delivery_failed", async () => {
    const { server, wss } = createApp();

    await new Promise((resolve) => server.listen(0, resolve));

    const url = `ws://127.0.0.1:${server.address().port}`;
    let alice;

    try {
        alice = await connectClient(url, "Alice");

        // Bob is deliberately not connected
        const response = waitForMessage(alice);

        alice.send(JSON.stringify({
            type: "message",
            to: "Bob",
            body: "Hello Bob!"
        }));

        const result = await response;

        assert.equal(result.type, "delivery_failed");
        assert.equal(result.message, "User Bob is offline");

    } finally {
        if (alice) {
            alice.close();
        }

        await new Promise((resolve) => {
            wss.close(() => {
                server.close(resolve);
            });
        });
    }
});
