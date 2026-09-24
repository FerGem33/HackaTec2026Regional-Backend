import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SFNClient } from "@aws-sdk/client-sfn";
import { S3Client } from "@aws-sdk/client-s3";
import { IoTDataPlaneClient } from "@aws-sdk/client-iot-data-plane";

const dynamoClient = new DynamoDBClient({});

export const ddb = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: { removeUndefinedValues: true },
});

export const sfn = new SFNClient({});
export const s3 = new S3Client({});
export const iotData = new IoTDataPlaneClient({});
