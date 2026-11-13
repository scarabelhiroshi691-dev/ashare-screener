"""Socket guard for the isolated BaoStock worker, without editing its package."""
import socket


class BoundedSocket(socket.socket):
    def recv(self, *args, **kwargs):
        chunk = super().recv(*args, **kwargs)
        if not chunk:
            # BaoStock's receive loop otherwise spins forever after peer EOF.
            raise ConnectionResetError('BaoStock peer closed before a complete response')
        return chunk


def install():
    # Leave time for a useful error before the 15s JS deadline.
    socket.setdefaulttimeout(8)
    socket.socket = BoundedSocket
