#!/usr/bin/env bun
import { App } from "aws-cdk-lib";
import { AtlasApStack } from "../lib/atlas-ap-stack";

const app = new App();
new AtlasApStack(app, "AtlasApStack", {
  env: {
    region: process.env.AWS_REGION ?? "us-east-1",
  },
});

