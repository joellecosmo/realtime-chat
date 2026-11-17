const { createClient } = require("graphql-ws");
const WebSocket = require("ws");
const username = process.argv[2] || "Bob";

const client = createClient({
    url: "ws://127.0.0.1:4000/graphql",
    webSocketImpl: WebSocket,
    retryAttempts: 0,

    on: {
        connected: () => {
            console.log("Connected to GraphQL WebSocket server!");
            console.log(`Listening for ${username}'s messages...`);
        }
    }
});


client.subscribe(
    {
        query: `
            subscription ReceiveMessages($recipient: String!) {
                onMessage(to: $recipient) {
                    id
                    from
                    body
                    sentAt
                }
            }
        `,
        variables: {
            recipient: username
        }
    },
    {
        next: (result) => {
            console.log("New subscription event:");
            console.log(JSON.stringify(result, null, 2));
        },

        error: (error) => {
            console.error("Subscription error:", error);
        },

        complete: () => {
            console.log("Subscription completed");
        }
    }
);


process.on("SIGINT", () => {
    console.log("\nClosing subscription...");
    client.dispose();
});
