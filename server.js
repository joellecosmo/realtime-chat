const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");
const clients = new Map();

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

        if (data.type === "register") {
            clients.set(data.username, socket);
            console.log(`${data.username} registered`);
            return;
        }

        if (data.type === "message") {
            const recipient = clients.get(data.to);

            if (recipient && recipient.readyState === WebSocket.OPEN) {
                recipient.send(JSON.stringify({
                    from: data.from,
                    body: data.body
                }));
            }
        }
    });

    socket.on("close", () => {
        for (const [username, client] of clients) {
            if (client === socket) {
                clients.delete(username);
                console.log(`${username} disconnected`);
            }
        }
    });
});


server.listen(3000, () => {
    console.log("Server running at http://localhost:3000");
});
