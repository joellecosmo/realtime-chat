const fs = require("node:fs");
const { buildSchema, parse, validate } = require("graphql");

const schemaSource = fs.readFileSync(
    "graphql/schema.graphql",
    "utf8"
);

const operationsSource = fs.readFileSync(
    "graphql/operations.graphql",
    "utf8"
);

// Define the AWS AppSync-specific types and directive
// needed for local schema validation.
const appSyncDefinitions = `
    scalar AWSDateTime

    directive @aws_subscribe(
        mutations: [String!]!
    ) on FIELD_DEFINITION
`;

const schema = buildSchema(
    appSyncDefinitions + schemaSource
);

const operations = parse(operationsSource);

const errors = validate(schema, operations);

if (errors.length > 0) {
    console.error("GraphQL validation failed:");

    for (const error of errors) {
        console.error(`- ${error.message}`);
    }

    process.exitCode = 1;
} else {
    console.log("GraphQL operations are valid!");
}
