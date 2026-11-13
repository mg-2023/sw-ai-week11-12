import argparse

from .server import MiniRedisServer


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Mini Redis HTTP server.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    with MiniRedisServer((args.host, args.port)) as server:
        print(f"Mini Redis listening at http://{args.host}:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
