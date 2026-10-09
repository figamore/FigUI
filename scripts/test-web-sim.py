"""Check the discovery protocol used by the production UI without opening ports."""

import contextlib
import asyncio
import importlib.util
import io
from pathlib import Path
import sys
import tempfile
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


class SingleBlockTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.storage = tempfile.TemporaryDirectory()
        self.storage_patch = patch.object(simulator, 'test_files', self.storage.name)
        self.storage_patch.start()
        simulator.handle_realtime(0x18)
        simulator.machine.update(wpos=[0., 0., 0.], mpos=[0., 0., 0.])
        self.messages = []
        self.task = None

        class Socket:
            async def send(_, message):
                self.messages.append(message)
        self.socket = Socket()

    async def asyncTearDown(self):
        if self.task:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.task
        self.storage_patch.stop()
        self.storage.cleanup()

    async def wait_for(self, predicate):
        async def poll():
            while not predicate():
                await asyncio.sleep(0.01)
        await asyncio.wait_for(poll(), timeout=2)

    def write_program(self, fs, text):
        path = Path(simulator._fs_path(fs, 'test.nc'))
        path.write_text(text)

    async def test_steps_stop_before_motion_and_disabling_does_not_resume(self):
        self.write_program('sd', 'M3 S1000\nG1 X10 F200\nG1 X20\nM30\n')
        await simulator.handle_text_command('$GB=On', self.socket)
        self.task = asyncio.create_task(simulator._run_file('test.nc', self.socket))
        await self.wait_for(lambda: any('test.nc:1 ' in m for m in self.messages))
        self.assertIn('|Pn:Q>', simulator.status_report())
        self.assertIn('|SD:0,/sd/test.nc', simulator.status_report())
        self.assertEqual(simulator.machine['spindle'], 0, 'pending M3 must not execute')
        simulator.handle_realtime(0x7e)
        simulator.handle_realtime(0x7e)
        await self.wait_for(lambda: any('test.nc:2 ' in m for m in self.messages))
        self.assertEqual(simulator.machine['spindle'], 1000, 'spindle stays on at a step stop')
        self.assertEqual(simulator.machine['wpos'][0], 0, 'pending G1 must not execute')
        response = simulator.app.test_client().get('/command', query_string={
            'plain': '$GB=Off', 'PAGEID': '42',
        })
        self.assertEqual(response.status_code, 200)
        self.assertIn('Single Block Mode Disabled', response.get_data(as_text=True))
        repeated = simulator.app.test_client().get('/command', query_string={'plain': '$GB=Off'})
        self.assertEqual(repeated.get_data(as_text=True), 'ok\n')
        await asyncio.sleep(0.05)
        self.assertEqual(simulator.machine['state'], 'Hold:0')
        self.assertNotIn('Pn:', simulator.status_report())
        self.assertEqual(simulator.machine['wpos'][0], 0)
        simulator.handle_realtime(0x7e)
        await asyncio.wait_for(self.task, timeout=2)
        self.assertEqual(simulator.machine['wpos'][0], 20)
        self.assertEqual(simulator.machine['state'], 'Idle')

    async def test_reset_discards_a_pending_localfs_line_and_clears_mode(self):
        self.write_program('localfs', 'G1 X99\nM30\n')
        await simulator.handle_text_command('$GCode/BlockMode=On', self.socket)
        self.task = asyncio.create_task(simulator._run_file('test.nc', self.socket, 'localfs'))
        await self.wait_for(lambda: any('/localfs/test.nc:1 ' in m for m in self.messages))
        simulator.handle_realtime(0x18)
        await asyncio.wait_for(self.task, timeout=2)
        self.assertEqual(simulator.machine['wpos'][0], 0)
        self.assertFalse(simulator.machine['single_block'])
        self.assertIsNone(simulator.machine['sd_file'])

    async def test_streamed_commands_do_not_enter_single_block_hold(self):
        await simulator.handle_text_command('$GB=On', self.socket)
        await simulator.handle_text_command('S1000 M3', self.socket)
        self.assertEqual(simulator.machine['spindle'], 1000)
        self.assertEqual(simulator.machine['state'], 'Idle')
        self.assertFalse(any('Step ' in m for m in self.messages))


if __name__ == '__main__':
    unittest.main()
