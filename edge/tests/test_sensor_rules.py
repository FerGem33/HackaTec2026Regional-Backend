import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from SenseCare_edge.esp32_reader import SensorReading
from SenseCare_edge.sensor_rules import SensorRulesEngine

RULES_CONFIG = {
    "co2": {"thresholdPpm": 1200, "windowSeconds": 0.2, "cooldownSeconds": 0.5, "ruleVersion": "test-v1"},
    "temperature": {"thresholdC": 38.0, "windowSeconds": 0.2, "cooldownSeconds": 0.5, "ruleVersion": "test-v1"},
}


def _reading(co2=800.0, temp=25.0):
    return SensorReading(
        receivedAt="2026-01-01T00:00:00.000Z",
        temperatureC=temp,
        humidityPct=50.0,
        co2Ppm=co2,
        proximityCm=100.0,
        motion=False,
        luxLevel=100.0,
        soundDbAvg=40.0,
        soundDbPeak=50.0,
        raw={},
    )


class SensorRulesEngineTest(unittest.TestCase):
    def test_single_high_reading_does_not_trigger(self):
        engine = SensorRulesEngine(RULES_CONFIG)
        self.assertIsNone(engine.evaluate(_reading(co2=1500)))

    def test_sustained_co2_triggers_after_window(self):
        engine = SensorRulesEngine(RULES_CONFIG)
        engine.evaluate(_reading(co2=1500))
        time.sleep(0.25)
        anomaly = engine.evaluate(_reading(co2=1500))
        self.assertIsNotNone(anomaly)
        self.assertEqual(anomaly["anomalyType"], "POOR_AIR_QUALITY")
        self.assertEqual(anomaly["sensors"]["co2Ppm"], 1500)

    def test_cooldown_prevents_immediate_refire(self):
        engine = SensorRulesEngine(RULES_CONFIG)
        engine.evaluate(_reading(co2=1500))
        time.sleep(0.25)
        first = engine.evaluate(_reading(co2=1500))
        self.assertIsNotNone(first)
        second = engine.evaluate(_reading(co2=1500))
        self.assertIsNone(second)

    def test_condition_resets_when_value_drops(self):
        engine = SensorRulesEngine(RULES_CONFIG)
        engine.evaluate(_reading(co2=1500))
        engine.evaluate(_reading(co2=800))  # ya no esta activa la condicion
        time.sleep(0.25)
        self.assertIsNone(engine.evaluate(_reading(co2=800)))


if __name__ == "__main__":
    unittest.main()
