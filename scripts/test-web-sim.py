"""Check the discovery protocol used by the production UI without opening ports."""

import contextlib
import importlib.util
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


simulator_path = Path(__file__).resolve().parents[1] / 'fluidnc-web-sim.py'
spec = importlib.util.spec_from_file_location('fluidnc_web_sim', simulator_path)
simulator = importlib.util.module_from_spec(spec)
with patch.object(sys, 'argv', [str(simulator_path)]), \
        patch('flask.Flask.run'), patch('threading.Thread.start'), \
        contextlib.redirect_stdout(io.StringIO()):
    spec.loader.exec_module(simulator)


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.client = simulator.app.test_client()

    def test_json_discovery_advertises_the_simulator_websocket(self):
        for endpoint in ('/command', '/command_silent'):
            with self.subTest(endpoint=endpoint):
                response = self.client.get(endpoint, query_string={
                    'plain': '[ESP800]json=yes', 'PAGEID': '0',
                })
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.is_json, response.get_data(as_text=True))
                data = response.get_json()['data']
                self.assertEqual(data['WebCommunication'], 'Synchronous')
                self.assertEqual(int(data['WebSocketPort']), simulator.ws_port)
                self.assertEqual(data['WebSocketIP'], 'localhost')
                self.assertEqual(data['Axisletters'], 'XYZ')

    def test_proxy_discovery_keeps_the_browser_on_the_local_bridge(self):
        with patch.object(simulator, 'proxy', True), \
                patch.object(simulator, 'do_proxy') as forward:
            response = self.client.get('/command', query_string={
                'plain': '[ESP800]json=yes',
            })
            self.assertTrue(response.is_json, response.get_data(as_text=True))
            self.assertEqual(int(response.get_json()['data']['WebSocketPort']), simulator.ws_port)
            forward.assert_not_called()

    def test_legacy_discovery_still_reports_the_same_endpoint(self):
        response = self.client.get('/command', query_string={'plain': '[ESP800]'})
        self.assertIn(
            f'#webcommunication:Sync:{simulator.ws_port}:localhost',
            response.get_data(as_text=True),
        )


if __name__ == '__main__':
    unittest.main()
