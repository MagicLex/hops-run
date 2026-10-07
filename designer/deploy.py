"""Deploy the designer as a Hopsworks App: a new edition of Hops Run every day.

Idempotent: the app is stopped, deleted and recreated from the local sources, uploaded in the
repo's layout (designer/, arena/, game/public/sim.js, pilot/deciders.js, bots/). Settings travel as
a generated config.json next to designer.js. The pilot token is read at start from the Hopsworks
secret --token-secret of the deploying user. It runs on CPU: no GPU, so it never shares one with
the pilots' stream.

Reads HOPSWORKS_HOST, HOPSWORKS_API_KEY and HOPSWORKS_PROJECT (hopsworks.login defaults):

    python designer/deploy.py [--semif semif4b] [--candidates 8] [--seeds 10] [--band 600-4000]
"""

import argparse
import importlib.util
import json
import pathlib
import tempfile

import hopsworks
from hopsworks_common import client

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent
# The pilots' deploy script: how to wait on an app, and where a deployment answers in the cluster.
_spec = importlib.util.spec_from_file_location("pilot_deploy", REPO / "pilot" / "deploy.py")
pilot = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pilot)

SOURCES = ["designer/designer.js", "designer/start.sh", "designer/package.json", "designer/package-lock.json",
           "arena/lib.js", "game/public/sim.js", "pilot/deciders.js"]


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--semif", default="semif4b", help="semif deployment that picks the edition, [PROJECT/]NAME")
    parser.add_argument("--name", default="hops_run_designer", help="App name (letters, digits, underscore)")
    parser.add_argument("--game-url", default="https://game.hopsworks.ai/", help="the game editions are published to")
    parser.add_argument("--token-secret", default="jevworks_pilot_token", help="Hopsworks secret holding the pilot token")
    parser.add_argument("--candidates", type=int, default=8, help="candidate editions drawn a day")
    parser.add_argument("--seeds", type=int, default=10, help="seeds each bot flies a candidate on")
    parser.add_argument("--band", default="600-4000", help="the bots' median a candidate must fall in, metres, min-max")
    args = parser.parse_args()

    project = hopsworks.login()
    semif_url = pilot.predict_url(project, args.semif)
    hopsworks.get_secrets_api().get_secret(args.token_secret)  # fails here, not in the pod, when missing
    apps, ds = project.get_app_api(), project.get_dataset_api()

    existing = apps.get_app(args.name)
    if existing is not None:
        existing.stop()
        pilot.wait(f"{args.name} stop", lambda: not apps.get_app(args.name).serving)
        existing.delete()
        print(f"deleted {args.name}", flush=True)

    target = f"Resources/{args.name}"
    bots = sorted(str(p.relative_to(REPO)) for p in (REPO / "bots").glob("*/pilot.js"))
    for source in SOURCES + bots:
        folder = f"{target}/{pathlib.PurePosixPath(source).parent}"
        if not ds.exists(folder):
            ds.mkdir(folder)
        ds.upload(str(REPO / source), folder, overwrite=True)
    config = {"gameUrl": args.game_url, "semifUrl": semif_url, "tokenSecret": args.token_secret,
              "candidates": args.candidates, "seeds": args.seeds, "band": args.band}
    with tempfile.TemporaryDirectory() as tmp:
        path = pathlib.Path(tmp) / "config.json"
        path.write_text(json.dumps(config, indent=2) + "\n")
        ds.upload(str(path), f"{target}/designer", overwrite=True)

    app = apps.create_app(
        args.name,
        app_path=f"{target}/designer/designer.js",
        app_kind="CUSTOM",
        entrypoint_command="bash start.sh",
        app_port=8080,
        memory=2048,
        cores=2.0,
        description=f"A new edition of {args.game_url} every day, picked by {args.semif} among candidates the bots fly.",
        readiness_probe_path="/health",
    )
    jobs = ["project", project.id, "jobs", args.name]
    job_config = client._get_instance()._send_request("GET", jobs)["config"]
    job_config["proxyPathMode"] = "ROOT"
    job_config["resourceConfig"].update(gpus=0)
    job_config.pop("schedulingConfig", None)
    client._get_instance()._send_request("PUT", jobs, headers={"content-type": "application/json"}, data=json.dumps(job_config))
    app.run(await_serving=True)
    print(f"{args.name} serving at {apps.get_app(args.name).app_url}", flush=True)


if __name__ == "__main__":
    main()
