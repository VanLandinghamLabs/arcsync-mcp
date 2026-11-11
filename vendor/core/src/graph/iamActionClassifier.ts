export type IamAccess = "read" | "write" | "read_write";

/** The edge label each access level draws. */
export const IAM_ACCESS_LABELS: Record<IamAccess, string> = {
  read: "reads",
  write: "writes",
  read_write: "reads/writes",
};

interface IamServiceSpec {
  /** The `AWS::<Namespace>::…` segment of the CloudFormation types this service's actions target. */
  cfnNamespace: string;
  /** The prefix of the Terraform AWS provider types this service's actions target. */
  terraformPrefix: string;
  read: readonly string[];
  write: readonly string[];
}

/**
 * Data-plane actions only: management and metadata actions (`s3:CreateBucket`,
 * `sqs:GetQueueAttributes`, `kinesis:ListShards`) are left out because CDK's
 * write grants include them, and counting them as reads would turn every
 * producer into a reader. `dynamodb:DescribeTable` is the exception, kept as a
 * read so DynamoDB labels match the classifier this table replaced.
 */
const IAM_SERVICES = {
  dynamodb: {
    cfnNamespace: "DynamoDB",
    terraformPrefix: "aws_dynamodb_",
    read: [
      "GetItem",
      "BatchGetItem",
      "Query",
      "Scan",
      "GetRecords",
      "GetShardIterator",
      "ConditionCheckItem",
      "DescribeTable",
    ],
    write: ["PutItem", "UpdateItem", "DeleteItem", "BatchWriteItem"],
  },
  s3: {
    cfnNamespace: "S3",
    terraformPrefix: "aws_s3_",
    read: ["GetObject", "GetObjectVersion", "GetObjectAttributes", "ListBucket"],
    write: [
      "PutObject",
      "PutObjectTagging",
      "PutObjectVersionTagging",
      "PutObjectLegalHold",
      "PutObjectRetention",
      "DeleteObject",
      "DeleteObjectVersion",
      "AbortMultipartUpload",
    ],
  },
  sqs: {
    cfnNamespace: "SQS",
    terraformPrefix: "aws_sqs_",
    read: ["ReceiveMessage", "DeleteMessage", "DeleteMessageBatch", "ChangeMessageVisibility"],
    write: ["SendMessage", "SendMessageBatch"],
  },
  sns: { cfnNamespace: "SNS", terraformPrefix: "aws_sns_", read: [], write: ["Publish"] },
  kinesis: {
    cfnNamespace: "Kinesis",
    terraformPrefix: "aws_kinesis_",
    read: ["GetRecords", "GetShardIterator", "SubscribeToShard"],
    write: ["PutRecord", "PutRecords"],
  },
  firehose: {
    cfnNamespace: "KinesisFirehose",
    terraformPrefix: "aws_kinesis_firehose_",
    read: [],
    write: ["PutRecord", "PutRecordBatch"],
  },
  events: {
    cfnNamespace: "Events",
    terraformPrefix: "aws_cloudwatch_event_",
    read: [],
    write: ["PutEvents"],
  },
  secretsmanager: {
    cfnNamespace: "SecretsManager",
    terraformPrefix: "aws_secretsmanager_",
    read: ["GetSecretValue", "BatchGetSecretValue"],
    write: ["PutSecretValue", "UpdateSecret"],
  },
} as const satisfies Record<string, IamServiceSpec>;

export type IamService = keyof typeof IAM_SERVICES;

interface ActionEntry {
  service: IamService;
  access: "read" | "write";
}

const ACTIONS = new Map<string, ActionEntry>(
  (Object.entries(IAM_SERVICES) as [IamService, IamServiceSpec][]).flatMap(([service, spec]) => [
    ...spec.read.map((a): [string, ActionEntry] => [
      `${service}:${a}`.toLowerCase(),
      { service, access: "read" },
    ]),
    ...spec.write.map((a): [string, ActionEntry] => [
      `${service}:${a}`.toLowerCase(),
      { service, access: "write" },
    ]),
  ]),
);

const SERVICE_BY_CFN_NAMESPACE = new Map<string, IamService>(
  (Object.entries(IAM_SERVICES) as [IamService, IamServiceSpec][]).map(([service, spec]) => [
    spec.cfnNamespace.toLowerCase(),
    service,
  ]),
);

// Longest first, so `aws_kinesis_firehose_` wins over `aws_kinesis_`.
const SERVICE_BY_TERRAFORM_PREFIX = (Object.entries(IAM_SERVICES) as [IamService, IamServiceSpec][])
  .map(([service, spec]): [string, IamService] => [spec.terraformPrefix, service])
  .sort(([a], [b]) => b.length - a.length);

