import os
import sys
import json
import sqlite3
import unittest
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from transfer import TakeoutMetadataParser, CheckpointDB

class TestPythonTransfer(unittest.TestCase):
    def setUp(self):
        self.test_dir = Path(__file__).parent / "py_temp_data"
        self.test_dir.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        if self.test_dir.exists():
            for f in self.test_dir.glob("*"):
                f.unlink()
            self.test_dir.rmdir()

    def test_json_matching_and_parsing(self):
        # 1. Standard
        img = self.test_dir / "IMG_1001.JPG"
        img.write_text("fake-bytes")
        img_json = self.test_dir / "IMG_1001.JPG.json"
        img_json.write_text(json.dumps({
            "photoTakenTime": {"timestamp": "1672531199"},
            "description": "Python Test Photo",
            "favorited": True
        }))

        meta = TakeoutMetadataParser.parse_metadata(img)
        self.assertEqual(meta["created_at"], "2022-12-31T23:59:59.000Z")
        self.assertEqual(meta["description"], "Python Test Photo")
        self.assertEqual(meta["is_favorite"], True)

        # 2. Parentheses
        copy_img = self.test_dir / "photo(1).png"
        copy_img.write_text("fake-bytes")
        copy_json = self.test_dir / "photo.png(1).json"
        copy_json.write_text(json.dumps({
            "photoTakenTime": {"timestamp": "1609459200"}
        }))

        meta_copy = TakeoutMetadataParser.parse_metadata(copy_img)
        self.assertEqual(meta_copy["created_at"], "2021-01-01T00:00:00.000Z")

    def test_checkpoint_db(self):
        db_path = str(self.test_dir / "test_check.db")
        db = CheckpointDB(db_path)

        file_key = "/test/img.jpg"
        self.assertFalse(db.is_uploaded(file_key))

        db.record_upload(file_key, 1024, "SUCCESS", "immich-123")
        self.assertTrue(db.is_uploaded(file_key))

        # Check persistence
        db2 = CheckpointDB(db_path)
        self.assertTrue(db2.is_uploaded(file_key))

if __name__ == "__main__":
    unittest.main()
