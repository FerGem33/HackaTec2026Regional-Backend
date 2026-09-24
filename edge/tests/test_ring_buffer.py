import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from SenseCare_edge.frame_source import Frame
from SenseCare_edge.ring_buffer import FrameRingBuffer

_JPEG = b"\xff\xd8fake"


def _frame(timestamp_ms: int) -> Frame:
    return Frame(jpeg_bytes=_JPEG, timestamp_ms=timestamp_ms, width=1, height=1)


class FrameRingBufferTest(unittest.TestCase):
    def test_evicts_frames_older_than_window(self):
        buffer = FrameRingBuffer(window_seconds=1.0)
        buffer.add(_frame(0))
        buffer.add(_frame(500))
        buffer.add(_frame(1200))  # cutoff = 1200 - 1000 = 200 -> drops frame at 0

        self.assertEqual(len(buffer), 2)
        self.assertEqual(buffer.latest().timestamp_ms, 1200)

    def test_latest_returns_none_when_empty(self):
        buffer = FrameRingBuffer()
        self.assertIsNone(buffer.latest())

    def test_pin_and_take_consumes_once(self):
        buffer = FrameRingBuffer()
        buffer.add(_frame(0))

        pinned = buffer.pin_best_frame_for("event-1", now_ms=0)
        self.assertTrue(pinned)
        self.assertTrue(buffer.has_pinned("event-1"))

        taken = buffer.take_pinned("event-1")
        self.assertIsNotNone(taken)
        self.assertEqual(taken.timestamp_ms, 0)

        # Segunda toma: ya se consumio, no se reutiliza ni se recaptura.
        self.assertIsNone(buffer.take_pinned("event-1"))
        self.assertFalse(buffer.has_pinned("event-1"))

    def test_pin_fails_when_no_frame_available(self):
        buffer = FrameRingBuffer()
        pinned = buffer.pin_best_frame_for("event-1", now_ms=0)
        self.assertFalse(pinned)
        self.assertFalse(buffer.has_pinned("event-1"))

    def test_pin_survives_past_sliding_window(self):
        buffer = FrameRingBuffer(window_seconds=1.0)
        buffer.add(_frame(0))
        buffer.pin_best_frame_for("event-1", now_ms=0)

        buffer.add(_frame(5000))  # el frame normal a t=0 sale de la ventana

        self.assertEqual(len(buffer), 1)
        self.assertTrue(buffer.has_pinned("event-1"))
        taken = buffer.take_pinned("event-1")
        self.assertEqual(taken.timestamp_ms, 0)

    def test_discard_pinned(self):
        buffer = FrameRingBuffer()
        buffer.add(_frame(0))
        buffer.pin_best_frame_for("event-1", now_ms=0)

        buffer.discard_pinned("event-1")

        self.assertFalse(buffer.has_pinned("event-1"))

    def test_evict_stale_pinned_removes_unclaimed_old_pins(self):
        buffer = FrameRingBuffer()
        buffer.add(_frame(0))
        buffer.pin_best_frame_for("event-1", now_ms=0)

        buffer.evict_stale_pinned(now_ms=100_000, max_age_ms=90_000)

        self.assertFalse(buffer.has_pinned("event-1"))

    def test_evict_stale_pinned_keeps_recent_pins(self):
        buffer = FrameRingBuffer()
        buffer.add(_frame(0))
        buffer.pin_best_frame_for("event-1", now_ms=0)

        buffer.evict_stale_pinned(now_ms=1_000, max_age_ms=90_000)

        self.assertTrue(buffer.has_pinned("event-1"))


if __name__ == "__main__":
    unittest.main()