/** IAM's glob: `*` any run, `?` one character. Two-pointer backtracking rather
 * than a RegExp, so a pattern from a user's template cannot backtrack
 * polynomially. */
function globMatches(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    if (pattern[p] === "?" || pattern[p] === text[t]) {
      p++;
      t++;
    } else if (pattern[p] === "*") {
      star = p++;
      resume = t;
    } else if (star >= 0) {
      p = star + 1;
      t = ++resume;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

export function mergeIamAccess(existing: IamAccess | undefined, incoming: IamAccess): IamAccess {
  if (!existing || existing === incoming) return incoming;
  return "read_write";
}

/**
 * The data access an IAM `Action` list grants, per service. Action names are
 * case-insensitive and take `*`/`?` wildcards, so `s3:Get*` is an S3 read and
 * `sqs:*` both reads and writes SQS. Services and actions outside the table
 * grant nothing.
 */
export function classifyIamAccess(actions: Iterable<string>): Map<IamService, IamAccess> {
  const access = new Map<IamService, IamAccess>();
  const grant = (entry: ActionEntry) =>
    access.set(entry.service, mergeIamAccess(access.get(entry.service), entry.access));
  for (const action of actions) {
    const pattern = action.toLowerCase();
    if (!/[*?]/.test(pattern)) {
      const entry = ACTIONS.get(pattern);
      if (entry) grant(entry);
      continue;
    }
    for (const [name, entry] of ACTIONS) {
      if (globMatches(pattern, name)) grant(entry);
    }
  }
  return access;
}

/** The access across every service, or `null` when nothing is granted. */
export function combinedIamAccess(access: ReadonlyMap<IamService, IamAccess>): IamAccess | null {
  let combined: IamAccess | null = null;
  for (const value of access.values()) combined = mergeIamAccess(combined ?? undefined, value);
  return combined;
}

/** Kept out of `IAM_SERVICES`: an invoke grant is not data access, and adding
 * it there would draw "writes" to every function a policy may invoke. */
const INVOKE_ACTIONS: ReadonlySet<string> = new Set([
  "lambda:invokefunction",
  "lambda:invokeasync",
  "lambda:invokefunctionurl",
]);

/**
 * A label for what a Deny statement's actions take away: "denies invoke",
 * "denies writes". `undefined` unless every action is named exactly (no
 * wildcard, since `lambda:*` denies far more than invoke) and all of them
 * fall in one kind.
 */
export function deniedActionsLabel(actions: Iterable<string>): string | undefined {
  let invoke = false;
  let access: IamAccess | undefined;
  for (const action of actions) {
    const name = action.toLowerCase();
    const entry = ACTIONS.get(name);
    if (INVOKE_ACTIONS.has(name)) invoke = true;
    else if (entry) access = mergeIamAccess(access, entry.access);
    else return undefined;
  }
  if (invoke === (access !== undefined)) return undefined;
  return access ? `denies ${IAM_ACCESS_LABELS[access]}` : "denies invoke";
}

/** `AWS::SQS::Queue` → `sqs`; `undefined` for a type outside the table. */
export function iamServiceForCfnType(cfnType: string | undefined): IamService | undefined {
  const namespace = cfnType?.split("::")[1];
  return namespace === undefined
    ? undefined
    : SERVICE_BY_CFN_NAMESPACE.get(namespace.toLowerCase());
}

/** `aws_sqs_queue` → `sqs`; `undefined` for a type outside the table. */
export function iamServiceForTerraformType(type: string | undefined): IamService | undefined {
  if (type === undefined) return undefined;
  return SERVICE_BY_TERRAFORM_PREFIX.find(([prefix]) => type.startsWith(prefix))?.[1];
}

/**
 * The access `access` grants on a resource of `service`: that service's own
 * entry for a service in the table (`null` when the statement grants it
 * nothing, so `s3:*` on a table draws no edge), otherwise everything the
 * statement grants (a statement aimed at a resource outside the table still
 * draws its edge).
 */
export function iamAccessForService(
  access: ReadonlyMap<IamService, IamAccess>,
  service: IamService | undefined,
): IamAccess | null {
  return service ? (access.get(service) ?? null) : combinedIamAccess(access);
}

/** `iamAccessForService` for a target of CloudFormation type `cfnType`. */
export function iamAccessForTarget(
  access: ReadonlyMap<IamService, IamAccess>,
  cfnType: string | undefined,
): IamAccess | null {
  return iamAccessForService(access, iamServiceForCfnType(cfnType));
}
