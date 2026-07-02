import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Runtime, Code, Function as LambdaFunction } from "aws-cdk-lib/aws-lambda";
import { Bucket, BucketEncryption, EventType } from "aws-cdk-lib/aws-s3";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { SqsDestination } from "aws-cdk-lib/aws-s3-notifications";
import { InstanceClass, InstanceSize, InstanceType, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { Credentials, DatabaseInstance, DatabaseInstanceEngine, PostgresEngineVersion } from "aws-cdk-lib/aws-rds";
import { Construct } from "constructs";

export class AtlasApStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = new Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: "public", subnetType: SubnetType.PUBLIC },
        { name: "private", subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      ],
    });

    const documents = new Bucket(this, "DocumentsBucket", {
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const dlq = new Queue(this, "InvoiceProcessorDlq", { retentionPeriod: Duration.days(14) });
    const queue = new Queue(this, "InvoiceProcessorQueue", {
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
      visibilityTimeout: Duration.minutes(5),
    });
    documents.addEventNotification(EventType.OBJECT_CREATED, new SqsDestination(queue));

    const db = new DatabaseInstance(this, "Postgres", {
      vpc,
      engine: DatabaseInstanceEngine.postgres({ version: PostgresEngineVersion.VER_17_2 }),
      instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.MICRO),
      credentials: Credentials.fromGeneratedSecret("atlas_owner"),
      allocatedStorage: 20,
      publiclyAccessible: false,
      removalPolicy: RemovalPolicy.SNAPSHOT,
    });

    const processor = new LambdaFunction(this, "InvoiceProcessor", {
      runtime: Runtime.NODEJS_20_X,
      handler: "lambda.handler",
      code: Code.fromAsset("../apps/api/src"),
      timeout: Duration.minutes(5),
      memorySize: 1024,
      environment: {
        AGENT_PROVIDER: "bedrock",
        S3_INVOICE_BUCKET: documents.bucketName,
        BEDROCK_SUPERVISOR_AGENT_ID: process.env.BEDROCK_SUPERVISOR_AGENT_ID ?? "",
        BEDROCK_AGENTCORE_RUNTIME_ARN: process.env.BEDROCK_AGENTCORE_RUNTIME_ARN ?? "",
      },
    });

    documents.grantReadWrite(processor);
    queue.grantConsumeMessages(processor);
    db.secret?.grantRead(processor);
    processor.addToRolePolicy(new PolicyStatement({
      actions: ["bedrock:InvokeAgent", "bedrock:InvokeModel", "bedrock-agentcore:*"],
      resources: ["*"],
    }));
  }
}
