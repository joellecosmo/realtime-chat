const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { buildSchema, graphql } = require("graphql");

// Load our GraphQL schema
const schemaSource = fs.readFileSync(
    "graphql/schema.graphql",
    "utf8"
);

// Define AppSync-specific types for local use
const appSyncDefinitions = `
    scalar AWSDateTime

    directive @aws_subscribe(
        mutations: [String!]!
    ) on FIELD_DEFINITION
`;

const schema = buildSchema(
    appSyncDefinitions + schemaSource
);

// Local resolver implementation
const rootValue = {
    sendMessage: ({ to, body }) => {
        return {
            id: randomUUID(),
            from: "Alice",
            to,
            body,
            sentAt: new Date().toISOString()
        };
    }
};

// Execute our mutation
async function main() {
    const result = await graphql({
        schema,
        source: `
            mutation {
                sendMessage(
                    to: "Bob"
                    body: "Hello Bob!"
                ) {
                    id
                    body
                }
            }
        `,
        rootValue
    });

    console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);
