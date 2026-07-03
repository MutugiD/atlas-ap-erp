import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("infra", () => {
  test("CDK stack includes core AWS resources", () => {
    const source = readFileSync("infra/lib/atlas-ap-stack.ts", "utf8");
    for (const token of ["Bucket", "Queue", "DatabaseInstance", "LambdaFunction", "bedrock:InvokeAgent"]) {
      expect(source).toContain(token);
    }
  });

  test("CDK stack is hardened for deploy (service, redis, encryption, outputs)", () => {
    const source = readFileSync("infra/lib/atlas-ap-stack.ts", "utf8");
    for (const token of ["ApplicationLoadBalancedFargateService", "CfnCacheCluster", "storageEncrypted", "deletionProtection", "CfnOutput", "/health/ready"]) {
      expect(source).toContain(token);
    }
  });
});

