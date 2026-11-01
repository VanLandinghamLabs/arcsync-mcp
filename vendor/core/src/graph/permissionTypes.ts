/**
 * Lambda invoke-permission raw provider types, in their own module because two
 * very differently-scoped consumers need them.
 *
 * `displayFilter.ts` folds these into its plumbing tier (hidden from every
 * rendered diagram), and `routeTable.ts` matches the same set when it walks an
 * *unfiltered* graph to set a route row's invoke shield. One definition, not
 * two — but `routeTable` ships in the browser's graph chunk and `displayFilter`
 * does not, so importing them from `displayFilter` dragged the entire deny list
 * (every plumbing and connector type, in four provider spellings) into the
 * frontend bundle as dead weight. Hence the separate module.
 */
export const PERMISSION_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "AWS::Lambda::Permission", // CloudFormation
  "aws_lambda_permission", // Terraform
  "aws:lambda/permission:Permission", // Pulumi (classic AWS)
  "aws-native:lambda:Permission", // Pulumi (aws-native)
]);
