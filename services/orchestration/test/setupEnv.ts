process.env.OPEN_CASE_LOCKS_TABLE_NAME ??= "SenseCare-OpenCaseLocks-test";
process.env.ANOMALY_CASES_TABLE_NAME ??= "SenseCare-AnomalyCases-test";
process.env.STATE_MACHINE_ARN ??=
  "arn:aws:states:us-east-1:123456789012:stateMachine:SenseCareCaseStateMachine-test";
process.env.OPEN_CASE_LOCK_TTL_SECONDS ??= "7200";
process.env.ALERTS_TABLE_NAME ??= "SenseCare-Alerts-test";
process.env.CAREGIVER_ACCESS_TABLE_NAME ??= "SenseCare-CaregiverAccess-test";
process.env.ALERTS_TOPIC_ARN ??= "arn:aws:sns:us-east-1:123456789012:SenseCare-Alerts-test";
process.env.CAREGIVER_PUSH_ENDPOINTS_TABLE_NAME ??= "SenseCare-CaregiverPushEndpoints-test";
process.env.ALERT_DELIVERIES_TABLE_NAME ??= "SenseCare-AlertDeliveries-test";
process.env.PINPOINT_APPLICATION_ID ??= "test-pinpoint-application-id";
process.env.CASE_ACTION_CALLBACKS_TABLE_NAME ??= "SenseCare-CaseActionCallbacks-test";
