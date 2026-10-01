"""Deploy the jevworks pilot as a Hopsworks App, flying the live game with a semif deployment.

Idempotent: the app is stopped, deleted and recreated from the local sources. Settings travel as
a generated config.json next to runner.js. The pilot token is read at start from the Hopsworks
secret --token-secret of the deploying user; the game holds its sha256 (PILOT_TOKEN_SHA256).
After creation the job config is switched to root proxy routing (the SDK leaves the legacy prefix
mode), given the GPU and shared memory Chromium renders with, and its schedulingConfig dropped
(the PUT refuses it for apps).

Reads HOPSWORKS_HOST, HOPSWORKS_API_KEY and HOPSWORKS_PROJECT (hopsworks.login defaults):

    python pilot/deploy.py [--deployment semif4b] [--gpu | --no-gpu]
"""

import argparse
import json
import pathlib
import tempfile
import time

import hopsworks
from hopsworks_common import client

HERE = pathlib.Path(__file__).resolve().parent
SOURCES = ["runner.js", "start.sh", "package.json", "package-lock.json"]
GATEWAY = "http://istio-ingressgateway.hopsworks.svc.cluster.local"
# Measured in a pod: a GPU renders the game at 1080p and 60 fps; SwiftShader on 4 cores manages
# 640x360 at about 30 fps, the floor below which the game slows down.
RESOURCES = {
    True: {"cores": 2.0, "memory": 4096, "gpus": 1, "viewport": "1920x1080"},
    False: {"cores": 4.0, "memory": 4096, "gpus": 0, "viewport": "640x360"},
}


def wait(what, done, timeout_s=600, every_s=5):
    for _ in range(timeout_s // every_s):
        if done():
            return
        time.sleep(every_s)
    raise TimeoutError(f"{what} after {timeout_s}s")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--deployment", default="semif4b", help="semif deployment the pilot decides with")
    parser.add_argument("--name", default="jevworks_pilot", help="App name (letters, digits, underscore)")
    parser.add_argument("--game-url", default="https://game.hopsworks.ai/", help="the game the pilot flies")
    parser.add_argument("--token-secret", default="jevworks_pilot_token", help="Hopsworks secret holding the pilot token")
    parser.add_argument("--gpu", action=argparse.BooleanOptionalAction, default=True, help="render on a GPU")
    args = parser.parse_args()
    res = RESOURCES[args.gpu]

    project = hopsworks.login()
    if project.get_model_serving().get_deployment(args.deployment) is None:
        raise SystemExit(f"no deployment {args.deployment} in {project.name}")
    hopsworks.get_secrets_api().get_secret(args.token_secret)  # fails here, not in the pod, when missing
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
        "semifUrl": f"{GATEWAY}/v1/{project.name}/{args.deployment}/v1/models/{args.deployment}:predict",
        "tokenSecret": args.token_secret,
        "viewport": res["viewport"],
        "gpu": args.gpu,
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
        # Graphics on top of compute: the NVIDIA runtime then mounts the EGL and Vulkan drivers.
        env_vars={"NVIDIA_DRIVER_CAPABILITIES": "all"} if args.gpu else None,
        description=f"jevworks pilot: flies {args.game_url} for ever with {args.deployment}.",
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
