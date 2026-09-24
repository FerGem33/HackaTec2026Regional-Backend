import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

/**
 * Bucket privado de evidencia. requestEvidenceUploadFn firma URLs PUT hacia
 * el prefijo raw-images/ (nunca sube bytes desde el backend); la Pi es la
 * unica que efectivamente escribe objetos, usando esa URL prefirmada.
 * evidenceCallbackHandlerFn valida (HeadObject) y, si es invalido, borra el
 * objeto subido (ver infra/lib/constructs/case-orchestration.ts y
 * evidence-callback-handlers.ts).
 */
export class EvidenceBucket extends Construct {
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, "EvidenceBucket", {
      bucketName: `sensecare-private-images-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: "expire-raw-images",
          prefix: "raw-images/",
          expiration: cdk.Duration.days(7),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
      ],
    });
  }
}
