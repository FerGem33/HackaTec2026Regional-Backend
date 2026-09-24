import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { EvidenceBucket } from "../lib/constructs/evidence-bucket.js";

function synth(): Template {
  const stack = new Stack(new App(), "TestStack");
  new EvidenceBucket(stack, "Bucket");
  return Template.fromStack(stack);
}

describe("EvidenceBucket", () => {
  it("blocks all public access and retains the bucket on stack deletion", () => {
    const template = synth();
    template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      Properties: {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      },
    });
  });

  it("uses S3-managed encryption", () => {
    const template = synth();
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      },
    });
  });

  it("expires raw-images/ objects after 7 days and aborts incomplete uploads after 1 day", () => {
    const template = synth();
    template.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: {
        Rules: [
          {
            Prefix: "raw-images/",
            ExpirationInDays: 7,
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
            Status: "Enabled",
          },
        ],
      },
    });
  });

  it("does not enable autoDeleteObjects (no custom resource / lambda for it)", () => {
    const template = synth();
    template.resourceCountIs("Custom::S3AutoDeleteObjects", 0);
  });
});
