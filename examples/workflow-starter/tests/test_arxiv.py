import unittest

from arxiv_once import parse_feed


class FeedChecks(unittest.TestCase):
    def test_legacy_identifier_keeps_archive_and_version(self):
        feed = '''<feed xmlns="http://www.w3.org/2005/Atom"
            xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
            <opensearch:totalResults>1</opensearch:totalResults>
            <entry><id>http://arxiv.org/abs/hep-th/9901001v2</id><title>Teaching fixture</title></entry>
            </feed>'''
        total, records = parse_feed(feed)
        self.assertEqual(total, 1)
        self.assertEqual(records[0]['id'], 'hep-th/9901001v2')

    def test_error_page_is_not_reported_as_zero_results(self):
        with self.assertRaisesRegex(ValueError, 'Atom feed'):
            parse_feed('<html><body>Service unavailable</body></html>')

    def test_atom_api_error_entry_is_rejected(self):
        feed = '''<feed xmlns="http://www.w3.org/2005/Atom"
            xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
            <opensearch:totalResults>1</opensearch:totalResults>
            <entry><id>http://arxiv.org/api/errors#badquery</id><title>Error</title></entry>
            </feed>'''
        with self.assertRaisesRegex(ValueError, 'API error'):
            parse_feed(feed)
