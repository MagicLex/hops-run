"""Deploy the model pilots as a Hopsworks App, flying the live game in turns, one run each.

Idempotent: the app is stopped, deleted and recreated from the local sources. Settings travel as
a generated config.json next to runner.js. The pilot token is read at start from the Hopsworks
secret --token-secret of the deploying user; the game holds its sha256 (PILOT_TOKEN_SHA256).
Each Hopsworks decider is a deployment given as [PROJECT/]NAME (default project: this one); jev
reads its TypeSafe key from the secret --typesafe-secret.
After creation the job config is switched to root proxy routing (the SDK leaves the legacy prefix
mode), given the GPU and shared memory Chromium renders with, and its schedulingConfig dropped
(the PUT refuses it for apps).

Reads HOPSWORKS_HOST, HOPSWORKS_API_KEY and HOPSWORKS_PROJECT (hopsworks.login defaults):

    python pilot/deploy.py [--deciders semif,kumo] [--gpu | --no-gpu] [--stream-secret NAME | --no-stream]

With a stream secret (default jevworks_youtube_key) the App also streams the page live to
--stream-url, encoded on the GPU; streaming needs --gpu.
"""

import argparse
import json
import pathlib
import re
import tempfile
import time
import urllib.request

import hopsworks
from hopsworks_common import client
from hopsworks_common.client.exceptions import RestAPIError
from hopsworks_common.core.project_api import ProjectApi
from hsml.deployment import Deployment

HERE = pathlib.Path(__file__).resolve().parent
SOURCES = ["runner.js", "deciders.js", "start.sh", "package.json", "package-lock.json"]
GATEWAY = "http://istio-ingressgateway.hopsworks.svc.cluster.local"
# Measured in a pod: a GPU renders the game at 1080p and 60 fps, and Chromium, the runner and the
# stream's ffmpeg then use about 2 cores; SwiftShader on 4 cores manages 640x360 at about 30 fps,
# the floor below which the game slows down.
RESOURCES = {
    True: {"cores": 4.0, "memory": 4096, "gpus": 1, "viewport": "1920x1080"},
    False: {"cores": 4.0, "memory": 4096, "gpus": 0, "viewport": "640x360"},
}


