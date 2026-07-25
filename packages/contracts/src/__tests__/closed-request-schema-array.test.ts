import { describe, expect, it } from "vitest";
import {
  closedRequestSchemaDefinitionIssues,
  closedRequestSchemaViolation,
} from "../closed-request-schema.js";

const schema = {
  type: "object",
  properties: {
    "query.filter": {
      type: "array",
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
      items: {
        type: "string",
        minLength: 3,
        maxLength: 32,
        pattern: "^tag:",
      },
    },
  },
  required: ["query.filter"],
  additionalProperties: false,
};

describe("closed request-schema scalar arrays", () => {
  it("admits a bounded scalar array and enforces its item contract", () => {
    expect(closedRequestSchemaDefinitionIssues(schema)).toEqual([]);
    expect(
      closedRequestSchemaViolation(schema, {
        "query.filter": ["tag:environment=prod", "tag:team=data"],
      }),
    ).toBeNull();

    expect(
      closedRequestSchemaViolation(schema, { "query.filter": "tag:team=data" }),
    ).toBe("argument 'query.filter' must be array");
    expect(closedRequestSchemaViolation(schema, { "query.filter": [] })).toBe(
      "argument 'query.filter' has fewer than 1 items",
    );
    expect(
      closedRequestSchemaViolation(schema, {
        "query.filter": ["tag:a", "tag:b", "tag:c", "tag:d"],
      }),
    ).toBe("argument 'query.filter' has more than 3 items");
    expect(
      closedRequestSchemaViolation(schema, {
        "query.filter": ["tag:team=data", "tag:team=data"],
      }),
    ).toBe("argument 'query.filter' must contain unique items");
    expect(
      closedRequestSchemaViolation(schema, { "query.filter": ["team=data"] }),
    ).toBe("argument 'query.filter[0]' does not match its required pattern");
    expect(closedRequestSchemaViolation(schema, { "query.filter": [7] })).toBe(
      "argument 'query.filter[0]' must be string",
    );
  });

  it("rejects unbounded, array-of-array, or misspelled definitions", () => {
    const property = schema.properties["query.filter"];
    expect(
      closedRequestSchemaDefinitionIssues({
        ...schema,
        properties: { "query.filter": { ...property, maxItems: undefined } },
      }),
    ).toContain(
      "property 'query.filter' must declare a non-negative maxItems bound",
    );
    expect(
      closedRequestSchemaDefinitionIssues({
        ...schema,
        properties: {
          "query.filter": {
            ...property,
            items: {
              type: "array",
              maxItems: 2,
              items: { type: "string", maxLength: 8 },
            },
          },
        },
      }),
    ).toContain(
      "property 'query.filter[]' type must be string, number, integer, boolean, or object",
    );
    expect(
      closedRequestSchemaDefinitionIssues({
        ...schema,
        properties: { "query.filter": { ...property, maxItem: 3 } },
      }),
    ).toContain("property 'query.filter' uses unsupported keyword 'maxItem'");
  });
});

const nestedSchema = {
  type: "object",
  properties: {
    "body.user": {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 80 },
        addresses: {
          type: "array",
          minItems: 1,
          maxItems: 2,
          items: {
            type: "object",
            properties: {
              city: { type: "string", maxLength: 80 },
              primary: { type: "boolean" },
            },
            required: ["city"],
            additionalProperties: false,
          },
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  required: ["body.user"],
  additionalProperties: false,
};

describe("closed request-schema nested JSON values", () => {
  it("admits recursively closed objects and bounded object arrays", () => {
    expect(closedRequestSchemaDefinitionIssues(nestedSchema)).toEqual([]);
    expect(
      closedRequestSchemaViolation(nestedSchema, {
        "body.user": {
          name: "Ada",
          addresses: [{ city: "London", primary: true }],
        },
      }),
    ).toBeNull();
  });

  it("rejects undeclared and missing nested authority", () => {
    expect(
      closedRequestSchemaViolation(nestedSchema, {
        "body.user": { name: "Ada", client_secret: "caller-owned" },
      }),
    ).toBe("argument 'body.user' has undeclared property 'client_secret'");
    expect(
      closedRequestSchemaViolation(nestedSchema, {
        "body.user": { name: "Ada", addresses: [{ primary: true }] },
      }),
    ).toBe("argument 'body.user.addresses[0]' is missing required property 'city'");
  });

  it("rejects open nested object definitions", () => {
    expect(
      closedRequestSchemaDefinitionIssues({
        ...nestedSchema,
        properties: {
          "body.user": {
            ...nestedSchema.properties["body.user"],
            additionalProperties: true,
          },
        },
      }),
    ).toContain("property 'body.user' must declare additionalProperties: false");
  });
});
