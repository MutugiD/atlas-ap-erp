import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Runtime, Code, Function as LambdaFunction } from "aws-cdk-lib/aws-lambda";
import { Bucket, BucketEncryption, EventType } from "aws-cdk-lib/aws-s3";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { SqsDestination } from "aws-cdk-lib/aws-s3-notifications";
import { InstanceClass, InstanceSize, InstanceType, Port, SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { Credentials, DatabaseInstance, DatabaseInstanceEngine, PostgresEngineVersion } from "aws-cdk-lib/aws-rds";
import { Cluster, ContainerImage, Secret as EcsSecret } from "aws-cdk-lib/aws-ecs";
import { ApplicationLoadBalancedFargateService } from "aws-cdk-lib/aws-ecs-patterns";
import { CfnCacheCluster, CfnSubnetGroup } from "aws-cdk-lib/aws-elasticache";
import { Construct } from "constructs";

// Production-shaped stack: async invoice processor (S3 -> SQS -> Lambda), a
// hardened RDS Postgres, ElastiCache Redis, and the support-agent container on
// Fargate behind an ALB. Deletion protection / retention are gated on the
// `prod` context flag (`cdk deploy -c prod=true`) so non-prod stacks tear down cleanly.
export class AtlasApStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const isProd = this.node.tryGetContext("prod") === "true" || this.node.tryGetContext("prod") === true;
    const containerImage = String(this.node.tryGetContext("supportImage") ?? "ghcr.io/mutugid/atlas-support-agent:latest");

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
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });

    const dlq = new Queue(this, "InvoiceProcessorDlq", { retentionPeriod: Duration.days(14) });
    const queue = new Queue(this, "InvoiceProcessorQueue", {
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
      visibilityTimeout: Duration.minutes(5),
    });
    documents.addEventNotification(EventType.OBJECT_CREATED, new SqsDestination(queue));

    // --- data layer -------------------------------------------------------
    const dbSg = new SecurityGroup(this, "DbSg", { vpc, description: "Postgres access" });
    const db = new DatabaseInstance(this, "Postgres", {
      vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [dbSg],
      engine: DatabaseInstanceEngine.postgres({ version: PostgresEngineVersion.VER_17_2 }),
      instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.MICRO),
      credentials: Credentials.fromGeneratedSecret("atlas_owner"),
      allocatedStorage: 20,
      publiclyAccessible: false,
      storageEncrypted: true,
      backupRetention: Duration.days(isProd ? 7 : 1),
      deletionProtection: isProd,
      removalPolicy: isProd ? RemovalPolicy.SNAPSHOT : RemovalPolicy.DESTROY,
    });
    const dbSecret = db.secret!;

    const redisSg = new SecurityGroup(this, "RedisSg", { vpc, description: "Redis access" });
    const redisSubnets = new CfnSubnetGroup(this, "RedisSubnets", {
      description: "Atlas AP Redis subnets",
      subnetIds: vpc.selectSubnets({ subnetType: SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
    });
    const redis = new CfnCacheCluster(this, "Redis", {
      engine: "redis",
      cacheNodeType: "cache.t4g.micro",
      numCacheNodes: 1,
      vpcSecurityGroupIds: [redisSg.securityGroupId],
      cacheSubnetGroupName: redisSubnets.ref,
    });

    // --- support-agent service on Fargate --------------------------------
    const cluster = new Cluster(this, "Cluster", { vpc, containerInsights: true });
    const service = new ApplicationLoadBalancedFargateService(this, "SupportAgent", {
      cluster,
      cpu: 512,
      memoryLimitMiB: 1024,
      desiredCount: isProd ? 2 : 1,
      publicLoadBalancer: true,
      taskImageOptions: {
        image: ContainerImage.fromRegistry(containerImage),
        containerPort: 3002,
        environment: {
          APP_ROLE: "web",
          PII_REDACTION: "on",
          PGHOST: db.dbInstanceEndpointAddress,
          PGPORT: db.dbInstanceEndpointPort,
          PGDATABASE: "atlas_ap",
          REDIS_HOST: redis.attrRedisEndpointAddress,
          REDIS_PORT: redis.attrRedisEndpointPort,
        },
        secrets: {
          PGUSER: EcsSecret.fromSecretsManager(dbSecret, "username"),
          PGPASSWORD: EcsSecret.fromSecretsManager(dbSecret, "password"),
        },
        // Compose DATABASE_URL / REDIS_URL from the injected parts, then launch.
        command: [
          "sh",
          "-lc",
          'export DATABASE_URL="postgresql://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT/$PGDATABASE"; export REDIS_URL="redis://$REDIS_HOST:$REDIS_PORT"; exec bun --filter @atlas/support-agent dev',
        ],
      },
    });
    service.targetGroup.configureHealthCheck({ path: "/health/ready", healthyHttpCodes: "200" });

    // Let the service reach Postgres and Redis.
    dbSg.addIngressRule(service.service.connections.securityGroups[0], Port.tcp(5432), "Fargate -> Postgres");
    redisSg.addIngressRule(service.service.connections.securityGroups[0], Port.tcp(6379), "Fargate -> Redis");
    dbSecret.grantRead(service.taskDefinition.taskRole);

    // --- async invoice processor -----------------------------------------
    const processorSg = new SecurityGroup(this, "ProcessorSg", { vpc, description: "Invoice processor" });
    const processor = new LambdaFunction(this, "InvoiceProcessor", {
      runtime: Runtime.NODEJS_20_X,
      handler: "lambda.handler",
      code: Code.fromAsset("../apps/api/src"),
      timeout: Duration.minutes(5),
      memorySize: 1024,
      vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [processorSg],
      environment: {
        // GLM-first: the processor delegates to the tiered Ollama provider by default.
        // A reachable OLLAMA_URL is required (Ollama cloud or a self-hosted endpoint) —
        // localhost is not reachable from Lambda; without it the provider degrades to the
        // deterministic local rules. Set AGENT_PROVIDER=bedrock to use the Bedrock seam instead.
        AGENT_PROVIDER: process.env.AGENT_PROVIDER ?? "ollama",
        S3_INVOICE_BUCKET: documents.bucketName,
        DB_SECRET_ARN: dbSecret.secretArn,
        OLLAMA_URL: process.env.OLLAMA_URL ?? "",
        OLLAMA_API_KEY: process.env.OLLAMA_API_KEY ?? "",
        OLLAMA_API_STYLE: process.env.OLLAMA_API_STYLE ?? "ollama",
        OLLAMA_MODEL_COMPLEX: process.env.OLLAMA_MODEL_COMPLEX ?? "glm-5.2:cloud",
        OLLAMA_MODEL_STANDARD: process.env.OLLAMA_MODEL_STANDARD ?? "glm-5.1:cloud",
        OLLAMA_MODEL_SIMPLE: process.env.OLLAMA_MODEL_SIMPLE ?? "gemini-3-flash-preview:latest",
        // Bedrock retained as an optional provider (AGENT_PROVIDER=bedrock).
        BEDROCK_SUPERVISOR_AGENT_ID: process.env.BEDROCK_SUPERVISOR_AGENT_ID ?? "",
        BEDROCK_AGENTCORE_RUNTIME_ARN: process.env.BEDROCK_AGENTCORE_RUNTIME_ARN ?? "",
      },
    });
    dbSg.addIngressRule(processorSg, Port.tcp(5432), "Processor -> Postgres");

    documents.grantReadWrite(processor);
    queue.grantConsumeMessages(processor);
    dbSecret.grantRead(processor);
    processor.addToRolePolicy(new PolicyStatement({
      actions: ["bedrock:InvokeAgent", "bedrock:InvokeModel", "bedrock-agentcore:*"],
      resources: ["*"],
    }));

    // --- outputs ----------------------------------------------------------
    new CfnOutput(this, "ServiceUrl", { value: `http://${service.loadBalancer.loadBalancerDnsName}` });
    new CfnOutput(this, "DbEndpoint", { value: db.dbInstanceEndpointAddress });
    new CfnOutput(this, "DbSecretArn", { value: dbSecret.secretArn });
    new CfnOutput(this, "RedisEndpoint", { value: redis.attrRedisEndpointAddress });
    new CfnOutput(this, "DocumentsBucketName", { value: documents.bucketName });
    new CfnOutput(this, "InvoiceQueueUrl", { value: queue.queueUrl });
  }
}