def wait(what, done, timeout_s=600, every_s=5):
    for _ in range(timeout_s // every_s):
        if done():
            return
        time.sleep(every_s)
    raise TimeoutError(f"{what} after {timeout_s}s")


def predict_url(project, spec):
    """In-cluster predict URL of the deployment [PROJECT/]NAME; fails here when it does not exist."""
    owner, _, name = spec.rpartition("/")
    pid = ProjectApi()._get_project(owner).id if owner else project.id
    try:
        found = Deployment.from_response_json(client._get_instance()._send_request("GET", ["project", pid, "serving"], query_params={"name": name}))
    except RestAPIError as e:
        raise SystemExit(f"no deployment {spec}: {e}") from e
    return f"{GATEWAY}/v1/{found.project_namespace}/{name}/v1/models/{name}:predict"


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--deciders", default="semif,kumo", help="the rotation, comma-separated: semif, kumo, clef, jev")
    parser.add_argument("--semif", default="semif4b", help="semif deployment, [PROJECT/]NAME")
    parser.add_argument("--kumo", default="kumo", help="Kumo Tabular deployment, [PROJECT/]NAME")
    parser.add_argument("--clef", default="Kumo_Tabular/clef", help="Clef-Flash deployment, [PROJECT/]NAME")
    parser.add_argument("--jev-url", default="https://api.typesafe.ai/v1/systemone", help="TypeSafe System One endpoint")
    parser.add_argument("--jev-model", default="jev-latest", help="TypeSafe model")
    parser.add_argument("--typesafe-secret", default="typesafe_api_key", help="Hopsworks secret holding the TypeSafe API key")
    parser.add_argument("--name", default="jevworks_pilot", help="App name (letters, digits, underscore)")
    parser.add_argument("--game-url", default="https://game.hopsworks.ai/", help="the game the pilot flies")
    parser.add_argument("--token-secret", default="jevworks_pilot_token", help="Hopsworks secret holding the pilot token")
    parser.add_argument("--gpu", action=argparse.BooleanOptionalAction, default=True, help="render on a GPU")
    parser.add_argument("--stream-secret", default="jevworks_youtube_key", help="Hopsworks secret holding the stream key")
    parser.add_argument("--stream-url", default="rtmps://a.rtmp.youtube.com/live2", help="RTMP(S) ingest URL")
    parser.add_argument("--stream-channel", help="YouTube channel the key streams to, watched to reconnect a stuck ingest (default: the one the game previews)")
    parser.add_argument("--no-stream", action="store_true", help="do not stream the page")
    args = parser.parse_args()
    stream = not args.no_stream
    if stream and not args.gpu:
        raise SystemExit("streaming encodes on the GPU: use --gpu or --no-stream")
    res = RESOURCES[args.gpu]
    channel = args.stream_channel
    if stream and not channel:
        with urllib.request.urlopen(args.game_url, timeout=15) as page:
            found = re.search(r'data-channel="([\w-]+)"', page.read().decode())
        if not found:
            raise SystemExit(f"{args.game_url} previews no YouTube channel: pass --stream-channel")
        channel = found.group(1)

    deciders = args.deciders.split(",")
    if not set(deciders) <= {"semif", "kumo", "clef", "jev"}:
        raise SystemExit(f"--deciders: comma-separated, of semif, kumo, clef, jev (got {args.deciders})")

    project = hopsworks.login()
    urls = {f"{d}Url": predict_url(project, getattr(args, d)) for d in deciders if d != "jev"}
    jev = "jev" in deciders
    for secret in [args.token_secret] + ([args.stream_secret] if stream else []) + ([args.typesafe_secret] if jev else []):
        hopsworks.get_secrets_api().get_secret(secret)  # fails here, not in the pod, when missing
    apps, ds = project.get_app_api(), project.get_dataset_api()

    existing = apps.get_app(args.name)
    if existing is not None:
        existing.stop()
        wait(f"{args.name} stop", lambda: not apps.get_app(args.name).serving)
        existing.delete()
        print(f"deleted {args.name}", flush=True)

    target = f"Resources/{args.name}"
    if not ds.exists(target):
        ds.mkdir(target)
    for name in SOURCES:
        ds.upload(str(HERE / name), target, overwrite=True)
    config = {
        "gameUrl": args.game_url,
        "decider": args.deciders,
        **urls,
        "jevUrl": args.jev_url if jev else None,
        "jevModel": args.jev_model if jev else None,
        "typesafeSecret": args.typesafe_secret if jev else None,
        "tokenSecret": args.token_secret,
        "viewport": res["viewport"],
        "gpu": args.gpu,
        "streamSecret": args.stream_secret if stream else None,
        "streamUrl": args.stream_url if stream else None,
        "streamChannel": channel if stream else None,
    }
    with tempfile.TemporaryDirectory() as tmp:
        path = pathlib.Path(tmp) / "config.json"
        path.write_text(json.dumps(config, indent=2) + "\n")
        ds.upload(str(path), target, overwrite=True)

    app = apps.create_app(
        args.name,
        app_path=f"{target}/runner.js",
        app_kind="CUSTOM",
        entrypoint_command="bash start.sh",
        app_port=8080,
        memory=res["memory"],
        cores=res["cores"],
        description=f"Model pilots {args.deciders}: fly {args.game_url} for ever, one run each in turn.",
        readiness_probe_path="/health",
    )
    jobs = ["project", project.id, "jobs", args.name]
    job_config = client._get_instance()._send_request("GET", jobs)["config"]
    job_config["proxyPathMode"] = "ROOT"
    job_config["resourceConfig"].update(gpus=res["gpus"], shmSize=1024)
    job_config.pop("schedulingConfig", None)
    client._get_instance()._send_request("PUT", jobs, headers={"content-type": "application/json"}, data=json.dumps(job_config))
    app.run(await_serving=True)
    print(f"{args.name} serving at {apps.get_app(args.name).app_url}", flush=True)


if __name__ == "__main__":
    main()
