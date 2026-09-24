import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from SenseCare_edge.frame_source import Frame, FixtureFrameSource, load_fixture_frames_from_dir

_JPEG_SOI = b"\xff\xd8\xff\xdbfake-jpeg-body"


class FixtureFrameSourceTest(unittest.TestCase):
    def test_reads_frames_in_order_then_none(self):
        frames = [
            Frame(jpeg_bytes=_JPEG_SOI, timestamp_ms=0, width=640, height=480),
            Frame(jpeg_bytes=_JPEG_SOI, timestamp_ms=500, width=640, height=480),
        ]
        source = FixtureFrameSource(frames)

        first = source.read()
        second = source.read()
        third = source.read()

        self.assertEqual(first.timestamp_ms, 0)
        self.assertEqual(second.timestamp_ms, 500)
        self.assertIsNone(third)

    def test_healthy_until_disconnect_simulated(self):
        source = FixtureFrameSource([Frame(jpeg_bytes=_JPEG_SOI, timestamp_ms=0, width=1, height=1)])
        self.assertTrue(source.healthy)

        source.simulate_disconnect()

        self.assertFalse(source.healthy)

    def test_closed_source_stops_yielding_frames(self):
        source = FixtureFrameSource([Frame(jpeg_bytes=_JPEG_SOI, timestamp_ms=0, width=1, height=1)])
        source.close()

        self.assertIsNone(source.read())
        self.assertFalse(source.healthy)


class LoadFixtureFramesFromDirTest(unittest.TestCase):
    def test_loads_jpgs_sorted_with_monotonic_timestamps(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "b.jpg").write_bytes(_JPEG_SOI + b"-b")
            (directory / "a.jpg").write_bytes(_JPEG_SOI + b"-a")
            (directory / "ignore.txt").write_bytes(b"not a jpeg")

            frames = load_fixture_frames_from_dir(directory, fps=2.0)

            self.assertEqual(len(frames), 2)
            self.assertTrue(frames[0].jpeg_bytes.endswith(b"-a"))
            self.assertTrue(frames[1].jpeg_bytes.endswith(b"-b"))
            self.assertEqual(frames[0].timestamp_ms, 0)
            self.assertEqual(frames[1].timestamp_ms, 500)  # 1000ms / 2fps


if __name__ == "__main__":
    unittest.main()
