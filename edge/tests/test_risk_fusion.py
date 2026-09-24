import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from SenseCare_edge.risk_fusion import RiskFusionConfig, RiskFusionEngine
from SenseCare_edge.vision_types import (
    CameraHealthObservation,
    PersonObservation,
    PoseObservation,
    SmokeFireObservation,
)

DEVICE_ID = "pi-test-01"


def _config(**overrides) -> RiskFusionConfig:
    defaults = dict(
        device_id=DEVICE_ID,
        pose_model_version="pose-v1",
        person_model_version="person-v1",
        confidence_threshold=0.80,
        cooldown_seconds=120.0,
        fall_burst_window_ms=1000,
        fall_min_consistent_frames=2,
        prone_inactive_seconds=12.0,
        camera_tamper_window_seconds=5.0,
    )
    defaults.update(overrides)
    return RiskFusionConfig(**defaults)


class PossibleFallTest(unittest.TestCase):
    def test_valid_standing_to_lying_transition_fires(self):
        engine = RiskFusionEngine(_config())

        self.assertIsNone(
            engine.observe_pose(PoseObservation(timestamp_ms=0, person_present=True, posture="standing", confidence=0.95))
        )
        self.assertIsNone(
            engine.observe_pose(
                PoseObservation(timestamp_ms=200, person_present=True, posture="lying_or_fallen", confidence=0.95)
            )
        )
        result = engine.observe_pose(
            PoseObservation(timestamp_ms=400, person_present=True, posture="lying_or_fallen", confidence=0.95)
        )

        self.assertIsNotNone(result)
        self.assertEqual(result["anomalyType"], "POSSIBLE_FALL")
        self.assertEqual(result["deviceId"], DEVICE_ID)
        self.assertEqual(result["modelVersions"], {"pose": "pose-v1", "person": "person-v1"})

    def test_isolated_lying_frame_without_prior_standing_never_fires(self):
        engine = RiskFusionEngine(_config())

        first = engine.observe_pose(
            PoseObservation(timestamp_ms=0, person_present=True, posture="lying_or_fallen", confidence=0.95)
        )
        second = engine.observe_pose(
            PoseObservation(timestamp_ms=200, person_present=True, posture="lying_or_fallen", confidence=0.95)
        )

        self.assertIsNone(first)
        self.assertIsNone(second)

    def test_cooldown_blocks_a_second_fall_right_after_the_first(self):
        engine = RiskFusionEngine(_config(cooldown_seconds=120.0))

        engine.observe_pose(PoseObservation(timestamp_ms=0, person_present=True, posture="standing", confidence=0.95))
        engine.observe_pose(
            PoseObservation(timestamp_ms=100, person_present=True, posture="lying_or_fallen", confidence=0.95)
        )
        first_fire = engine.observe_pose(
            PoseObservation(timestamp_ms=300, person_present=True, posture="lying_or_fallen", confidence=0.95)
        )
        self.assertIsNotNone(first_fire)

        engine.observe_pose(PoseObservation(timestamp_ms=1000, person_present=True, posture="standing", confidence=0.95))
        engine.observe_pose(
            PoseObservation(timestamp_ms=1100, person_present=True, posture="lying_or_fallen", confidence=0.95)
        )
        second_fire = engine.observe_pose(
            PoseObservation(timestamp_ms=1300, person_present=True, posture="lying_or_fallen", confidence=0.95)
        )

        self.assertIsNone(second_fire)  # todavia dentro del cooldown de 120s


class PersonProneInactiveTest(unittest.TestCase):
    def test_sustained_immobility_fires_after_configured_window(self):
        engine = RiskFusionEngine(_config(prone_inactive_seconds=12.0))

        result = None
        for timestamp_ms in (0, 4000, 8000, 12500):
            result = engine.observe_pose(
                PoseObservation(timestamp_ms=timestamp_ms, person_present=True, posture="lying_or_fallen", confidence=0.9)
            )

        self.assertIsNotNone(result)
        self.assertEqual(result["anomalyType"], "PERSON_PRONE_INACTIVE")
        self.assertGreaterEqual(result["evidence"]["horizontalSeconds"], 12.0)


