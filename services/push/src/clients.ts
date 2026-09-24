import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { PinpointClient } from "@aws-sdk/client-pinpoint";

const dynamoClient = new DynamoDBClient({});

export const ddb = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: { removeUndefinedValues: true },
});

export const pinpoint = new PinpointClient({});
