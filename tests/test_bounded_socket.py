import pathlib
import socket
import sys
import threading
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'server'))
from bounded_socket import BoundedSocket


class SocketGuardTests(unittest.TestCase):
    def connect(self, callback):
        server = socket.socket()
        server.bind(('127.0.0.1', 0))
        server.listen(1)
        def serve():
            with server:
                connection, _ = server.accept()
                with connection:
                    callback(connection)
        thread = threading.Thread(target=serve, daemon=True)
        thread.start()
        client = BoundedSocket()
        client.settimeout(1)
        client.connect(server.getsockname())
        self.addCleanup(client.close)
        return client, thread

    def test_eof_is_an_error_instead_of_an_infinite_empty_read(self):
        client, thread = self.connect(lambda c: c.sendall(b'ok'))
        self.assertEqual(client.recv(20), b'ok')
        with self.assertRaisesRegex(ConnectionResetError, 'peer closed'):
            client.recv(20)
        thread.join(1)
        self.assertFalse(thread.is_alive())

    def test_silent_peer_respects_socket_timeout(self):
        done = threading.Event()
        self.addCleanup(done.set)
        client, _ = self.connect(lambda c: done.wait(1))
        client.settimeout(0.05)
        with self.assertRaises(TimeoutError):
            client.recv(20)


if __name__ == '__main__':
    unittest.main()
