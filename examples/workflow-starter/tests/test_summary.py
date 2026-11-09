import math
from pathlib import Path
import tempfile
import unittest

from audit_csv import summarize


class SummaryChecks(unittest.TestCase):
    def test_known_teaching_data(self):
        report = summarize(Path(__file__).resolve().parents[1] / 'data/demo.csv')
        self.assertEqual(report['records'], 8)
        self.assertEqual(report['groups']['A']['missing'], 1)
        self.assertEqual(report['groups']['A']['mean'], 2.5)
        self.assertEqual(report['groups']['A']['sample_sd'], 1)
        self.assertEqual(report['groups']['B']['mean'], 6.5)
        self.assertAlmostEqual(report['groups']['B']['sample_sd'], math.sqrt(5 / 3))

    def test_duplicate_identifiers_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'duplicate.csv'
            source.write_text('sample_id,group,value\nX,A,1\nX,B,2\n', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'duplicate'):
                summarize(source)

    def test_zero_is_observed_and_nan_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'values.csv'
            source.write_text('sample_id,group,value\nX,A,0\n', encoding='utf-8')
            self.assertEqual(summarize(source)['groups']['A']['observed'], 1)
            source.write_text('sample_id,group,value\nX,A,NaN\n', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'Non-finite'):
                summarize(source)
