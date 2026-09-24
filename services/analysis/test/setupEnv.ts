process.env.EVIDENCE_BUCKET_NAME ??= "sensecare-private-images-test";
process.env.EVENT_LOG_TABLE_NAME ??= "SenseCare-EventLog-test";
process.env.ANOMALY_CASES_TABLE_NAME ??= "SenseCare-AnomalyCases-test";
process.env.OBSERVATIONS_TABLE_NAME ??= "SenseCare-Observations-test";
process.env.BEDROCK_MODEL_ID ??= "us.amazon.nova-lite-v1:0";
process.env.BEDROCK_MAX_TOKENS ??= "400";
process.env.BEDROCK_TEMPERATURE ??= "0";
process.env.EVIDENCE_MAX_BYTES ??= "1048576";
