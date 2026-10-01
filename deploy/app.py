"""Deploy Hops Run as a Hopsworks App, piloted by a semif deployment of the same project.

Idempotent: the app is stopped, deleted and recreated from the local sources. Settings travel as
a generated config.json next to server.js, because per-app env vars never reach the pod. The SDK
leaves proxy routing on the legacy prefix mode, so the job config is switched to root routing
after creation (and its schedulingConfig dropped, which the PUT refuses for apps).

Reads HOPSWORKS_HOST, HOPSWORKS_API_KEY and HOPSWORKS_PROJECT (hopsworks.login defaults):

    python deploy/app.py [--deployment semif8b] [--name hops_run]
"""

import argparse
import json
import pathlib
import tempfile
import time

import hopsworks
from hopsworks_common import client

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCES = ["server.js", "package.json", "package-lock.json", "start.sh"]
PUBLIC = ["game.js", "hw.svg", "fonts/Geist.ttf", "fonts/GeistMono.ttf", "fonts/OFL-Geist.txt"]
GATEWAY = "http://istio-ingressgateway.hopsworks.svc.cluster.local"


def wait(what, done, timeout_s=600, every_s=5):
    for _ in range(timeout_s // every_s):
        if done():
            return
        time.sleep(every_s)
    raise TimeoutError(f"{what} after {timeout_s}s")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--deployment", default="semif8b", help="semif deployment Jev flies with")
    parser.add_argument("--name", default="hops_run", help="App name (letters, digits, underscore)")
    args = parser.parse_args()

    project = hopsworks.login()
    if project.get_model_serving().get_deployment(args.deployment) is None:
        raise SystemExit(f"no deployment {args.deployment} in {project.name}")
    apps, ds = project.get_app_api(), project.get_dataset_api()

    existing = apps.get_app(args.name)
    if existing is not None:
        existing.stop()
        wait(f"{args.name} stop", lambda: not apps.get_app(args.name).serving)
        existing.delete()
        print(f"deleted {args.name}", flush=True)

    target = f"Resources/{args.name}"
    for path in (target, f"{target}/public", f"{target}/public/fonts"):
        if not ds.exists(path):
            ds.mkdir(path)
    for name in SOURCES:
        ds.upload(str(ROOT / name), target, overwrite=True)
    for name in PUBLIC:
        parent = pathlib.PurePosixPath(name).parent
        ds.upload(str(ROOT / "public" / name), f"{target}/public" + ("" if str(parent) == "." else f"/{parent}"), overwrite=True)
    config = {"semifUrl": f"{GATEWAY}/v1/{project.name}/{args.deployment}/v1/models/{args.deployment}:predict"}
    with tempfile.TemporaryDirectory() as tmp:
        path = pathlib.Path(tmp) / "config.json"
        path.write_text(json.dumps(config, indent=2) + "\n")
        ds.upload(str(path), target, overwrite=True)

    app = apps.create_app(
        args.name,
        app_path=f"{target}/server.js",
        app_kind="CUSTOM",
        entrypoint_command="bash start.sh",
        app_port=8080,
        memory=1024,
        cores=0.5,
        description=f"Hops Run, piloted by you or Jev ({args.deployment}).",
        readiness_probe_path="/health",
    )
    jobs = ["project", project.id, "jobs", args.name]
    job_config = client._get_instance()._send_request("GET", jobs)["config"]
    job_config["proxyPathMode"] = "ROOT"
    job_config.pop("schedulingConfig", None)
    client._get_instance()._send_request("PUT", jobs, headers={"content-type": "application/json"}, data=json.dumps(job_config))
    app.run(await_serving=True)
    print(f"{args.name} serving at {apps.get_app(args.name).app_url}", flush=True)


if __name__ == "__main__":
    main()