class UnexpectedPersonTest(unittest.TestCase):
    def test_person_in_armed_zone_fires(self):
        engine = RiskFusionEngine(_config(armed_zones=("entry",), armed=True))

        result = engine.observe_person(
            PersonObservation(timestamp_ms=0, person_present=True, zone="entry", confidence=0.9)
        )

        self.assertIsNotNone(result)
        self.assertEqual(result["anomalyType"], "UNEXPECTED_PERSON")
        self.assertEqual(result["evidence"]["zone"], "entry")

    def test_person_in_non_armed_zone_does_not_fire(self):
        engine = RiskFusionEngine(_config(armed_zones=("entry",), armed=True))

        result = engine.observe_person(
            PersonObservation(timestamp_ms=0, person_present=True, zone="kitchen", confidence=0.9)
        )

        self.assertIsNone(result)

    def test_disarmed_never_fires_even_in_armed_zone(self):
        engine = RiskFusionEngine(_config(armed_zones=("entry",), armed=False))

        result = engine.observe_person(
            PersonObservation(timestamp_ms=0, person_present=True, zone="entry", confidence=0.9)
        )

        self.assertIsNone(result)


class SmokeFireDisabledByDefaultTest(unittest.TestCase):
    def test_disabled_module_never_fires_regardless_of_detections(self):
        engine = RiskFusionEngine(_config(smoke_fire_enabled=False))

        result = None
        for timestamp_ms in (0, 200, 400):
            result = engine.observe_smoke_fire(
                SmokeFireObservation(timestamp_ms=timestamp_ms, detected=True, confidence=0.99)
            )

        self.assertIsNone(result)


class CameraTamperedTest(unittest.TestCase):
    def test_sustained_camera_loss_fires_as_technical_fault(self):
        engine = RiskFusionEngine(_config(camera_tamper_window_seconds=5.0))

        first = engine.observe_camera_health(
            CameraHealthObservation(timestamp_ms=0, frame_received=False, occluded=False, extreme_change=False)
        )
        self.assertIsNone(first)

        result = engine.observe_camera_health(
            CameraHealthObservation(timestamp_ms=6000, frame_received=False, occluded=False, extreme_change=False)
        )

        self.assertIsNotNone(result)
        self.assertEqual(result["anomalyType"], "CAMERA_TAMPERED")
        self.assertEqual(result["confidence"], 1.0)


class OutOfOrderTimestampsTest(unittest.TestCase):
    def test_out_of_order_pose_observation_is_discarded_and_does_not_corrupt_state(self):
        engine = RiskFusionEngine(_config())

        engine.observe_pose(PoseObservation(timestamp_ms=1000, person_present=True, posture="standing", confidence=0.95))

        # Un timestamp anterior al ultimo visto se descarta sin efecto.
        stale_result = engine.observe_pose(
            PoseObservation(timestamp_ms=500, person_present=True, posture="lying_or_fallen", confidence=0.95)
        )
        self.assertIsNone(stale_result)

        # El estado sigue intacto: hace falta una rafaga completa nueva.
        first_valid = engine.observe_pose(
            PoseObservation(timestamp_ms=1100, person_present=True, posture="lying_or_fallen", confidence=0.95)
        )
        self.assertIsNone(first_valid)

        second_valid = engine.observe_pose(
            PoseObservation(timestamp_ms=1300, person_present=True, posture="lying_or_fallen", confidence=0.95)
        )
        self.assertIsNotNone(second_valid)
        self.assertEqual(second_valid["anomalyType"], "POSSIBLE_FALL")


if __name__ == "__main__":
    unittest.main()
