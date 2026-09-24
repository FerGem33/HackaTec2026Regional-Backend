import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

const dynamoClient = new DynamoDBClient({});

export const ddb = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: { removeUndefinedValues: true },
});

export const s3 = new S3Client({});
export const bedrockRuntime = new BedrockRuntimeClient({});
