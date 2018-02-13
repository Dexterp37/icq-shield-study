from SimpleHTTPServer import SimpleHTTPRequestHandler
from time import sleep

import argparse
import BaseHTTPServer


def get_request_handler(latency):
    class DelayedRequestHandler(SimpleHTTPRequestHandler,  object):
        def __init__(self, *args, **kwargs):
            self._latency = latency * 0.001
            self.protocol_version = "HTTP/1.0"
            super(DelayedRequestHandler, self).__init__(*args, **kwargs)

        def end_headers(self):
            sleep(self._latency)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Timing-Allow-Origin', '*')
            SimpleHTTPRequestHandler.end_headers(self)

        def do_GET(self):
            sleep(self._latency)
            return SimpleHTTPRequestHandler.do_GET(self)

    return DelayedRequestHandler


if __name__ == '__main__':
    parser = argparse.ArgumentParser("Delayed CORS Server")
    parser.add_argument("--latency", type=int, default=200,
                        help="The latency (ms) with which the server must serve requests")  # noqa: E501
    parser.add_argument("--port", type=int, default=3785,
                        help="The port to serve the HTTP request from")

    args = parser.parse_args()
    request_handler = get_request_handler(args.latency)

    # The code below comes from BaseHTTPServer.py.
    server_address = ('', args.port)
    httpd = BaseHTTPServer.HTTPServer(server_address, request_handler)

    sa = httpd.socket.getsockname()
    print("Serving HTTP on {} port {} ...\n".format(sa[0], sa[1]))
    httpd.serve_forever()
