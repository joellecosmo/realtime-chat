const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const WebSocket = require("ws");

function createApp() {
    // Each application instance has its own state
    const clients = new Map();
    const pendingMessages = new Map();

    const server = http.createServer((req, res) => {
        const filePath = path.join(__dirname, "index.html");

        res.writeHead(200, {
            "Content-Type": "text/html"
        });

        fs.createReadStream(filePath).pipe(res);
    });

    const wss = new WebSocket.Server({ server });

    wss.on("connection", (socket) => {
        console.log("New client connected");

        socket.on("message", (rawMessage) => {
            let data;

            try {
                data = JSON.parse(rawMessage.toString());
            } catch {
                console.log("Invalid JSON received");
                return;
            }

            // Register a new user
            if (data.type === "register") {
                const alreadyRegistered = [...clients.values()]
                    .includes(socket);

                if (alreadyRegistered) {
                    socket.send(JSON.stringify({
                        type: "error",
                        message: "This connection is already registered"
                    }));
                    return;
                }

                if (
                    typeof data.username !== "string" ||
                    !data.username.trim()
                ) {
                    socket.send(JSON.stringify({
                        type: "error",
                        message: "A valid username is required"
                    }));
                    return;
                }

                const username = data.username.trim();

                if (clients.has(username)) {
                    socket.send(JSON.stringify({
                        type: "error",
                        message: "Username is already taken"
                    }));
                    return;
                }

                clients.set(username, socket);

                socket.send(JSON.stringify({
                    type: "registered",
                    username
                }));

                console.log(`${username} registered`);
                return;
            }

            // Forward a message to the intended recipient
            if (data.type === "message") {
                const sender = [...clients.entries()]
                    .find(([username, client]) => client === socket)?.[0];

                if (!sender) {
                    socket.send(JSON.stringify({
                        type: "error",
                        message: "You must register before sending messages"
                    }));
                    return;
                }

                const recipient = clients.get(data.to);

                if (!recipient || recipient.readyState !== WebSocket.OPEN) {
                    socket.send(JSON.stringify({
                        type: "delivery_failed",
                        message: `User ${data.to} is offline`
                    }));
                    return;
                }

                const messageId = randomUUID();

                // Start a timeout while waiting for an ACK
                const timeout = setTimeout(() => {
                    const pending = pendingMessages.get(messageId);

                    if (!pending) {
                        return;
                    }

                    pendingMessages.delete(messageId);

                    if (pending.senderSocket.readyState === WebSocket.OPEN) {
                        pending.senderSocket.send(JSON.stringify({
                            type: "delivery_timeout",
                            messageId
                        }));
                    }
                }, 10000);

                // Remember who sent the message and who should ACK it
                pendingMessages.set(messageId, {
                    senderSocket: socket,
                    recipientSocket: recipient,
                    timeout
                });

                recipient.send(JSON.stringify({
                    type: "message",
                    messageId,
                    from: sender,
                    body: data.body
                }));

                socket.send(JSON.stringify({
                    type: "message_sent",
                    to: data.to
                }));

                return;
            }

            // Handle a delivery acknowledgment from the recipient
            if (data.type === "ack") {
                const pending = pendingMessages.get(data.messageId);

                if (!pending) {
                    return;
                }

                // Only the intended recipient can ACK this message
                if (pending.recipientSocket !== socket) {
                    return;
                }

                clearTimeout(pending.timeout);
                pendingMessages.delete(data.messageId);

                // Notify the original sender
                if (pending.senderSocket.readyState === WebSocket.OPEN) {
                    pending.senderSocket.send(JSON.stringify({
                        type: "delivered",
                        messageId: data.messageId
                    }));
                }

                return;
            }
        });

        socket.on("close", () => {
            // Remove the disconnected user
            for (const [username, client] of clients) {
                if (client === socket) {
                    clients.delete(username);
                    console.log(`${username} disconnected`);
                }
            }

            // Clean up messages associated with this connection
            for (const [messageId, pending] of pendingMessages) {
                if (
                    pending.senderSocket !== socket &&
                    pending.recipientSocket !== socket
                ) {
                    continue;
                }

                clearTimeout(pending.timeout);
                pendingMessages.delete(messageId);

                // Notify the sender if the recipient disconnected
                if (
                    pending.recipientSocket === socket &&
                    pending.senderSocket.readyState === WebSocket.OPEN
                ) {
                    pending.senderSocket.send(JSON.stringify({
                        type: "delivery_failed",
                        message: "Recipient disconnected before delivery was confirmed"
                    }));
                }
            }
        });
    });

    // Return independent server instances for testing
    return { server, wss };
}

// Start the application only when this file is executed directly
if (require.main === module) {
    const { server } = createApp();

    server.listen(3000, () => {
        console.log("Server running at http://localhost:3000");
    });
}

module.exports = { createApp };
