import { ResourceType } from "../graph/types.js";

export const AWS_ICON_FILENAMES: Partial<Record<ResourceType, string>> = {
  // Compute
  [ResourceType.EC2_INSTANCE]: "ec2.svg",
  [ResourceType.LAMBDA_FUNCTION]: "lambda.svg",
  [ResourceType.ECS_SERVICE]: "ecs.svg",
  [ResourceType.ECS_CLUSTER]: "ecs.svg",
  [ResourceType.ECS_TASK_DEFINITION]: "ecs.svg",
  [ResourceType.EKS_CLUSTER]: "eks.svg",
  [ResourceType.AUTOSCALING_GROUP]: "autoscaling.svg",

  // Storage & Databases
  [ResourceType.S3_BUCKET]: "s3.svg",
  [ResourceType.DYNAMODB_TABLE]: "dynamodb.svg",
  [ResourceType.RDS_INSTANCE]: "rds.svg",
  [ResourceType.RDS_CLUSTER]: "rds.svg",
  [ResourceType.ELASTICACHE_CLUSTER]: "elasticache.svg",
  [ResourceType.OPENSEARCH_DOMAIN]: "opensearch.svg",
  [ResourceType.EFS_FILE_SYSTEM]: "efs.svg",
  [ResourceType.REDSHIFT_CLUSTER]: "redshift.svg",

  // Networking
  [ResourceType.EC2_VPC]: "vpc.svg",
  [ResourceType.EC2_SUBNET]: "vpc.svg",
  [ResourceType.EC2_SECURITY_GROUP]: "vpc.svg",
  [ResourceType.EC2_NAT_GATEWAY]: "vpc.svg",
  [ResourceType.EC2_INTERNET_GATEWAY]: "vpc.svg",
  [ResourceType.EC2_VPC_ENDPOINT]: "vpc.svg",
  [ResourceType.EC2_TRANSIT_GATEWAY]: "transit-gateway.svg",
  [ResourceType.EC2_EIP]: "ec2.svg",
  [ResourceType.EC2_ROUTE_TABLE]: "vpc.svg",
  [ResourceType.EC2_ROUTE_TABLE_ASSOCIATION]: "vpc.svg",
  [ResourceType.EC2_ROUTE]: "vpc.svg",
  [ResourceType.EC2_INTERNET_GATEWAY_ATTACHMENT]: "vpc.svg",
  [ResourceType.ELB_LOAD_BALANCER]: "elb.svg",

  // API & Integration
  [ResourceType.APIGW_REST_API]: "api-gateway.svg",
  [ResourceType.APIGW_V2_API]: "api-gateway.svg",
  [ResourceType.APIGW_V2_ROUTE]: "api-gateway.svg",
  [ResourceType.APIGW_V2_INTEGRATION]: "api-gateway.svg",
  [ResourceType.APIGW_REST_RESOURCE]: "api-gateway.svg",
  [ResourceType.APIGW_REST_METHOD]: "api-gateway.svg",
  [ResourceType.APIGW_REST_INTEGRATION]: "api-gateway.svg",
  [ResourceType.APPSYNC_API]: "appsync.svg",
  [ResourceType.ROUTE53_ZONE]: "route53.svg",
  [ResourceType.ROUTE53_RECORD]: "route53.svg",
  [ResourceType.CLOUDFRONT_DISTRIBUTION]: "cloudfront.svg",
  [ResourceType.ACM_CERTIFICATE]: "acm.svg",

  // Messaging & Events
  [ResourceType.SQS_QUEUE]: "sqs.svg",
  [ResourceType.SNS_TOPIC]: "sns.svg",
  [ResourceType.EVENTBRIDGE_RULE]: "eventbridge.svg",
  [ResourceType.EVENTBRIDGE_BUS]: "eventbridge.svg",
  [ResourceType.KINESIS_STREAM]: "kinesis.svg",
  [ResourceType.KINESIS_FIREHOSE]: "kinesis-firehose.svg",
  [ResourceType.MSK_CLUSTER]: "msk.svg",

  // Security
  [ResourceType.IAM_ROLE]: "iam.svg",
  [ResourceType.IAM_POLICY]: "iam.svg",
  [ResourceType.IAM_INSTANCE_PROFILE]: "iam.svg",
  [ResourceType.KMS_KEY]: "kms.svg",
  [ResourceType.SECRETSMANAGER_SECRET]: "secrets-manager.svg",
  [ResourceType.COGNITO_USER_POOL]: "cognito.svg",
  [ResourceType.WAF_WEB_ACL]: "waf.svg",

  // CI/CD & Containers
  [ResourceType.ECR_REPOSITORY]: "ecr.svg",
  [ResourceType.CODEPIPELINE_PIPELINE]: "codepipeline.svg",
  [ResourceType.CODEBUILD_PROJECT]: "codebuild.svg",

  // Orchestration
  [ResourceType.SFN_STATE_MACHINE]: "step-functions.svg",
  [ResourceType.CLOUDFORMATION_STACK]: "cloudformation.svg",
  [ResourceType.SCHEDULER_SCHEDULE]: "eventbridge.svg",
  [ResourceType.BATCH_COMPUTE_ENVIRONMENT]: "batch.svg",
  [ResourceType.BATCH_JOB_QUEUE]: "batch.svg",
  [ResourceType.BATCH_JOB_DEFINITION]: "batch.svg",

  // Management & governance
  [ResourceType.SSM_PARAMETER]: "systems-manager.svg",
  [ResourceType.SSM_DOCUMENT]: "systems-manager.svg",
  [ResourceType.CLOUDWATCH_ALARM]: "cloudwatch.svg",
  [ResourceType.CLOUDWATCH_DASHBOARD]: "cloudwatch.svg",
  [ResourceType.CLOUDWATCH_LOG_METRIC_FILTER]: "cloudwatch.svg",
  [ResourceType.CLOUDTRAIL_TRAIL]: "cloudtrail.svg",
  [ResourceType.GUARDDUTY_DETECTOR]: "guardduty.svg",
  [ResourceType.BUDGETS_BUDGET]: "budgets.svg",

  // Analytics & AI
  [ResourceType.GLUE_DATABASE]: "glue.svg",
  [ResourceType.GLUE_TABLE]: "glue.svg",
  [ResourceType.GLUE_JOB]: "glue.svg",
  [ResourceType.GLUE_CRAWLER]: "glue.svg",
  [ResourceType.ATHENA_WORKGROUP]: "athena.svg",
  [ResourceType.OPENSEARCH_SERVERLESS_COLLECTION]: "opensearch.svg",
  [ResourceType.BEDROCK_AGENT]: "bedrock.svg",
  [ResourceType.BEDROCK_KNOWLEDGE_BASE]: "bedrock.svg",
  [ResourceType.BEDROCK_DATA_SOURCE]: "bedrock.svg",

  // Backup
  [ResourceType.BACKUP_PLAN]: "backup.svg",
  [ResourceType.BACKUP_VAULT]: "backup.svg",
};
