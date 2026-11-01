import type { ArchGraph } from "@auto-arch-diagram/core/types";

export const AUTHORING_FIXTURES = new URL(
  "../vendor/core/src/authoring/__fixtures__/",
  import.meta.url,
);

export const sampleGraph = (): ArchGraph =>
  ({
    nodes: [
      {
        id: "aws_lambda_function.api",
        type: "lambda",
        provider: "aws",
        name: "api",
        resourceType: "aws_lambda_function",
        attributes: { runtime: "nodejs22.x" },
      },
      {
        id: "aws_dynamodb_table.orders",
        type: "dynamodb",
        provider: "aws",
        name: "orders",
        resourceType: "aws_dynamodb_table",
        attributes: { billing_mode: "PAY_PER_REQUEST" },
      },
      {
        id: "aws_dynamodb_table.orders_archive",
        type: "dynamodb",
        provider: "aws",
        name: "orders_archive",
        resourceType: "aws_dynamodb_table",
        attributes: {},
      },
    ],
    edges: [
      {
        id: "e1",
        source: "aws_lambda_function.api",
        target: "aws_dynamodb_table.orders",
        type: "IAM",
        label: "read/write",
      },
      {
        id: "e2",
        source: "aws_lambda_function.ghost",
        target: "aws_lambda_function.api",
        type: "REFERENCE",
      },
    ],
    metadata: { source: "terraform", generatedAt: "2026-10-01T00:00:00.000Z" },
  }) as unknown as ArchGraph;
